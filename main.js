/**
 * ============================================================
 * LINE Diary Bot (GAS)
 * LINE → Gemini/Claude → Google Drive → Notion
 * ============================================================
 *
 * 【日次記録】 LINEメッセージ/画像 → Gemini解析 → Notion保存
 * 【コマンド】 /today, /yesterday, /stats, /streak, /review,
 *             /monthly, /onthisday, /random, /search, /saveimage, /help
 * 【自動配信】 デイリーリマインダー / 週次レビュー / 月次レビュー
 *             / 半年レビュー / 年次レビュー
 *
 * ファイル構成:
 *   main.js             - エントリーポイント・定数・メイン処理
 *   notion.js           - Notion API
 *   gemini.js           - Gemini API
 *   claude.js           - Claude API (Anthropic)
 *   line.js             - LINE送受信
 *   commands.js         - コマンドハンドラー
 *   flex.js             - Flex Messageビルダー
 *   prompts.js          - レビュープロンプト・週次/月次レビュー送信
 *   longterm_reviews.js - 長期レビュー（半年・年次）
 *   utils.js            - ユーティリティ関数
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
/** Webhook URL の ?token= と照合する合言葉（オプション・推奨）: 設定すると一致しないリクエストを破棄 */
const WEBHOOK_TOKEN = PROPS.getProperty('WEBHOOK_TOKEN');
/** Claude API キー（オプション）: 設定するとレビュー自動生成にClaudeを使用 */
const CLAUDE_API_KEY = PROPS.getProperty('CLAUDE_API_KEY');

const TAGS = ["研究", "開発", "学習", "趣味", "健康", "資産", "食事", "外出", "写真", "その他"];
const MOODS = ["🤩", "😊", "😐", "😰", "😡"];
/** AI APIモデル設定（モデル更新時はここを変更） */
const AI_MODELS = {
  gemini: {
    /** レビュー生成用（品質優先・思考レベルは既定） */
    candidates: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
    /** 日記解析用（タイトル・気分・タグの分類のみ。速度優先・思考レベル low） */
    diaryAnalysisCandidates: ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"]
  },
  claude: {
    defaultText: "claude-sonnet-5-5",
    longTermReview: "claude-opus-5-5"
  }
};
/** Gemini APIモデル候補（優先順）: レビュー生成用 */
const MODEL_CANDIDATES = AI_MODELS.gemini.candidates;
/** Gemini APIモデル候補（優先順）: 日記解析用 */
const DIARY_MODEL_CANDIDATES = AI_MODELS.gemini.diaryAnalysisCandidates;

/** システム共通の制限値 */
const LIMITS = {
  /** Notion rich_text 1要素あたりの最大文字数（本文はこの長さごとに分割して保存） */
  NOTION_BODY_MAX: 2000,
  /** LINE テキストメッセージの最大文字数 */
  LINE_TEXT_MAX: 5000,
  /** 週次レビュー蓄積の保持件数 */
  REVIEW_HISTORY_MAX: 5,
  /** 蓄積する週次レビュー1件あたりの最大文字数（分割保存により9000文字制限を回避） */
  REVIEW_TEXT_MAX: 8000,
  /** 月次レビュー蓄積の保持件数（年次レビューのために最大12か月分） */
  MONTHLY_REVIEW_HISTORY_MAX: 12,
  /** 蓄積する月次レビュー1件あたりの最大文字数 */
  MONTHLY_REVIEW_TEXT_MAX: 8000,
  /** 四半期レビュー蓄積の保持件数は廃止 */
  /** 半年レビュー蓄積の保持件数（年次レビューのために最大2件） */
  HALFYEAR_REVIEW_HISTORY_MAX: 2,
  /** PropertiesService 1値あたりの安全な最大文字数 */
  PROPERTY_VALUE_MAX: 2000,
  /** /onthisday で遡る最大年数 */
  ONTHISDAY_YEARS: 5,
  /** /search で返す最大件数（LINEの一括返信上限に合わせる） */
  SEARCH_RESULT_MAX: 5,
  /** /search で新しい順に走査する最大ページ数 */
  SEARCH_SCAN_LIMIT: 60,
  /** 検索モードのタイムアウト（ミリ秒）: 10分 */
  SEARCH_MODE_TIMEOUT: 10 * 60 * 1000,
  /** 写真待機のタイムアウト（ミリ秒）: 最後の写真から30分 */
  PENDING_IMAGE_TIMEOUT: 30 * 60 * 1000,
  /** 1件の日記にまとめる待機写真の最大枚数 */
  PENDING_IMAGE_MAX: 20,
  /** 週次レビュー: 前回の集計終了時刻から続けて集計する最大日数（超えたら直近7日分に戻す） */
  WEEKLY_REVIEW_WINDOW_MAX_DAYS: 15,
  /** 月次レビュー: 前回の集計終了時刻から続けて集計する最大日数（超えたら当月1日からに戻す） */
  MONTHLY_REVIEW_WINDOW_MAX_DAYS: 63,
  /** 期末レビューの実行中フラグを「中断された」とみなすまでの時間（ミリ秒）: GASの最大実行時間6分より長く */
  REVIEW_RUN_STALE_MS: 10 * 60 * 1000,
};

function doPost(e) {
  if (!e?.postData) return ContentService.createTextOutput("error");

  // 注意: Google Apps Scriptの仕様上、doPost(e)ではHTTPヘッダー（x-line-signature）を取得できないため、
  // LINEのWebhook署名検証は実装できません。代わりに次の2段階で不正なリクエストを弾きます。
  //   1. WEBHOOK_TOKEN 設定時: Webhook URL末尾の ?token=xxx と一致しないリクエストを破棄
  //   2. 送信者が LINE_USER_ID 本人でないイベントを無視（isOwnerEvent）
  if (WEBHOOK_TOKEN && e.parameter?.token !== WEBHOOK_TOKEN) {
    console.warn("Webhookトークンが一致しないリクエストを破棄しました");
    return ContentService.createTextOutput("forbidden");
  }

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
    if (!isOwnerEvent(event)) {
      // 友だち追加した第三者などからのイベント。日記の閲覧・書き込みをさせないため何もしない
      // （LINE_USER_ID の設定ミスに気づけるよう、送信元IDをログに残す）
      console.warn(`LINE_USER_ID と一致しない送信元のイベントを無視しました: ${event.source?.type} ${event.source?.userId || ''}`);
      return;
    }
    const msg = event.message;
    const replyToken = event.replyToken;
    let failMessage = "⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。";

    try {
      // A. テキスト
      if (msg.type === 'text') {
        const text = msg.text;

        if (text.startsWith('/')) {
          const command = text.trim();
          const commandLower = command.toLowerCase();
          // コマンド: /saveimage は待機画像をハンドラ側で処理するのでスキップ
          if (commandLower !== '/saveimage') {
            const taken = takePendingImage();
            if (taken) {
              finalizeTakenPendingImage(taken);
              notifyOwner("📷 待機中の写真を写真日記として記録しました");
            }
          }
          if (commandLower !== '/search' && getSearchMode()) {
            clearSearchMode();
          }
          handleCommand(command, replyToken);
          return;
        }

        const searchMode = getSearchMode();
        if (searchMode) {
          const elapsed = Date.now() - searchMode.timestamp;
          if (elapsed <= LIMITS.SEARCH_MODE_TIMEOUT) {
            if (isSearchCancelText(text)) {
              clearSearchMode();
              replyLineMessage(replyToken, "🔍 検索をキャンセルしました。", buildCommandQuickReply());
              return;
            }

            clearSearchMode();
            executeSearchQuery(text.trim(), replyToken);
            return;
          }

          clearSearchMode();
        }

        // 通常テキスト（日記）: 待機写真があれば結合
        failMessage = "⚠️ 日記を記録できませんでした（保存されていません）。しばらくしてからもう一度送ってください。";
        const pending = takePendingImage();
        if (pending && !isPendingImageStale(pending)) {
          // 最後の写真から30分以内: 写真+テキストを結合して1エントリ
          try {
            processContent(text, pending.images.map(img => img.url), replyToken);
          } catch (err) {
            restorePendingImage(pending);   // 保存に失敗した写真は待機状態に戻す
            throw err;
          }
        } else {
          if (pending) {
            // 30分超過: 写真を単独確定 → テキストは通常処理
            finalizeTakenPendingImage(pending);
            notifyOwner("⏰ 以前送った写真を写真日記として記録しました");
          }
          processContent(text, [], replyToken);
        }
      }
      // B. 画像: Drive保存して待機状態にする
      else if (msg.type === 'image') {
        if (getSearchMode()) {
          clearSearchMode();
        }

        let imageInfo = null;
        try {
          imageInfo = saveImageToDrive(msg.id);
        } catch (imgErr) {
          console.error("画像保存失敗:", imgErr);
        }

        if (!imageInfo) {
          replyLineMessage(replyToken, "⚠️ 画像の保存に失敗しました。", buildCommandQuickReply());
          return;
        }

        // 待機リストへの追加はロック内で行う（連続送信された写真の取りこぼし防止）
        // 30分以内に届いた写真は1件の日記にまとめる
        const added = addPendingImage({
          url: imageInfo.url,
          name: imageInfo.name,
          timestamp: event.timestamp || Date.now()
        });
        if (added.stale) {
          finalizeTakenPendingImage(added.stale);
          notifyOwner("📷 前の写真を写真日記として記録しました");
        }
        const countText = added.count > 1 ? `（${added.count}枚）` : "";
        replyLineMessage(replyToken, `📷 写真を受け取りました${countText}！感想やメモを送ると、一緒に記録します。`, buildPhotoQuickReply());
      }
    } catch (err) {
      // エラーは実行ログにのみ残す（日記DBには書き込まない）
      console.error("イベント処理エラー:", err);
      try {
        replyLineMessage(replyToken, failMessage, buildCommandQuickReply());
      } catch (replyErr) {
        console.error("エラー返信も失敗:", replyErr);
      }
    }
  });
  return ContentService.createTextOutput("ok");
}

/**
 * 本人（LINE_USER_ID）が1対1トークで送ったイベントか
 * @param {Object} event - LINE Webhookイベント
 * @returns {boolean}
 */
function isOwnerEvent(event) {
  return !!LINE_USER_ID && event.source?.type === 'user' && event.source.userId === LINE_USER_ID;
}

// ============================================================
// メイン処理
// ============================================================

/**
 * テキスト日記を解析してNotionに保存し、結果を返信する。
 * 例外を投げるのはNotion保存に失敗したときだけ（保存後の返信失敗はログのみ）。
 * @param {string} text - 日記本文
 * @param {string[]} imageUrls - 結合する写真のDrive URL（なければ空配列）
 * @param {string} [replyToken]
 */
function processContent(text, imageUrls, replyToken) {
  const recordedAt = new Date();
  const result = analyzeWithGemini(text, null);

  if (result.success) {
    saveToNotion(result.data, text, imageUrls, recordedAt);
    afterDiarySaved(recordedAt);
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
          try {
            pushLineMessage(`✅ 記録しました (Flex Error)\n\n${result.data.title || "無題"}\n\nエラー: ${pushErr.message}\n(詳細なJSONデータはNotionに保存しました)`);
          } catch (textErr) {
            console.error("Text push failed:", textErr);
          }
        }
      }
    }
  } else {
    // 失敗時
    saveToNotion(
      { title: "📷 写真日記", mood: "😐", tags: ["その他"] },
      `⚠️ AI解析失敗\n\n【エラー】\n${result.error}\n\n【原文】\n${text}`,
      imageUrls,
      recordedAt
    );
    afterDiarySaved(recordedAt);
    if (replyToken) {
      try {
        replyLineMessage(replyToken, "⚠️ AI解析に失敗しましたが、原文をNotionに保存しました", buildCommandQuickReply());
      } catch (e) {
        console.error("AI解析失敗の返信に失敗:", e);
      }
    }
  }
}

/**
 * 日記保存後の後処理: streakキャッシュ更新と記録開始日の保存
 * （失敗しても日記記録には影響させない）
 * @param {Date} recordedAt - 日記の日時（Notionの Date に入れた値）
 */
function afterDiarySaved(recordedAt) {
  try { updateStreakCache(recordedAt); } catch (e) { console.error("streak cache update failed:", e); }
  // /random用: 初回記録時に開始日を保存
  try {
    if (!PROPS.getProperty('DIARY_START_DATE')) {
      PROPS.setProperty('DIARY_START_DATE', recordedAt.toISOString());
    }
  } catch (e) {
    console.error("DIARY_START_DATE save failed:", e);
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

// ============================================================
// 写真待機管理 (PENDING_IMAGE)
// ============================================================

// 待機写真は複数枚をまとめて保持する: { images: [{ url, name, timestamp }] }
// 読み書きが競合すると写真を取りこぼすため、変更は必ずスクリプトロック内で行う。
// （ロック内では updateStreakCache など他のロックを取る処理を呼ばないこと）

/**
 * 待機中の写真を取得（読み取りのみ）
 * @returns {{ images: Array<{url: string, name: string, timestamp: number}> } | null}
 */
function getPendingImage() {
  const raw = PROPS.getProperty('PENDING_IMAGE');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.images)) {
      return parsed.images.length > 0 ? { images: parsed.images } : null;
    }
    // 旧形式 { url, name, timestamp }（1枚のみ）
    if (parsed && parsed.url) {
      return { images: [{ url: parsed.url, name: parsed.name, timestamp: parsed.timestamp || Date.now() }] };
    }
    return null;
  } catch (e) {
    console.error("PENDING_IMAGE の解析に失敗:", e);
    return null;
  }
}

/** 待機写真のうち最初に送られた時刻（日記の日時に使う） */
function getPendingFirstTimestamp(pending) {
  return Math.min.apply(null, pending.images.map(img => img.timestamp));
}

/** 最後の写真から PENDING_IMAGE_TIMEOUT を過ぎたか */
function isPendingImageStale(pending) {
  const lastTimestamp = Math.max.apply(null, pending.images.map(img => img.timestamp));
  return Date.now() - lastTimestamp > LIMITS.PENDING_IMAGE_TIMEOUT;
}

/**
 * 写真を待機リストに追加する。
 * 既存の待機がタイムアウト済み（または枚数上限）の場合は、それを取り出して新しい待機を始める。
 * @param {{url: string, name: string, timestamp: number}} image
 * @returns {{ stale: Object|null, count: number }} stale: 呼び出し側で単独確定すべき古い待機写真
 */
function addPendingImage(image) {
  return withScriptLock(() => {
    const current = getPendingImage();
    let stale = null;
    let images = [];
    if (current) {
      if (isPendingImageStale(current) || current.images.length >= LIMITS.PENDING_IMAGE_MAX) {
        stale = current;
      } else {
        images = current.images;
      }
    }
    images.push(image);
    PROPS.setProperty('PENDING_IMAGE', JSON.stringify({ images: images }));
    return { stale: stale, count: images.length };
  });
}

/**
 * 待機写真を取り出す（取得と削除をロック内で同時に行い、二重記録を防ぐ）
 * @param {function(Object): boolean} [predicate] - 指定時は条件を満たす場合だけ取り出す
 * @returns {Object|null} 取り出した待機写真
 */
function takePendingImage(predicate) {
  return withScriptLock(() => {
    const current = getPendingImage();
    if (!current || (predicate && !predicate(current))) return null;
    PROPS.deleteProperty('PENDING_IMAGE');
    return current;
  });
}

/**
 * 取り出した待機写真を戻す（保存失敗時用）。その間に届いた写真があれば前に連結する。
 * 失敗しても元の例外を隠さないよう、ここでは例外を投げない。
 */
function restorePendingImage(pending) {
  try {
    withScriptLock(() => {
      const current = getPendingImage();
      const images = pending.images.concat(current ? current.images : []);
      PROPS.setProperty('PENDING_IMAGE', JSON.stringify({ images: images }));
    });
  } catch (e) {
    console.error("待機写真の復元に失敗（Driveには保存済み）:", JSON.stringify(pending), e);
  }
}

// ============================================================
// 検索モード管理 (SEARCH_MODE)
// ============================================================

function getSearchMode() {
  const raw = PROPS.getProperty('SEARCH_MODE');
  if (!raw) return null;
  try {
    const mode = JSON.parse(raw);
    if (!mode || !mode.timestamp) return null;
    return mode;
  } catch (e) {
    PROPS.deleteProperty('SEARCH_MODE');
    return null;
  }
}

function startSearchMode() {
  PROPS.setProperty('SEARCH_MODE', JSON.stringify({
    timestamp: Date.now()
  }));
}

function clearSearchMode() {
  PROPS.deleteProperty('SEARCH_MODE');
}

function isSearchCancelText(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return ['キャンセル', 'やめる', '中止', 'cancel', '/cancel'].indexOf(normalized) !== -1;
}

/**
 * takePendingImage で取り出した待機写真を写真日記として単独確定（Geminiスキップ）
 * 日記の日時は確定した時刻ではなく、最初の写真を送った時刻にする。
 * 保存に失敗した場合は待機状態に戻してから例外を投げる。
 * @param {{ images: Array<{url: string, name: string, timestamp: number}> }} pending
 */
function finalizeTakenPendingImage(pending) {
  try {
    const recordedAt = new Date(getPendingFirstTimestamp(pending));
    const urls = pending.images.map(img => img.url);
    const body = urls.length > 1 ? `📷 写真が${urls.length}枚送信されました` : "📷 写真が送信されました";
    saveToNotion({ title: "📷 写真日記", mood: "😐", tags: ["写真"] }, body, urls, recordedAt);
    afterDiarySaved(recordedAt);
  } catch (err) {
    restorePendingImage(pending);
    throw err;
  }
}

/**
 * タイムアウトした待機写真があれば写真日記として確定する（トリガー処理の冒頭で呼ぶ）
 * 写真だけ送って放置した日に、リマインダーが誤って届いたりレビューから漏れたりするのを防ぐ。
 * @returns {boolean} 確定したか
 */
function flushStalePendingImage() {
  try {
    const pending = takePendingImage(isPendingImageStale);
    if (!pending) return false;
    finalizeTakenPendingImage(pending);
    notifyOwner("⏰ 以前送った写真を写真日記として記録しました");
    return true;
  } catch (e) {
    console.error("待機写真の確定に失敗:", e);
    return false;
  }
}
