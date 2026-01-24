/**
 * ============================================================
 * LINE → Gemini (Security First) → Google Drive → Notion
 * ============================================================
 * * 【処理フロー】
 * 1. LINEから画像を取得
 * 2. Google Driveに保存 (非公開)
 * 3. Geminiで画像を解析 (タイトル・タグ生成)
 * 4. Notionに保存 (画像は埋め込まず、Driveへのリンクのみ記載)
 * * ============================================================
 */

const PROPS = PropertiesService.getScriptProperties();

const LINE_TOKEN      = PROPS.getProperty('LINE_TOKEN');
const NOTION_TOKEN    = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID    = PROPS.getProperty('NOTION_DB_ID');
const GEMINI_API_KEY  = PROPS.getProperty('GEMINI_API_KEY');
const DRIVE_FOLDER_ID = PROPS.getProperty('DRIVE_FOLDER_ID');

const TAGS  = ["研究", "筋トレ", "勉強", "趣味", "恋愛", "食事", "その他"];
const MOODS = ["🤩", "😊", "😐", "😰", "😡"];
// 最新モデル優先リスト
const MODEL_CANDIDATES = ["gemini-3-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

function doPost(e) {
  if (!e?.postData) return ContentService.createTextOutput("error");

  try {
    const events = JSON.parse(e.postData.contents).events || [];
    events.forEach(event => {
      if (event.type !== 'message') return;
      const msg = event.message;

      // A. テキスト
      if (msg.type === 'text') {
        processContent(msg.text, null, null);
      }
      // B. 画像
      else if (msg.type === 'image') {
        // 1. 画像をDriveに保存
        const imageInfo = saveImageToDrive(msg.id);
        const logText = `📷 写真をアップロードしました\n(${imageInfo.name})`;
        
        // 2. 解析 & Notion保存
        processContent(logText, imageInfo.url, imageInfo.blob);
      }
    });
  } catch (err) {
    saveToNotion({ title: "❌ システムエラー", mood: "😰", tags: ["その他"] }, err.toString(), null);
  }
  return ContentService.createTextOutput("ok");
}

// ============================================================
// メイン処理
// ============================================================

function processContent(text, imageUrl, imageBlob) {
  // 画像がある場合は、その内容を加味して解析
  const result = analyzeWithGemini(text, imageBlob);
  
  // Notionの本文には、URLをベタ書きせず、saveToNotionでリンク化する
  // エラー時などに備えてテキストはそのまま渡す
  
  if (result.success) {
    saveToNotion(result.data, text, imageUrl);
  } else {
    // 失敗時
    saveToNotion(
      { title: "📷 写真日記", mood: "😐", tags: ["その他"] },
      `⚠️ AI解析失敗\n\n【エラー】\n${result.error}\n\n【原文】\n${text}`,
      imageUrl
    );
  }
}

// ============================================================
// 画像保存 (Drive Only)
// ============================================================

function saveImageToDrive(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
  });
  const blob = response.getBlob(); 
  const date = new Date();
  const fileName = `Photo_${Utilities.formatDate(date, "JST", "yyyyMMdd_HHmmss")}.jpg`;
  
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const file = folder.createFile(blob.setName(fileName));
  
  // ★修正: アプリ起動を回避しやすい「ブラウザ表示用リンク(uc?export=view)」を生成
  // これならChromeで直接画像が表示される確率が高いです
  const viewerUrl = `https://drive.google.com/uc?export=view&id=${file.getId()}`;

  return { 
    name: fileName, 
    url: viewerUrl, // ★修正
    blob: blob 
  };
}

// ============================================================
// Notion API (リンク作成版)
// ============================================================

function saveToNotion(data, bodyText, imageUrl) {
  const url = 'https://api.notion.com/v1/pages';
  const safeBody = (bodyText || "").substring(0, 2000);

  // ブロック作成
  const childrenBlocks = [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: safeBody } }] }
    }
  ];

  // 画像がある場合、安全なリンクを追加
  if (imageUrl) {
    // テキストリンク (クリックしやすい)
    childrenBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: "🔗 " } },
          { 
            type: 'text', 
            text: { 
              content: "写真を開く (Google Drive)", 
              link: { url: imageUrl } // ハイパーリンク
            } 
          }
        ]
      }
    });
  }

  const payload = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      "Name": { title: [{ text: { content: data.title || "無題" } }] },
      "Mood": { select: { name: data.mood || "😐" } },
      "Tags": { multi_select: (data.tags || []).map(tag => ({ name: tag })) }
    },
    children: childrenBlocks
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload)
  });
}

// ============================================================
// Gemini API (最新モデル対応)
// ============================================================

function analyzeWithGemini(text, imageBlob) {
  let errorLog = "";
  for (const model of MODEL_CANDIDATES) {
    try {
      return { success: true, data: callGeminiAPI(text, imageBlob, model) };
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }
  return { success: false, error: errorLog };
}

function callGeminiAPI(text, imageBlob, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  
  const promptText = imageBlob 
    ? `添付画像を分析し、日記のタイトル(20文字以内)を付けてください。入力: ${text}`
    : `テキストを分析しJSONを返してください。入力: ${text}`;
    
  const promptPart = { 
    text: promptText + `\n\n出力JSON形式: { "title": "...", "mood": "${MOODS.join("/")}", "tags": ["${TAGS.join('","')}"] }` 
  };
  
  const parts = [promptPart];

  if (imageBlob) {
    parts.push({
      inline_data: {
        mime_type: imageBlob.getContentType(),
        data: Utilities.base64Encode(imageBlob.getBytes())
      }
    });
  }

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { response_mime_type: "application/json" } }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error(`API Error (${code}): ${body.substring(0, 200)}`);
  
  const match = JSON.parse(body).candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON not found");
  return JSON.parse(match[0]);
}