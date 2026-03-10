/**
 * ============================================================
 * LINE Diary Bot (GAS)
 * LINE → Gemini → Google Drive → Notion
 * ============================================================
 *
 * 【日次記録】 LINEメッセージ/画像 → Gemini解析 → Notion保存
 * 【コマンド】 /today, /yesterday, /stats, /streak, /review,
 *             /monthly, /onthisday, /random, /help
 * 【自動配信】 デイリーリマインダー / 週次レビュー / 月次レビュー
 *
 * ファイル構成:
 *   main.js       - エントリーポイント・定数・メイン処理
 *   notion.js     - Notion API
 *   gemini.js     - Gemini API
 *   line.js       - LINE送受信
 *   commands.js   - コマンドハンドラー
 *   flex.js       - Flex Messageビルダー
 *   prompts.js    - レビュープロンプト・送信ロジック
 *   utils.js      - ユーティリティ関数
 *
 * ============================================================
 */

/**
 * 日記ログの共通型定義
 * @typedef {Object} DiaryLog
 * @property {string} date - "2026/3/4" 形式の日付
 * @property {string} time - "14:30" 形式の時刻
 * @property {string} title - 日記タイトル
 * @property {string} mood - ムード絵文字
 * @property {string[]} tags - タグ配列
 * @property {string} [body] - 本文（省略可能）
 */

/**
 * Gemini解析結果の型定義
 * @typedef {Object} AnalysisResult
 * @property {string} title - 日記タイトル
 * @property {string} mood - ムード絵文字
 * @property {string[]} tags - タグ配列
 */

const PROPS = PropertiesService.getScriptProperties();

const LINE_TOKEN = PROPS.getProperty('LINE_TOKEN');
const NOTION_TOKEN = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID = PROPS.getProperty('NOTION_DB_ID');
const GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY');
const DRIVE_FOLDER_ID = PROPS.getProperty('DRIVE_FOLDER_ID');
const LINE_USER_ID = PROPS.getProperty('LINE_USER_ID');

const TAGS = ["研究", "開発", "学習", "趣味", "健康", "資産", "食事", "外出", "写真", "その他"];
const MOODS = ["🤩", "😊", "😐", "😰", "😡"];
/** Gemini APIモデル候補（優先順） */
const MODEL_CANDIDATES = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

/** システム共通の制限値 */
const LIMITS = {
  /** Notion本文の最大文字数 */
  NOTION_BODY_MAX: 2000,
  /** LINE テキストメッセージの最大文字数 */
  LINE_TEXT_MAX: 5000,
  /** 週次レビュー蓄積の保持件数 */
  REVIEW_HISTORY_MAX: 5,
  /** 蓄積する週次レビュー1件あたりの最大文字数 */
  REVIEW_TEXT_MAX: 1500,
  /** PropertiesService 1値あたりの安全な最大文字数 */
  PROPERTY_VALUE_MAX: 2000,
  /** /onthisday で遡る最大年数 */
  ONTHISDAY_YEARS: 5,
};

function doPost(e) {
  if (!e?.postData) return ContentService.createTextOutput("error");

  // 注意: Google Apps Scriptの仕様上、doPost(e)ではHTTPヘッダー（x-line-signature）を取得できません。
  // そのため、純粋なGASのみではLINEの厳密なWebhook署名検証は実装不可能です。
  // 簡易的なアクセス制限を行う場合は、Webhook URL末尾に自分だけのクエリパラメータ
  // (?token=xxx) を付け、e.parameter.token で判定する回避策が一般的です。

  const missingKeys = validateRequiredProps();
  if (missingKeys.length > 0) {
    console.error(`必須プロパティ未設定: ${missingKeys.join(", ")}`);
    return ContentService.createTextOutput("config error");
  }

  let events;
  try {
    events = JSON.parse(e.postData.contents).events || [];
  } catch (parseErr) {
    console.error("リクエスト解析エラー:", parseErr);
    return ContentService.createTextOutput("parse error");
  }

  events.forEach(event => {
    if (event.type !== 'message') return;
    const msg = event.message;
    const replyToken = event.replyToken;

    try {
      // A. テキスト
      if (msg.type === 'text') {
        // コマンド判定: "/" で始まる場合はコマンドとして処理
        if (msg.text.startsWith('/')) {
          handleCommand(msg.text.trim(), replyToken);
        } else {
          processContent(msg.text, null, null, replyToken);
        }
      }
      // B. 画像
      else if (msg.type === 'image') {
        // 画像保存に失敗してもテキスト記録は行うグレースフルデグラデーション
        let imageInfo = null;
        try {
          imageInfo = saveImageToDrive(msg.id);
        } catch (imgErr) {
          console.error("画像保存失敗（テキストのみで記録を続行）:", imgErr);
        }

        const logText = imageInfo
          ? `📷 写真をアップロードしました\n(${imageInfo.name})`
          : "📷 写真が送信されました（画像の保存に失敗しました）";
        const imageUrl = imageInfo ? imageInfo.url : null;
        const imageBlob = imageInfo ? imageInfo.blob : null;

        processContent(logText, imageUrl, imageBlob, replyToken);
      }
    } catch (err) {
      console.error("イベント処理エラー:", err);
      // ユーザーへエラーを返信（replyToken が有効な場合）
      try {
        replyLineMessage(replyToken, "⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。", buildCommandQuickReply());
      } catch (replyErr) {
        console.error("エラー返信も失敗:", replyErr);
      }
      // Notionにエラーを記録
      try {
        saveToNotion({ title: "❌ システムエラー", mood: "😰", tags: ["その他"] }, err.toString(), null);
      } catch (notionErr) {
        console.error("Notion保存も失敗:", notionErr);
      }
    }
  });
  return ContentService.createTextOutput("ok");
}

// ============================================================
// メイン処理
// ============================================================

function processContent(text, imageUrl, imageBlob, replyToken) {
  const result = analyzeWithGemini(text, imageBlob);

  if (result.success) {
    saveToNotion(result.data, text, imageUrl);
    // streakキャッシュ更新（失敗しても日記記録には影響なし）
    try { updateStreakCache(); } catch (e) { console.error("streak cache update failed:", e); }
    // /random用: 初回記録時に開始日を保存
    if (!PROPS.getProperty('DIARY_START_DATE')) {
      PROPS.setProperty('DIARY_START_DATE', new Date().toISOString());
    }
    // Notion保存成功をFlex Messageで返信
    if (replyToken) {
      try {
        const flexContent = buildDiaryRecordFlex(result.data);
        replyFlexMessage(replyToken, "✅ 記録しました: " + (result.data.title || "無題"), flexContent, buildCommandQuickReply());
      } catch (e) {
        console.error("Flex reply failed, attempting push fallback:", e);
        try {
          // Fallback 1: Push Flex Message (if reply token expired but payload is valid)
          const flexContent = buildDiaryRecordFlex(result.data);
          pushFlexMessage("✅ 記録しました: " + (result.data.title || "無題"), flexContent, buildCommandQuickReply());
        } catch (pushErr) {
          console.error("Flex push failed, attempting text push:", pushErr);
          // テキストメッセージでフォールバック
          pushLineMessage(`✅ 記録しました (Flex Error)\n\n${result.data.title || "無題"}\n\nエラー: ${pushErr.message}\n(詳細なJSONデータはNotionに保存しました)`);
        }
      }
    }
  } else {
    // 失敗時
    saveToNotion(
      { title: "📷 写真日記", mood: "😐", tags: ["その他"] },
      `⚠️ AI解析失敗\n\n【エラー】\n${result.error}\n\n【原文】\n${text}`,
      imageUrl
    );
    // streakキャッシュ更新（失敗しても日記記録には影響なし）
    try { updateStreakCache(); } catch (e) { console.error("streak cache update failed:", e); }
    if (replyToken) {
      replyLineMessage(replyToken, "⚠️ AI解析に失敗しましたが、原文をNotionに保存しました", buildCommandQuickReply());
    }
  }
}

// ============================================================
// 画像保存 (Drive Only)
// ============================================================

function saveImageToDrive(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`LINE画像取得エラー (${code}): ${response.getContentText().substring(0, 200)}`);
  }

  const blob = response.getBlob();
  const date = new Date();
  const tz = Session.getScriptTimeZone();
  const fileName = `Photo_${Utilities.formatDate(date, tz, "yyyyMMdd_HHmmss")}.jpg`;

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const file = folder.createFile(blob.setName(fileName));

  // ブラウザ表示用URLを生成
  const viewerUrl = `https://drive.google.com/uc?export=view&id=${file.getId()}`;

  return {
    name: fileName,
    url: viewerUrl,
    blob: blob
  };
}