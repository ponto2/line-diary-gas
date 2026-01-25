/**
 * ============================================================
 * LINE → Gemini (Security First) → Google Drive → Notion
 * ============================================================
 * * 【処理フロー A: 日次記録 (LINE Webhook)】
 * 1. LINEから画像を取得
 * 2. Google Driveに保存 (非公開)
 * 3. Geminiで画像を解析 (タイトル・タグ生成)
 * 4. Notionに保存 (画像は埋め込まず、Driveへのリンクのみ記載)
 * * * 【処理フロー B: 週次レビュー (Time-driven Trigger)】
 * 1. GAS (sendWeeklyReview): 指定時刻にトリガー起動
 * 2. Notion API: 過去7日間のデータを取得
 * 3. Gemini: 過去ログをコンテキストとして分析（JSONではなくテキストで出力）
 * 4. LINE Messaging API: プッシュメッセージを送信
 * * ============================================================
 */

const PROPS = PropertiesService.getScriptProperties();

const LINE_TOKEN      = PROPS.getProperty('LINE_TOKEN');
const NOTION_TOKEN    = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID    = PROPS.getProperty('NOTION_DB_ID');
const GEMINI_API_KEY  = PROPS.getProperty('GEMINI_API_KEY');
const DRIVE_FOLDER_ID = PROPS.getProperty('DRIVE_FOLDER_ID');
const LINE_USER_ID    = PROPS.getProperty('LINE_USER_ID'); // ★追加: プッシュ通知用

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
// Gemini API (最新モデル対応 - JSON解析用)
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

// ============================================================
// ▼ 以下拡張機能: 週次レビューシステム
// ============================================================

/**
 * 1. 週次レビューのエントリーポイント (トリガー実行)
 */
function sendWeeklyReview() {
  if (!LINE_USER_ID) {
    console.log("LINE_USER_ID未設定のためレビューをスキップします");
    return;
  }

  // 1-1. Notionから過去7日間のログを取得
  const logs = fetchWeeklyLogsFromNotion();
  if (logs.length === 0) {
    pushLineMessage("今週は日記の記録がありませんでした。来週は記録してみましょう！📓");
    return;
  }

  // 1-2. AIへのコンテキスト作成
  const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";

  let reviewContext = `あなたはユーザーの成長を見守る「信頼できるメンター」です。
厳しさと優しさを兼ね備え、ユーザーが「また来週も頑張ろう」と思える週次レビューを作成してください。

【👤 ユーザー情報】
${userProfile}

【📝 出力ルール】
- 全体で400〜600文字程度（LINEで読みやすい長さ）
- Markdown記法（**太字**など）は使用禁止
- 見出しは【 】と絵文字で表現
- ポジティブ7割、改善提案3割のバランスで

【📊 レビュー構成】
1. 💪 今週のハイライト
   - 最も印象的だった出来事や成長を1〜2個ピックアップ
   - 「できた事実」を具体的に言語化して自己効力感を高める

2. 🔋 心身のバランスチェック
   - 気分の推移パターンを読み取る（上昇傾向？波がある？）
   - 活動量とリカバリーのバランスについて一言

3. 🎯 来週へのワンポイント
   - 今週の傾向から、来週試してほしい「小さな実験」を1つだけ提案
   - 抽象的なアドバイスではなく、すぐ実行できる具体的なアクションで

【日記ログ】
`;

  logs.forEach(log => {
    reviewContext += `[${log.date}] 気分:${log.mood} タイトル:${log.title}\n`;
  });

  // 1-3. Geminiでレビュー生成 (あなたの指定したモデルリストを使用)
  let reviewText = "";
  let errorLog = "";
  
  for (const model of MODEL_CANDIDATES) {
    try {
      reviewText = callGeminiForText(reviewContext, model);
      break; // 成功したらループを抜ける
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }

  if (reviewText) {
    pushLineMessage("📅 【週次レビュー】\n\n" + reviewText);
  } else {
    pushLineMessage("週次レビューの生成に失敗しました。\n" + errorLog);
  }
}

/**
 * 2. Notionからデータ取得
 */
function fetchWeeklyLogsFromNotion() {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const date = new Date();
  date.setDate(date.getDate() - 7);
  const isoDate = date.toISOString();

  const payload = {
    filter: {
      timestamp: "created_time",
      created_time: { on_or_after: isoDate }
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload)
  });

  const results = JSON.parse(response.getContentText()).results || [];
  return results.map(page => {
    const props = page.properties;
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明"
    };
  });
}

/**
 * 3. Gemini API (テキスト生成版)
 * ※既存のcallGeminiAPIはJSONを強制するため、レビュー用にテキスト版を用意
 */
function callGeminiForText(prompt, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error(`API Error (${code}): ${body.substring(0, 200)}`);
  
  const json = JSON.parse(body);
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "No content";
}

/**
 * 4. LINEプッシュ送信
 */
function pushLineMessage(text) {
  const url = "https://api.line.me/v2/bot/message/push";
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: text }]
    })
  });
}