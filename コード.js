/**
 * ==========================================================================================
 * LINE Diary Bot System Architecture v2.0
 * ==========================================================================================
 * * 【システム概要】
 * LINEを通じた日記の記録と、Geminiによる自動解析・週次レビューを行うシステム。
 * データはNotionを唯一のデータベース（正）として管理する。
 * * * 【処理フロー A: 日次記録 (LINE Webhook)】
 * 1. User -> LINE: テキストまたは画像を送信
 * 2. GAS (doPost): Webhookを受信
 * 3. [画像の場合]: 
 * - Google Driveへ保存 (非公開フォルダ)
 * - 閲覧用リンク(uc?export=view)を生成
 * 4. Gemini API: コンテンツを解析
 * - タイトル生成 (20文字以内)
 * - 感情分析 (MOODSから選択)
 * - タグ付け (TAGSから選択)
 * 5. Notion API: データベースへページを作成 (Create Page)
 * - 解析結果と本文を保存
 * - 画像がある場合はDriveへのリンクを埋め込む
 * * * 【処理フロー B: 週次レビュー (Time-driven Trigger)】
 * 1. GAS (sendWeeklyReview): 指定時刻に起動（トリガー設定が必要）
 * 2. Notion API: データベースをクエリ (Query Database)
 * - フィルタ: create_time が過去7日以内
 * 3. Data Process: 取得した日記データ(日付・本文・気分)をテキスト化
 * 4. Gemini API: 過去ログをコンテキストとして分析
 * - 傾向分析、褒め言葉、次週のアドバイスを生成
 * 5. LINE Messaging API: プッシュメッセージを送信
 * * ==========================================================================================
 */

const PROPS = PropertiesService.getScriptProperties();

// --- API Keys & IDs ---
const LINE_TOKEN      = PROPS.getProperty('LINE_TOKEN');
const NOTION_TOKEN    = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID    = PROPS.getProperty('NOTION_DB_ID');
const GEMINI_API_KEY  = PROPS.getProperty('GEMINI_API_KEY');
const DRIVE_FOLDER_ID = PROPS.getProperty('DRIVE_FOLDER_ID');
const LINE_USER_ID    = PROPS.getProperty('LINE_USER_ID'); // ★必須: プッシュ通知先

// --- Constants ---
const TAGS  = ["研究", "筋トレ", "勉強", "趣味", "恋愛", "食事", "その他"];
const MOODS = ["🤩", "😊", "😐", "😰", "😡"];
// Gemini Model: 日次はJSONモードが得意なFlash、レビューは推論が得意なPro/Flashを使用
const MODEL_DAILY  = "gemini-2.0-flash"; 
const MODEL_REVIEW = "gemini-2.0-flash"; 

// ============================================================
// 1. LINE Webhook Entry Point (日次処理)
// ============================================================

function doPost(e) {
  if (!e?.postData) return ContentService.createTextOutput("error");

  try {
    const events = JSON.parse(e.postData.contents).events || [];
    events.forEach(event => {
      if (event.type !== 'message') return;
      const msg = event.message;

      // ユーザーID確認用ログ（必要ならコメントアウトを外して確認してください）
      // console.log(`Incoming Message from UserID: ${event.source.userId}`);

      // A. テキストメッセージ
      if (msg.type === 'text') {
        processDailyLog(msg.text, null, null);
      }
      // B. 画像メッセージ
      else if (msg.type === 'image') {
        const imageInfo = saveImageToDrive(msg.id);
        const logText = `📷 写真をアップロードしました\n(${imageInfo.name})`;
        processDailyLog(logText, imageInfo.url, imageInfo.blob);
      }
    });
  } catch (err) {
    console.error("System Error:", err);
    // エラー時もNotionには残す
    saveToNotion({ title: "❌ システムエラー", mood: "😰", tags: ["その他"] }, err.toString(), null);
  }
  return ContentService.createTextOutput("ok");
}

// ============================================================
// 2. 日次ログ処理ロジック
// ============================================================

function processDailyLog(text, imageUrl, imageBlob) {
  // 1. Geminiで解析 (タイトル・タグ・気分の抽出)
  const result = analyzeDailyLogWithGemini(text, imageBlob);
  
  const diaryData = result.success ? result.data : { title: "日記", mood: "😐", tags: ["その他"] };
  const bodyText = result.success ? text : `⚠️ 解析失敗: ${result.error}\n\n${text}`;

  // 2. Notionへ保存
  saveToNotion(diaryData, bodyText, imageUrl);
}

// ============================================================
// 3. 週次レビュー処理 (トリガー実行用)
// ============================================================

function sendWeeklyReview() {
  if (!LINE_USER_ID) {
    console.error("LINE_USER_IDが設定されていません。スクリプトプロパティを確認してください。");
    return;
  }

  // 1. Notionから過去7日間のデータを取得
  const logs = fetchWeeklyLogsFromNotion();
  
  if (logs.length === 0) {
    pushLineMessage("今週は日記の記録がありませんでした。来週は記録してみましょう！📓");
    return;
  }

  // 2. AIへのコンテキスト作成
  let reviewContext = "以下はユーザーの過去1週間の日記ログです。これらを時系列に読み解き、以下の構成で週次レビューを作成してください。\n";
  reviewContext += "【構成】\n1. 今週のハイライト（褒めるポイント）\n2. 感情と関心の傾向分析\n3. 来週に向けた具体的なアクションプラン\n\n";
  reviewContext += "【日記データ】\n";
  
  logs.forEach(log => {
    reviewContext += `[${log.date}] 気分:${log.mood} タイトル:${log.title}\n内容: ${log.content}\n---\n`;
  });

  // 3. Geminiでレビュー生成
  try {
    const reviewText = generateReviewWithGemini(reviewContext);
    
    // 4. LINEへプッシュ通知
    pushLineMessage("📅 【週次レビューが届きました】\n\n" + reviewText);
    
  } catch (e) {
    console.error("Review Generation Error:", e);
    pushLineMessage("週次レビューの生成中にエラーが発生しました。\n" + e.message);
  }
}

// ============================================================
// 4. Notion API 連携 (読み書き)
// ============================================================

/**
 * Notionへページを追加する
 */
function saveToNotion(data, bodyText, imageUrl) {
  const url = 'https://api.notion.com/v1/pages';
  const safeBody = (bodyText || "").substring(0, 2000); // Notionブロック制限対策

  // 本文ブロックの作成
  const childrenBlocks = [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: safeBody } }] }
    }
  ];

  // 画像がある場合はリンクブロックを追加
  if (imageUrl) {
    childrenBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: "🔗 " } },
          { 
            type: 'text', 
            text: { content: "写真を開く (Google Drive)", link: { url: imageUrl } } 
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

/**
 * Notionから過去7日間のデータを取得する
 * フィルタ条件: created_time が過去1週間以内
 */
function fetchWeeklyLogsFromNotion() {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  
  // 7日前の日付を計算 (ISO String)
  const date = new Date();
  date.setDate(date.getDate() - 7);
  const isoDate = date.toISOString();

  const payload = {
    filter: {
      timestamp: "created_time",
      created_time: {
        on_or_after: isoDate
      }
    },
    sorts: [
      {
        timestamp: "created_time",
        direction: "ascending"
      }
    ]
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

  const json = JSON.parse(response.getContentText());
  const results = json.results || [];

  // 必要な情報だけ抽出して配列で返す
  return results.map(page => {
    const props = page.properties;
    
    // プロパティ取得の安全性確保
    const title = props["Name"]?.title[0]?.plain_text || "無題";
    const mood  = props["Mood"]?.select?.name || "不明";
    
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: title,
      mood: mood,
      content: title // Notion APIの制限により、タイトルを内容の要約として扱う
    };
  });
}

// ============================================================
// 5. Gemini API 連携 (解析 & 生成)
// ============================================================

/**
 * 日次ログ解析用 (JSONモード)
 */
function analyzeDailyLogWithGemini(text, imageBlob) {
  let errorLog = "";
  // 複数のモデル候補でリトライ
  const models = [MODEL_DAILY, "gemini-1.5-flash"];
  
  for (const model of models) {
    try {
      const json = callGeminiAPI(text, imageBlob, model, true);
      return { success: true, data: json };
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }
  return { success: false, error: errorLog };
}

/**
 * 週次レビュー生成用 (テキストモード)
 */
function generateReviewWithGemini(contextText) {
  return callGeminiAPI(contextText, null, MODEL_REVIEW, false);
}

/**
 * Gemini API 汎用呼び出し関数
 * @param {string} text - プロンプトまたは入力テキスト
 * @param {Blob} imageBlob - 画像Blob (任意)
 * @param {string} modelName - モデル名
 * @param {boolean} expectJson - JSONレスポンスを期待するかどうか
 */
function callGeminiAPI(text, imageBlob, modelName, expectJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  
  let promptText = text;
  if (expectJson) {
    promptText = imageBlob 
      ? `画像とテキストを分析し、指定のJSON形式で出力してください。入力: ${text}`
      : `テキストを分析し、指定のJSON形式で出力してください。入力: ${text}`;
    
    promptText += `\n\n出力JSONスキーマ: { "title": "20文字以内のタイトル", "mood": "気分(${MOODS.join("/")})", "tags": ["タグ(${TAGS.join(",")})から複数選択"] }`;
  }

  const part = { text: promptText };
  const parts = [part];

  if (imageBlob) {
    parts.push({
      inline_data: {
        mime_type: imageBlob.getContentType(),
        data: Utilities.base64Encode(imageBlob.getBytes())
      }
    });
  }

  const payload = {
    contents: [{ parts: parts }]
  };

  // JSONモードの場合はMimeTypeを指定
  if (expectJson) {
    payload.generationConfig = { response_mime_type: "application/json" };
  }

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  
  if (code !== 200) throw new Error(`Gemini API Error (${code}): ${body.substring(0, 200)}`);

  const responseJson = JSON.parse(body);
  const responseText = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!responseText) throw new Error("Geminiからの応答が空でした");

  if (expectJson) {
    // マークダウンのコードブロック除去などはAPIのJSONモードがよしなにやるが、念のため
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSON形式が見つかりませんでした");
    return JSON.parse(match[0]);
  } else {
    return responseText;
  }
}

// ============================================================
// 6. ユーティリティ (LINE Push & Drive)
// ============================================================

function pushLineMessage(text) {
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: LINE_USER_ID,
    messages: [{ type: 'text', text: text }]
  };
  
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload)
  });
}

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
  
  // Notion埋め込み用にブラウザ表示リンクを生成
  const viewerUrl = `https://drive.google.com/uc?export=view&id=${file.getId()}`;

  return { name: fileName, url: viewerUrl, blob: blob };
}