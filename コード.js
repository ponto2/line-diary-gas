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

const LINE_TOKEN = PROPS.getProperty('LINE_TOKEN');
const NOTION_TOKEN = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID = PROPS.getProperty('NOTION_DB_ID');
const GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY');
const DRIVE_FOLDER_ID = PROPS.getProperty('DRIVE_FOLDER_ID');
const LINE_USER_ID = PROPS.getProperty('LINE_USER_ID'); // ★追加: プッシュ通知用

const TAGS = ["研究", "開発", "健康", "勉強", "感想", "資産", "購入", "恋愛", "食事", "写真", "その他"];
const MOODS = ["🤩", "😊", "😐", "😰", "😡"];
// 最新モデル優先リスト
const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

function doPost(e) {
  if (!e?.postData) return ContentService.createTextOutput("error");

  // ★改善4: 必須プロパティのバリデーション
  const missingKeys = validateRequiredProps();
  if (missingKeys.length > 0) {
    console.error(`必須プロパティ未設定: ${missingKeys.join(", ")}`);
    return ContentService.createTextOutput("config error");
  }

  try {
    const events = JSON.parse(e.postData.contents).events || [];
    events.forEach(event => {
      if (event.type !== 'message') return;
      const msg = event.message;
      const replyToken = event.replyToken;

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
        // 1. 画像をDriveに保存
        const imageInfo = saveImageToDrive(msg.id);
        const logText = `📷 写真をアップロードしました\n(${imageInfo.name})`;

        // 2. 解析 & Notion保存
        processContent(logText, imageInfo.url, imageInfo.blob, replyToken);
      }
    });
  } catch (err) {
    // ★改善1: 二重障害時の安全対策
    try {
      saveToNotion({ title: "❌ システムエラー", mood: "😰", tags: ["その他"] }, err.toString(), null);
    } catch (notionErr) {
      console.error("Notion保存も失敗:", notionErr);
    }
  }
  return ContentService.createTextOutput("ok");
}

// ============================================================
// メイン処理
// ============================================================

function processContent(text, imageUrl, imageBlob, replyToken) {
  // 画像がある場合は、その内容を加味して解析
  const result = analyzeWithGemini(text, imageBlob);

  // Notionの本文には、URLをベタ書きせず、saveToNotionでリンク化する
  // エラー時などに備えてテキストはそのまま渡す

  if (result.success) {
    saveToNotion(result.data, text, imageUrl);
    // streakキャッシュ更新（失敗しても日記記録には影響なし）
    try { updateStreakCache(); } catch (e) { console.error("streak cache update failed:", e); }
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

          // Debug: Log the failing Flex Content to Notion
          try {
            const debugPayload = JSON.stringify(buildDiaryRecordFlex(result.data), null, 2);
            saveToNotion({ title: "❌ Flex Debug Payload", mood: "🐛", tags: ["debug"] }, debugPayload + "\n\nError: " + pushErr.message, null);
          } catch (e) {
            console.error("Failed to log debug payload", e);
          }

          // Fallback 2: Push Text Message (if payload is invalid)
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
  // ★改善1: LINE APIのエラーハンドリング追加
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
  // ★改善3: タイムゾーンを環境依存しない形式に変更
  const tz = Session.getScriptTimeZone();
  const fileName = `Photo_${Utilities.formatDate(date, tz, "yyyyMMdd_HHmmss")}.jpg`;

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

  // ★改善1: Notion API呼び出しにもエラーハンドリングを追加
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`Notion保存エラー (${code}): ${response.getContentText().substring(0, 200)}`);
  }
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

  // ▼ 更新: プロンプト改善版 - タイトル・タグ・ムードの精度向上
  const systemPrompt = `
あなたはユーザーの日記を分析し、メタデータを付与するAIアシスタントです。
ユーザーの入力（テキストまたは画像）を読み取り、以下の3つの要素を含むJSONオブジェクトのみを出力してください。

1. title: 内容を端的に表すタイトル（20文字以内の日本語）。
2. mood: 内容から読み取れる気分を [${MOODS.join(", ")}] から1つ選択。
3. tags: 以下のリストから、内容に合致するタグを選択（複数選択可）。

【タイトルのルール】
- 「何をしたか」が一目でわかる具体名詞を含めること
- 日記の中心的な活動を反映し、付随的な話題は無視すること
- 良い例: 「卒論の比較表作成」「渋谷でランチデート」「NISAの積立設定」
- 悪い例: 「今日の出来事」「いろいろ」「日記」「充実した一日」

【ムードの判定基準】
- 🤩: 非常にポジティブ。興奮、達成感、大きな喜びがある
- 😊: ポジティブ。楽しい、嬉しい、満足、穏やかな喜び
- 😐: 中立。感情表現が少ない、淡々とした事実の記録、特に良くも悪くもない
- 😰: ネガティブ。不安、疲労、困惑、ストレス、悲しみ
- 😡: 非常にネガティブ。怒り、強い不満、激しいストレス
- 感情が明示されていない場合は 😐 を選択すること
- 複数の感情が混在する場合は、全体のトーンから最も近いものを選ぶこと
- 【画像入力の場合】写真を撮って送信している行為自体がポジティブな意図を持つため、基本的に 🤩 か 😊 を選択すること
- 【画像入力の場合】特に、ラーメン・焼肉・寿司などのボリューミーな食べ物や豪華な食事の写真は 🤩 を割り当てること

【タグの定義と使い分け】
- 研究: 大学での研究活動全般。回路設計、実測、シミュレーション、論文執筆など。
- 開発: プライベートで行う開発。Bot作成、GAS、プログラミング、アプリ開発など。
- 健康: 身体と心のメンテナンス。筋トレ、睡眠、体調管理、手術など。
- 勉強: 知識インプット活動。大学の講義、資格試験、英語学習。
- 感想: モノや体験に対する「感想」「評価」。本やライブの感想，製品の感想，食事の感想など。
- 資産: 金融資産の記録。NISA、仮想通貨、貯金残高、給料、ローン返済など。
- 購入: 物品の購入ログ。ガジェット、本、服などが「届いた」「買った」という記録。
- 恋愛: パートナーとの関係、デート、感情の機微。
- 食事: 食事の内容、自炊、外食、サプリメント摂取。
- 写真: 画像が送信された場合。
- その他: 上記のいずれにも当てはまらないもの。

【タグの判定ルール】
- タグは「実際に行った事実・記録」にのみ付与すること。以下のような付随的な言及にはタグを付けない:
  × 予定・願望（「明日〜しよう」「〜したいな」「どっか行く？」）
  × 質問・独り言（「〜食べに行く？」「何しよう」）
  × 比喩・慣用表現（「頭が痛い問題」→ 健康タグは不要）
- 画像がある場合は必ず "写真" タグを含めること。
- 金融商品（株・仮想通貨）の売買は "資産"。消費財（PC・本・服）の購入は "購入"。
- 料理の写真の場合は ["食事", "写真"] のように両方を選択すること。
- 食事をして、その味や店の感想を述べている場合は ["食事", "感想"] の両方を付けること。
- "その他" タグは、他に該当するタグが1つもない場合にのみ使用すること。他のタグと "その他" を同時に付けてはいけない。

【入出力例】

入力: 「卒論の比較表を作り直す。終わったらどっかご飯食べに行く？」
出力: {"title": "卒論の比較表修正", "mood": "😐", "tags": ["研究"]}
理由: ご飯は質問/予定であり記録ではないためタグ不要

入力: 「新しいラーメン屋行ったけど味噌が濃すぎた。まあまあかな」
出力: {"title": "新しいラーメン屋の感想", "mood": "😐", "tags": ["食事", "感想"]}
理由: 食事の記録+味の感想があるため両方

入力: 「AirPods届いた！音質めっちゃいい」
出力: {"title": "AirPods開封の感想", "mood": "🤩", "tags": ["購入", "感想"]}
理由: 購入の記録+感想

入力: 「彼女と渋谷で映画見た。楽しかった」
出力: {"title": "渋谷で映画デート", "mood": "😊", "tags": ["恋愛"]}

入力: 「今日は特に何もなかった。だらだらしてた」
出力: {"title": "休息の一日", "mood": "😐", "tags": ["その他"]}

入力: 「ベンチプレス80kg達成！自己ベスト更新」
出力: {"title": "ベンチプレス80kg達成", "mood": "🤩", "tags": ["健康"]}

【出力フォーマット (JSON)】
{
  "title": "...",
  "mood": "...",
  "tags": ["タグ1", "タグ2"]
}
`;

  // ユーザーの入力テキスト
  const userContent = imageBlob
    ? `添付画像を分析し、上記ルールに従ってJSONを生成してください。\n補足テキスト: ${text}`
    : `以下のテキストを分析し、上記ルールに従ってJSONを生成してください。\nテキスト: ${text}`;

  const promptPart = { text: systemPrompt + "\n\n" + userContent };

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

  // ★改善2: オプショナルチェインで安全にパース
  // ★改善7: response_mime_type指定済みなので正規表現不要、直接JSON.parse
  const rawText = JSON.parse(body)?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  return JSON.parse(rawText);
}

// ============================================================
// ▼ 以下拡張機能: 週次レビューシステム
// ============================================================

/**
 * 0. デイリーリマインダー (トリガー実行)
 * 夜に日記が未記録の場合に通知
 */
function sendDailyReminder() {
  if (!LINE_USER_ID) return;

  try {
    const logs = fetchTodayLogsFromNotion();
    if (logs.length === 0) {
      pushLineMessage("こんばんは！🌙\n今日はまだ日記が記録されていないようです。\n\n一日の終わりに、今日の出来事や気持ちを少しだけ残してみませんか？✍️");
    } else {
      console.log("本日は既に日記が記録されています。");
    }
  } catch (e) {
    console.error("Reminder Error:", e);
  }
}

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
  const lastReview = getLastReview();
  const stats = buildLogStatistics(logs);

  let reviewContext = buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs);

  // 1-3. Geminiでレビュー生成
  let reviewText = "";
  let errorLog = "";

  for (const model of MODEL_CANDIDATES) {
    try {
      reviewText = callGeminiForText(reviewContext, model);
      break;
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }

  if (reviewText) {
    // レビューテキスト + 統計カードを同時送信
    const LINE_TEXT_LIMIT = 5000;
    const header = "📅 【週次レビュー】\n\n";
    const safeReview = reviewText.length > (LINE_TEXT_LIMIT - header.length - 20)
      ? reviewText.substring(0, LINE_TEXT_LIMIT - header.length - 20) + "\n\n…（以下省略）"
      : reviewText;

    const statsMsg = { type: 'flex', altText: '📊 今週の統計', contents: buildStatsFlex(logs) };
    statsMsg.quickReply = buildCommandQuickReply();
    const messages = [
      { type: 'text', text: header + safeReview },
      statsMsg
    ];
    pushMessages(messages);
    saveLastReview(reviewText);
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
  date.setHours(0, 0, 0, 0); // 当日の00:00:00にリセット
  date.setDate(date.getDate() - 6); // 6日前の00:00:00
  const isoDate = date.toISOString();

  const basePayload = {
    filter: {
      timestamp: "created_time",
      created_time: { on_or_after: isoDate }
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  };

  // ★改善5: ページネーション対応 (100件以上のデータも取得可能に)
  let allResults = [];
  let hasMore = true;
  let nextCursor = undefined;

  while (hasMore) {
    const payload = { ...basePayload };
    if (nextCursor) payload.start_cursor = nextCursor;

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      console.error(`Notionデータ取得エラー (${code}): ${response.getContentText().substring(0, 200)}`);
      break;
    }

    const data = JSON.parse(response.getContentText());
    allResults = allResults.concat(data.results || []);
    hasMore = data.has_more === true;
    nextCursor = data.next_cursor;
  }

  return allResults.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const body = fetchPageBodyText(page.id);
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明",
      tags: tags,
      body: body
    };
  });
}

/**
 * 2-c. 今日のログを取得 (Notion)
 */
function fetchTodayLogsFromNotion() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isoDate = today.toISOString();

  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      filter: {
        timestamp: "created_time",
        created_time: { on_or_after: isoDate }
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Notionデータ取得エラー: ${response.getContentText()}`);
  }

  const data = JSON.parse(response.getContentText());
  const results = data.results || [];

  return results.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const time = new Date(page.created_time);
    return {
      time: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "😐",
      tags: tags
    };
  });
}

/**
 * 2-d. 昨日のログを取得 (Notion)
 */
function fetchYesterdayLogsFromNotion() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const isoStart = yesterday.toISOString();
  const isoEnd = today.toISOString();

  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      filter: {
        and: [
          { timestamp: "created_time", created_time: { on_or_after: isoStart } },
          { timestamp: "created_time", created_time: { before: isoEnd } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Notionデータ取得エラー: ${response.getContentText()}`);
  }

  const data = JSON.parse(response.getContentText());
  const results = data.results || [];

  return results.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const time = new Date(page.created_time);
    return {
      time: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "😐",
      tags: tags
    };
  });
}

/**
 * 2-b. Notionページの本文テキストを取得
 */
function fetchPageBodyText(pageId) {
  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) return "(取得失敗)";

    const blocks = JSON.parse(response.getContentText()).results || [];
    let text = "";
    for (const block of blocks) {
      const richTexts = block[block.type]?.rich_text || [];
      for (const rt of richTexts) {
        text += rt.plain_text || "";
      }
    }
    return text || "(本文なし)";
  } catch (e) {
    console.error(`本文取得エラー (${pageId}):`, e);
    return "(取得失敗)";
  }
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
 * 4. LINEプッシュ送信（テキスト）
 */
function pushLineMessage(text) {
  const LINE_TEXT_LIMIT = 5000;
  const safeText = text.length > LINE_TEXT_LIMIT
    ? text.substring(0, LINE_TEXT_LIMIT - 20) + "\n\n…（以下省略）"
    : text;
  const msg = { type: 'text', text: safeText, quickReply: buildCommandQuickReply() };
  pushMessages([msg]);
}

/**
 * 4-b. LINEプッシュ送信（複数メッセージ対応）
 */
function pushMessages(messages) {
  const url = "https://api.line.me/v2/bot/message/push";
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      to: LINE_USER_ID,
      messages: messages
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`LINE Push Error: ${response.getContentText()}`);
  }
}

/**
 * 4-c. LINE Flex Messageプッシュ送信
 */
function pushFlexMessage(altText, flexContents, quickReply) {
  const msg = {
    type: 'flex',
    altText: altText,
    contents: flexContents
  };
  if (quickReply) msg.quickReply = quickReply;
  pushMessages([msg]);
}

/**
 * 5. LINE返信送信 (Reply API)
 * @param {Object} [quickReply] - Quick Replyオブジェクト（省略可）
 */
function replyLineMessage(replyToken, text, quickReply) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const msg = { type: 'text', text: text };
  if (quickReply) msg.quickReply = quickReply;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [msg]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`LINE Reply Error: ${response.getContentText()}`);
  }
}

/**
 * 5-b. LINE Flex Message返信
 * @param {Object} [quickReply] - Quick Replyオブジェクト（省略可）
 */
function replyFlexMessage(replyToken, altText, flexContents, quickReply) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const msg = {
    type: 'flex',
    altText: altText,
    contents: flexContents
  };
  if (quickReply) msg.quickReply = quickReply;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [msg]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`LINE API Response Error: ${response.getContentText()}`);
  }
}

/**
 * 5-c. コマンド用 Quick Reply ボタンを生成
 */
function buildCommandQuickReply() {
  var items = [
    { type: "action", action: { type: "message", label: "📝 今日", text: "/today" } },
    { type: "action", action: { type: "message", label: "⏪ 昨日", text: "/yesterday" } },
    { type: "action", action: { type: "message", label: "🎲 ガチャ", text: "/random" } },
    { type: "action", action: { type: "message", label: "📊 統計", text: "/stats" } },
    { type: "action", action: { type: "message", label: "🔥 連続", text: "/streak" } },
    { type: "action", action: { type: "message", label: "🧐 レビュー", text: "/review" } },
    { type: "action", action: { type: "message", label: "🕰️ 1年前", text: "/onthisday" } }
  ];
  return { items: items };
}

// ============================================================
// コマンド処理
// ============================================================

/**
 * コマンドルーター
 * LINEで "/" から始まるテキストを受信した際に呼ばれる
 */
function handleCommand(text, replyToken) {
  const cmd = text.split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '/help':
      replyFlexMessage(replyToken, "コマンド一覧", buildHelpFlex(), buildCommandQuickReply());
      break;

    case '/stats':
      handleStatsCommand(replyToken);
      break;

    case '/review':
      handleReviewCommand(replyToken);
      break;

    case '/today':
      handleTodayCommand(replyToken);
      break;

    case '/yesterday':
      handleYesterdayCommand(replyToken);
      break;

    case '/streak':
      handleStreakCommand(replyToken);
      break;

    case '/monthly':
      handleMonthlyCommand(replyToken);
      break;

    case '/onthisday':
      handleOnThisDayCommand(replyToken);
      break;

    case '/random':
      handleRandomCommand(replyToken);
      break;

    default:
      replyFlexMessage(replyToken, "不明なコマンドです", buildUnknownCommandFlex(cmd), buildCommandQuickReply());
      break;
  }
}

/**
 * /stats コマンド: 直近7日間の統計をFlex Messageで返信
 */
function handleStatsCommand(replyToken) {
  try {
    const logs = fetchWeeklyLogsFromNotion();
    if (logs.length === 0) {
      replyLineMessage(replyToken, "📊 直近7日間の記録がありません。日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }
    const flexContent = buildStatsFlex(logs);
    replyFlexMessage(replyToken, "📊 直近7日間の統計", flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("statsコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 統計の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /review コマンド: 週次レビューをオンデマンド生成
 */
function handleReviewCommand(replyToken) {
  try {
    const logs = fetchWeeklyLogsFromNotion();
    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 直近7日間の記録がないため、レビューを生成できません。", buildCommandQuickReply());
      return;
    }

    // sendWeeklyReviewと同様のロジックでレビュー生成
    const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
    const lastReview = getLastReview();
    const stats = buildLogStatistics(logs);

    let reviewContext = buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs);

    let reviewText = "";
    let errorLog = "";

    for (const model of MODEL_CANDIDATES) {
      try {
        reviewText = callGeminiForText(reviewContext, model);
        break;
      } catch (e) {
        errorLog += `[${model}] ${e.message}\n`;
      }
    }

    if (reviewText) {
      // LINE Reply APIの5000文字制限に対応
      const LINE_TEXT_LIMIT = 5000;
      const header = "📅 【週次レビュー】\n\n";
      const safeReview = reviewText.length > (LINE_TEXT_LIMIT - header.length - 20)
        ? reviewText.substring(0, LINE_TEXT_LIMIT - header.length - 20) + "\n\n…（以下省略）"
        : reviewText;
      replyLineMessage(replyToken, header + safeReview, buildCommandQuickReply());
    } else {
      replyLineMessage(replyToken, "⚠️ レビュー生成に失敗しました。\n" + errorLog, buildCommandQuickReply());
    }
  } catch (e) {
    console.error("reviewコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ レビューの生成に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /monthly コマンド: 月次レビューをオンデマンド生成
 * 当月の1日から実行時点までを対象にする
 */
function handleMonthlyCommand(replyToken) {
  try {
    // 対象範囲: 当月1日〜現在
    const now = new Date();
    const targetMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const targetMonthEnd = now; // 実行時点まで

    // 月末かどうか判定（明日が1日 = 今日が月末）
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isEndOfMonth = tomorrow.getDate() === 1;

    // 蓄積された週次レビューを取得し、当月のもののみフィルタ
    const allWeeklyReviews = getWeeklyReviewHistory();
    const weeklyReviews = filterReviewsByMonth(allWeeklyReviews, targetMonthStart, targetMonthEnd);

    // 当月のログメタデータを取得（本文なし）
    const logs = fetchMonthlyLogsFromNotion(targetMonthStart, targetMonthEnd);
    if (logs.length === 0 && weeklyReviews.length === 0) {
      replyLineMessage(replyToken, "📝 今月の記録と週次レビューの蓄積がないため、月次レビューを生成できません。", buildCommandQuickReply());
      return;
    }

    const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
    const lastMonthlyReview = getLastMonthlyReview();
    const stats = buildLogStatistics(logs);
    const targetYearMonth = targetMonthStart.getFullYear() + "年" + (targetMonthStart.getMonth() + 1) + "月";
    const label = isEndOfMonth ? targetYearMonth + " 月次レビュー" : targetYearMonth + " 月次レビュー（中間）";

    // 月末の未レビュー日の日記本文を補完取得
    const supplementLogs = fetchMonthEndSupplementLogs(weeklyReviews, logs, targetMonthEnd);

    const prompt = buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, targetYearMonth, supplementLogs);

    let reviewText = "";
    let errorLog = "";

    for (const model of MODEL_CANDIDATES) {
      try {
        reviewText = callGeminiForText(prompt, model);
        break;
      } catch (e) {
        errorLog += `[${model}] ${e.message}\n`;
      }
    }

    if (reviewText) {
      const LINE_TEXT_LIMIT = 5000;
      const header = "📆 【" + label + "】\n\n";
      const safeReview = reviewText.length > (LINE_TEXT_LIMIT - header.length - 20)
        ? reviewText.substring(0, LINE_TEXT_LIMIT - header.length - 20) + "\n\n…（以下省略）"
        : reviewText;
      replyLineMessage(replyToken, header + safeReview, buildCommandQuickReply());
    } else {
      replyLineMessage(replyToken, "⚠️ 月次レビュー生成に失敗しました。\n" + errorLog, buildCommandQuickReply());
    }
  } catch (e) {
    console.error("monthlyコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 月次レビューの生成に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /today コマンド: 今日の記録一覧を表示
 */
function handleTodayCommand(replyToken) {
  try {
    const logs = fetchTodayLogsFromNotion();

    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 今日はまだ記録がありません。日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }

    const flexContent = buildTodayFlex(logs);
    replyFlexMessage(replyToken, `📝 今日の記録 (${logs.length}件)`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("todayコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 今日の記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /yesterday 昨日の記録一覧を表示
 */
function handleYesterdayCommand(replyToken) {
  try {
    const logs = fetchYesterdayLogsFromNotion();

    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 昨日の記録はありませんでした。", buildCommandQuickReply());
      return;
    }

    const flexContent = buildYesterdayFlex(logs);
    replyFlexMessage(replyToken, `📝 昨日の記録 (${logs.length}件)`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("yesterdayコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 昨日の記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * 日付をYYYY-MM-DD形式の文字列に変換
 */
function formatDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 日記記録時にstreakキャッシュを更新する
 * PropertiesServiceのみ使用（Notion APIコール0回）
 */
function updateStreakCache() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const streakCount = parseInt(PROPS.getProperty('STREAK_COUNT') || '0', 10);
  const lastDate = PROPS.getProperty('STREAK_LAST_DATE') || '';
  const totalDays = parseInt(PROPS.getProperty('STREAK_TOTAL_DAYS') || '0', 10);

  if (lastDate === todayKey) {
    // 同日2回目以降の記録 → 何もしない
    return;
  }

  // 昨日の日付を計算
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = formatDateKey(yesterday);

  if (lastDate === yesterdayKey) {
    // 昨日も記録あり → streak継続
    PROPS.setProperty('STREAK_COUNT', String(streakCount + 1));
  } else {
    // 途切れた or 初回 → streakリセット、開始日を今日に
    PROPS.setProperty('STREAK_COUNT', '1');
    PROPS.setProperty('STREAK_START_DATE', todayKey);
  }

  PROPS.setProperty('STREAK_LAST_DATE', todayKey);
  PROPS.setProperty('STREAK_TOTAL_DAYS', String(totalDays + 1));
}

/**
 * キャッシュ未初期化時: 30日ウィンドウ方式でstreakをフル計算
 * ページネーション対応、ウィンドウを遡って連続が途切れるまで計算
 */
function initStreakCache() {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const recordedDates = new Set();
  let windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() + 1); // 明日（排他的上限）

  // 30日ウィンドウを遡りながら記録日を収集
  for (let w = 0; w < 40; w++) { // 最大約3年分（40ウィンドウ × 30日）
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - 30);

    // このウィンドウの全レコードを取得（ページネーション対応）
    let hasMore = true;
    let nextCursor = null;

    while (hasMore) {
      const payload = {
        filter: {
          timestamp: "created_time",
          created_time: {
            on_or_after: windowStart.toISOString(),
            before: windowEnd.toISOString()
          }
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100
      };
      if (nextCursor) payload.start_cursor = nextCursor;

      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() !== 200) break;

      const data = JSON.parse(response.getContentText());
      (data.results || []).forEach(page => {
        recordedDates.add(formatDateKey(new Date(page.created_time)));
      });

      hasMore = data.has_more;
      nextCursor = data.next_cursor;
    }

    // 今日から遡って連続日数を計算
    const check = new Date(today);
    if (!recordedDates.has(todayKey)) {
      check.setDate(check.getDate() - 1);
    }

    let streak = 0;
    let streakBroken = false;
    while (check >= windowStart) {
      if (recordedDates.has(formatDateKey(check))) {
        streak++;
        check.setDate(check.getDate() - 1);
      } else {
        streakBroken = true;
        break;
      }
    }

    if (streakBroken) {
      // 途切れた → 確定
      const lastDate = recordedDates.has(todayKey) ? todayKey : formatDateKey(new Date(today.getTime() - 86400000));
      // 開始日 = 今日からstreak日数分遡った日
      const startDate = new Date(today);
      if (!recordedDates.has(todayKey)) startDate.setDate(startDate.getDate() - 1);
      startDate.setDate(startDate.getDate() - (streak - 1));
      const startDateKey = formatDateKey(startDate);
      PROPS.setProperty('STREAK_COUNT', String(streak));
      PROPS.setProperty('STREAK_LAST_DATE', lastDate);
      PROPS.setProperty('STREAK_START_DATE', startDateKey);
      PROPS.setProperty('STREAK_TOTAL_DAYS', String(recordedDates.size));
      return { streak: streak, totalDays: recordedDates.size, hasTodayRecord: recordedDates.has(todayKey), startDate: startDateKey };
    }

    // 次のウィンドウへ（さらに過去へ）
    windowEnd = new Date(windowStart);
  }

  // 全ウィンドウを走査した場合もキャッシュに保存
  const check = new Date(today);
  if (!recordedDates.has(todayKey)) {
    check.setDate(check.getDate() - 1);
  }
  let streak = 0;
  while (recordedDates.has(formatDateKey(check))) {
    streak++;
    check.setDate(check.getDate() - 1);
  }

  const lastDate = recordedDates.has(todayKey) ? todayKey : formatDateKey(new Date(today.getTime() - 86400000));
  const startDate = new Date(today);
  if (!recordedDates.has(todayKey)) startDate.setDate(startDate.getDate() - 1);
  startDate.setDate(startDate.getDate() - (streak - 1));
  const startDateKey = formatDateKey(startDate);
  PROPS.setProperty('STREAK_COUNT', String(streak));
  PROPS.setProperty('STREAK_LAST_DATE', lastDate);
  PROPS.setProperty('STREAK_START_DATE', startDateKey);
  PROPS.setProperty('STREAK_TOTAL_DAYS', String(recordedDates.size));
  return { streak: streak, totalDays: recordedDates.size, hasTodayRecord: recordedDates.has(todayKey), startDate: startDateKey };
}

/**
 * /streak コマンド: 連続記録日数を表示（キャッシュベース）
 */
function handleStreakCommand(replyToken) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = formatDateKey(today);
    const yesterdayKey = formatDateKey(new Date(today.getTime() - 86400000));

    let streakCount = PROPS.getProperty('STREAK_COUNT');
    let lastDate = PROPS.getProperty('STREAK_LAST_DATE');
    let startDate = PROPS.getProperty('STREAK_START_DATE') || '';

    // キャッシュが未初期化の場合、フル計算
    if (streakCount === null || lastDate === null) {
      const result = initStreakCache();
      const flexContent = buildStreakFlex(result.streak, result.startDate);
      replyFlexMessage(replyToken, `🔥 連続${result.streak}日`, flexContent, buildCommandQuickReply());
      return;
    }

    streakCount = parseInt(streakCount, 10);

    // キャッシュから現在のstreakを算出
    let currentStreak;

    if (lastDate === todayKey || lastDate === yesterdayKey) {
      // 今日 or 昨日が最後 → streak継続中
      currentStreak = streakCount;
    } else {
      // 2日以上前 → streak途切れ
      currentStreak = 0;
      startDate = '';
    }

    const flexContent = buildStreakFlex(currentStreak, startDate);
    replyFlexMessage(replyToken, `🔥 連続${currentStreak}日`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("streakコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 連続記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

// ============================================================
// Flex Message ビルダー
// ============================================================

/**
 * 日記記録成功時のFlex Message
 */
function buildDiaryRecordFlex(data) {
  const title = data.title || "無題";
  const mood = data.mood || "😐";
  const tags = data.tags || [];

  // タグをピル型ラベルに (空文字除外)
  const validTags = tags.filter(t => t && String(t).trim() !== "");
  const tagComponents = validTags.map(tag => ({
    type: "box",
    layout: "vertical",
    contents: [{ type: "text", text: tag, size: "xs", color: "#FFFFFF", align: "center" }],
    backgroundColor: "#2E7D32",
    cornerRadius: "md",
    paddingAll: "4px",
    paddingStart: "8px",
    paddingEnd: "8px"
  }));

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1B5E20" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "✅ 記録しました", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: title, weight: "bold", size: "lg", wrap: true },
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          alignItems: "center",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: mood, size: "xl", align: "center", gravity: "center" }
              ],
              backgroundColor: "#E8F5E9",
              cornerRadius: "xxl",
              width: "44px",
              height: "44px",
              justifyContent: "center",
              alignItems: "center",
              flex: 0
            },
            {
              type: "box",
              layout: "horizontal",
              spacing: "sm",
              flex: 1,
              contents: tagComponents.length > 0 ? tagComponents : [{ type: "text", text: "タグなし", size: "xs", color: "#999999" }]
            }
          ]
        }
      ]
    }
  };
}

/**
 * /today 今日の記録一覧のFlex Message
 */
function buildTodayFlex(logs) {
  const today = new Date();
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateStr = (today.getMonth() + 1) + '/' + today.getDate() + '(' + dayNames[today.getDay()] + ')';

  const logItems = logs.map(function (log) {
    var tagText = log.tags.length > 0 ? log.tags.join(', ') : '';
    var subText = [log.mood, tagText].filter(Boolean).join('  ');
    return {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            { type: "text", text: log.time, size: "xs", color: "#999999", flex: 0 },
            { type: "text", text: log.title, size: "sm", weight: "bold", wrap: true, flex: 1 }
          ]
        },
        { type: "text", text: subText, size: "xs", color: "#666666", margin: "xs" }
      ]
    };
  });

  var bodyContents = [];
  logItems.forEach(function (item, i) {
    bodyContents.push(item);
    if (i < logItems.length - 1) {
      bodyContents.push({ type: "separator", margin: "md" });
    }
  });

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1B5E20" }
    },
    header: {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: dateStr + " の記録", color: "#FFFFFF", size: "sm", weight: "bold", flex: 1 },
        { type: "text", text: logs.length + "件", color: "#E8F5E9", size: "sm", align: "end", flex: 0 }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents
    }
  };
}

/**
 * /yesterday 昨日の記録一覧のFlex Message
 */
function buildYesterdayFlex(logs) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateStr = (yesterday.getMonth() + 1) + '/' + yesterday.getDate() + '(' + dayNames[yesterday.getDay()] + ')';

  const logItems = logs.map(function (log) {
    var tagText = log.tags.length > 0 ? log.tags.join(', ') : '';
    var subText = [log.mood, tagText].filter(Boolean).join('  ');
    return {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            { type: "text", text: log.time, size: "xs", color: "#999999", flex: 0 },
            { type: "text", text: log.title, size: "sm", weight: "bold", wrap: true, flex: 1 }
          ]
        },
        { type: "text", text: subText, size: "xs", color: "#666666", margin: "xs" }
      ]
    };
  });

  var bodyContents = [];
  logItems.forEach(function (item, i) {
    bodyContents.push(item);
    if (i < logItems.length - 1) {
      bodyContents.push({ type: "separator", margin: "md" });
    }
  });

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1B5E20" }
    },
    header: {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: dateStr + " の記録", color: "#FFFFFF", size: "sm", weight: "bold", flex: 1 },
        { type: "text", text: logs.length + "件", color: "#E8F5E9", size: "sm", align: "end", flex: 0 }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents
    }
  };
}

/**
 * /streak 連続記録のFlex Message
 * @param {number} streak - 連続日数
 * @param {string} startDateKey - 開始日 (YYYY-MM-DD形式)
 */
function buildStreakFlex(streak, startDateKey) {
  // マイルストーン定義
  var milestones = [7, 14, 30, 50, 100, 200, 365, 500, 730, 1000];

  // 現在のstreakがマイルストーン達成中か判定
  var isOnMilestone = milestones.indexOf(streak) !== -1;

  var emoji, message;
  if (streak === 0) {
    emoji = "✍";
    message = "今日から始めましょう！";
  } else if (isOnMilestone) {
    // マイルストーン達成時の特別メッセージ
    if (streak === 7) { emoji = "🎉"; message = "1週間達成！素晴らしいスタート！"; }
    else if (streak === 14) { emoji = "🎊"; message = "2週間達成！習慣が根付いてきました！"; }
    else if (streak === 30) { emoji = "🏅"; message = "1ヶ月達成！立派な習慣です！"; }
    else if (streak === 50) { emoji = "🌟"; message = "50日達成！半端ない継続力！"; }
    else if (streak === 100) { emoji = "💯"; message = "100日達成！圧倒的な意志力！"; }
    else if (streak === 200) { emoji = "👑"; message = "200日達成！記録の達人！"; }
    else if (streak === 365) { emoji = "🎆"; message = "1年達成！伝説の始まりです！"; }
    else if (streak === 500) { emoji = "🏆"; message = "500日達成！もはや生活の一部！"; }
    else if (streak === 730) { emoji = "💎"; message = "2年達成！揺るぎない日課！"; }
    else { emoji = "🏆"; message = "驚異的なマイルストーン達成！"; }
  } else if (streak < 3) {
    emoji = "🌱";
    message = "良いスタートです！";
  } else if (streak < 7) {
    emoji = "🔥";
    message = "絶好調！その調子！";
  } else if (streak < 14) {
    emoji = "⭐";
    message = "素晴らしい習慣です！";
  } else if (streak < 30) {
    emoji = "💎";
    message = "規律的な記録が定着しています！";
  } else {
    emoji = "🏆";
    message = "伝説級の継続力！";
  }

  // 開始日の表示テキスト ("1/23" or "2025/1/23" 形式)
  var startDateText = "—";
  if (startDateKey && streak > 0) {
    var parts = startDateKey.split('-');
    var startYear = parseInt(parts[0], 10);
    var startMonth = parseInt(parts[1], 10);
    var startDay = parseInt(parts[2], 10);
    var currentYear = new Date().getFullYear();
    if (startYear !== currentYear) {
      startDateText = startYear + "/" + startMonth + "/" + startDay;
    } else {
      startDateText = startMonth + "/" + startDay;
    }
  }

  // 次のマイルストーンを計算
  var milestoneText = "—";
  if (streak > 0) {
    var nextMilestone = null;
    for (var i = 0; i < milestones.length; i++) {
      if (milestones[i] > streak) {
        nextMilestone = milestones[i];
        break;
      }
    }
    if (nextMilestone) {
      milestoneText = nextMilestone + "日まで あと" + (nextMilestone - streak) + "日";
    } else {
      milestoneText = "全マイルストーン達成！";
    }
  }

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#E65100" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: emoji + " 連続記録", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "lg",
      contents: [
        { type: "text", text: streak + "日", size: "3xl", weight: "bold", align: "center", color: "#E65100" },
        { type: "text", text: message, size: "sm", align: "center", color: "#666666", wrap: true },
        { type: "separator" },
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "horizontal",
              justifyContent: "center",
              spacing: "sm",
              contents: [
                { type: "text", text: "開始日", size: "xs", color: "#999999", flex: 0, gravity: "center" },
                { type: "text", text: startDateText, size: "sm", weight: "bold", flex: 0 }
              ]
            },
            {
              type: "box",
              layout: "horizontal",
              justifyContent: "center",
              spacing: "sm",
              contents: [
                { type: "text", text: "次の節目", size: "xs", color: "#999999", flex: 0, gravity: "center" },
                { type: "text", text: milestoneText, size: "sm", weight: "bold", flex: 0 }
              ]
            }
          ]
        }
      ]
    }
  };
}

/**
 * /stats 統計カードのFlex Message
 */
function buildStatsFlex(logs) {
  const totalEntries = logs.length;

  // ムード分布
  const moodCounts = {};
  logs.forEach(log => { moodCounts[log.mood] = (moodCounts[log.mood] || 0) + 1; });
  const moodItems = Object.entries(moodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mood, count]) => ({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "filler", flex: 1 },
        { type: "text", text: mood, size: "md", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
      ]
    }));

  // タグ頻度
  const tagCounts = {};
  logs.forEach(log => { log.tags.forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }); });
  const tagItems = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "filler", flex: 1 },
        { type: "text", text: tag, size: "sm", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
      ]
    }));

  // 記録がある日数
  const uniqueDays = new Set(logs.map(log => log.date)).size;

  // 日付範囲を計算
  var dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  var now = new Date();
  var from = new Date();
  from.setDate(from.getDate() - 6);
  var dateRange = (from.getMonth() + 1) + "/" + from.getDate() + "(" + dayNames[from.getDay()] + ") ~ " + (now.getMonth() + 1) + "/" + now.getDate() + "(" + dayNames[now.getDay()] + ")";

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#0D47A1" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "📊 " + dateRange + " の統計", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        // 記録数サマリー
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: String(totalEntries), size: "xxl", weight: "bold", align: "center", color: "#0D47A1" },
                { type: "text", text: "記録数", size: "xs", align: "center", color: "#999999" }
              ],
              flex: 1
            },
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: String(uniqueDays), size: "xxl", weight: "bold", align: "center", color: "#0D47A1" },
                { type: "text", text: "日数", size: "xs", align: "center", color: "#999999" }
              ],
              flex: 1
            }
          ]
        },
        { type: "separator" },
        // ムード分布 & タグ頻度 横並び
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          contents: [
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "ムード", size: "xs", weight: "bold", color: "#333333" },
                ...moodItems
              ]
            },
            { type: "separator" },
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "タグ TOP5", size: "xs", weight: "bold", color: "#333333" },
                ...tagItems
              ]
            }
          ]
        }
      ]
    }
  };
}

/**
 * /help コマンド一覧のFlex Message
 */
function buildHelpFlex() {
  const commands = [
    { cmd: "/today", desc: "今日の記録一覧を表示" },
    { cmd: "/yesterday", desc: "昨日の記録一覧を表示" },
    { cmd: "/stats", desc: "直近7日間の統計を表示" },
    { cmd: "/streak", desc: "連続記録日数を表示" },
    { cmd: "/review", desc: "週次レビューを生成" },
    { cmd: "/monthly", desc: "月次レビューを生成" },
    { cmd: "/onthisday", desc: "過去の今日の記録を表示" },
    { cmd: "/random", desc: "ランダムに日記を表示" },
    { cmd: "/help", desc: "ヘルプを表示" }
  ];

  const cmdComponents = commands.map(c => ({
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [
      {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: c.cmd, size: "sm", weight: "bold", color: "#1B5E20" }],
        flex: 2
      },
      {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: c.desc, size: "sm", color: "#666666", wrap: true }],
        flex: 4
      }
    ],
    margin: "md"
  }));

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1B5E20" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "📖 コマンド一覧", color: "#FFFFFF", size: "md", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        ...cmdComponents
      ]
    }
  };
}

/**
 * 不明なコマンド時のFlex Message
 */
function buildUnknownCommandFlex(cmd) {
  return {
    type: "bubble",
    styles: {
      header: { backgroundColor: "#E65100" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "⚠️ 不明なコマンド", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `「${cmd}」は登録されていないコマンドです。`, size: "sm", wrap: true },
        { type: "text", text: "/help で利用可能なコマンドを確認できます。", size: "sm", color: "#666666", wrap: true, margin: "md" }
      ]
    }
  };
}

// ============================================================
// 週次レビュー プロンプト生成
// ============================================================

/**
 * 月次レビューのトリガーエントリーポイント
 * 毎日実行され、月末（明日が1日）のみ sendMonthlyReview を実行する
 * GASトリガーにはこの関数を「日ベース」で設定する
 */
function checkAndSendMonthlyReview() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getDate() === 1) {
    // 明日が1日 = 今日が月末
    sendMonthlyReview();
  }
}

/**
 * 月次レビューを生成・送信する
 * 当月の1日から月末（実行時点）までを対象とする
 */
function sendMonthlyReview() {
  if (!LINE_USER_ID) {
    console.log("LINE_USER_ID未設定のため月次レビューをスキップします");
    return;
  }

  // 対象範囲: 当月1日〜現在
  const now = new Date();
  const targetMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const targetMonthEnd = now;

  // 1. 蓄積された週次レビューを取得し、当月のもののみフィルタ
  const allWeeklyReviews = getWeeklyReviewHistory();
  const weeklyReviews = filterReviewsByMonth(allWeeklyReviews, targetMonthStart, targetMonthEnd);

  // 2. 当月のログメタデータを取得（本文は省略してトークン節約）
  const logs = fetchMonthlyLogsFromNotion(targetMonthStart, targetMonthEnd);
  if (logs.length === 0 && weeklyReviews.length === 0) {
    pushLineMessage("今月は日記の記録と週次レビューの蓄積がありませんでした。来月は記録してみましょう！📓");
    return;
  }

  // 3. コンテキスト作成
  const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
  const lastMonthlyReview = getLastMonthlyReview();
  const stats = buildLogStatistics(logs);
  const targetYearMonth = targetMonthStart.getFullYear() + "年" + (targetMonthStart.getMonth() + 1) + "月";

  // 3-b. 月末の未レビュー日の日記本文を補完取得
  const supplementLogs = fetchMonthEndSupplementLogs(weeklyReviews, logs, targetMonthEnd);

  const prompt = buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, targetYearMonth, supplementLogs);

  // 4. Geminiでレビュー生成
  let reviewText = "";
  let errorLog = "";

  for (const model of MODEL_CANDIDATES) {
    try {
      reviewText = callGeminiForText(prompt, model);
      break;
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }

  if (reviewText) {
    // レビューテキスト + 月間統計カードを同時送信
    const LINE_TEXT_LIMIT = 5000;
    const header = "📆 【" + targetYearMonth + " 月次レビュー】\n\n";
    const safeReview = reviewText.length > (LINE_TEXT_LIMIT - header.length - 20)
      ? reviewText.substring(0, LINE_TEXT_LIMIT - header.length - 20) + "\n\n…（以下省略）"
      : reviewText;

    const statsMsg = { type: 'flex', altText: '📊 ' + targetYearMonth + 'の統計', contents: buildMonthlyStatsFlex(logs, targetMonthStart, targetMonthEnd) };
    statsMsg.quickReply = buildCommandQuickReply();
    const messages = [
      { type: 'text', text: header + safeReview },
      statsMsg
    ];
    pushMessages(messages);
    saveLastMonthlyReview(reviewText);

    // 5. 月次レビュー送信後、週次レビュー蓄積をクリア（次月に持ち越さない）
    PROPS.setProperty('WEEKLY_REVIEW_HISTORY', '[]');
  } else {
    pushLineMessage("月次レビューの生成に失敗しました。\n" + errorLog);
  }
}

/**
 * Notionから指定期間のログメタデータを取得（本文省略版）
 * @param {Date} monthStart - 対象月の初日
 * @param {Date} monthEnd - 対象月の末日
 */
function fetchMonthlyLogsFromNotion(monthStart, monthEnd) {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;

  const basePayload = {
    filter: {
      and: [
        { timestamp: "created_time", created_time: { on_or_after: monthStart.toISOString() } },
        { timestamp: "created_time", created_time: { on_or_before: monthEnd.toISOString() } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  };

  // ページネーション対応
  let allResults = [];
  let hasMore = true;
  let nextCursor = undefined;

  while (hasMore) {
    const payload = { ...basePayload };
    if (nextCursor) payload.start_cursor = nextCursor;

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      console.error(`Notion月次データ取得エラー (${code}): ${response.getContentText().substring(0, 200)}`);
      break;
    }

    const data = JSON.parse(response.getContentText());
    allResults = allResults.concat(data.results || []);
    hasMore = data.has_more === true;
    nextCursor = data.next_cursor;
  }

  // 本文は取得しない（トークン節約・API呼び出し削減）
  return allResults.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明",
      tags: tags,
      body: "" // 月次では本文を省略
    };
  });
}

/**
 * 月末の未レビュー日の日記本文を補完取得する
 * 週次レビューの最終日以降のエントリの本文を取得し、月末の情報量を補う
 * @param {Array} weeklyReviews - フィルタ済み週次レビュー
 * @param {Array} logs - 全月間ログ（本文なし）
 * @param {Date} monthEnd - 対象月の末日
 * @returns {Array} 本文付きの補完ログ
 */
function fetchMonthEndSupplementLogs(weeklyReviews, logs, monthEnd) {
  if (weeklyReviews.length === 0) return []; // レビューがない場合は補完不要

  // 最後の週次レビューの日付を取得
  const lastReviewDate = new Date(weeklyReviews[weeklyReviews.length - 1].date);
  if (isNaN(lastReviewDate.getTime())) return [];

  // 最終レビュー日の翌日から月末までを補完対象とする
  const supplementStart = new Date(lastReviewDate);
  supplementStart.setDate(supplementStart.getDate() + 1);
  supplementStart.setHours(0, 0, 0, 0);

  // 補完対象の日付があるかチェック
  const supplementEntries = logs.filter(log => {
    const d = new Date(log.date);
    return !isNaN(d.getTime()) && d >= supplementStart;
  });

  if (supplementEntries.length === 0) return [];

  // Notion APIで補完対象期間のページを再取得（本文付き）
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      filter: {
        and: [
          { timestamp: "created_time", created_time: { on_or_after: supplementStart.toISOString() } },
          { timestamp: "created_time", created_time: { on_or_before: monthEnd.toISOString() } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.error("月末補完データ取得エラー");
    return [];
  }

  const data = JSON.parse(response.getContentText());
  return (data.results || []).map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const body = fetchPageBodyText(page.id);
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明",
      tags: tags,
      body: body
    };
  });
}

/**
 * 月間統計のFlex Message（深紫テーマで週次と視覚的に区別）
 * @param {Array} logs - 月間ログ
 * @param {Date} monthStart - 対象月の初日
 * @param {Date} monthEnd - 対象月の末日
 */
function buildMonthlyStatsFlex(logs, monthStart, monthEnd) {
  const totalEntries = logs.length;

  // ムード分布
  const moodCounts = {};
  logs.forEach(log => { moodCounts[log.mood] = (moodCounts[log.mood] || 0) + 1; });
  const moodItems = Object.entries(moodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mood, count]) => ({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "filler", flex: 1 },
        { type: "text", text: mood, size: "md", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
      ]
    }));

  // タグ頻度
  const tagCounts = {};
  logs.forEach(log => { log.tags.forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }); });
  const tagItems = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "filler", flex: 1 },
        { type: "text", text: tag, size: "sm", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
      ]
    }));

  // 記録がある日数
  const uniqueDays = new Set(logs.map(log => log.date)).size;

  // カレンダー月の日付範囲を表示
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateRange = (monthStart.getMonth() + 1) + "/" + monthStart.getDate() + "(" + dayNames[monthStart.getDay()] + ") ~ " + (monthEnd.getMonth() + 1) + "/" + monthEnd.getDate() + "(" + dayNames[monthEnd.getDay()] + ")";

  // 記録率（対象月の実際の日数で計算）
  const daysInMonth = monthEnd.getDate();
  const recordRate = Math.round((uniqueDays / daysInMonth) * 100);

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#4A148C" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "📊 " + dateRange + " の月間統計", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        // 記録数サマリー（3カラム: 記録数・日数・記録率）
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: String(totalEntries), size: "xxl", weight: "bold", align: "center", color: "#4A148C" },
                { type: "text", text: "記録数", size: "xs", align: "center", color: "#999999" }
              ],
              flex: 1
            },
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: String(uniqueDays), size: "xxl", weight: "bold", align: "center", color: "#4A148C" },
                { type: "text", text: "日数", size: "xs", align: "center", color: "#999999" }
              ],
              flex: 1
            },
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: recordRate + "%", size: "xxl", weight: "bold", align: "center", color: "#4A148C" },
                { type: "text", text: "記録率", size: "xs", align: "center", color: "#999999" }
              ],
              flex: 1
            }
          ]
        },
        { type: "separator" },
        // ムード分布 & タグ頻度 横並び
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          contents: [
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "ムード", size: "xs", weight: "bold", color: "#333333" },
                ...moodItems
              ]
            },
            { type: "separator" },
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "タグ TOP5", size: "xs", weight: "bold", color: "#333333" },
                ...tagItems
              ]
            }
          ]
        }
      ]
    }
  };
}

/**
 * 週次レビューのプロンプトを組み立てる (sendWeeklyReview / /review コマンド 共通)
 */
function buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs) {
  let prompt = `あなたはユーザーの成長を見守る「パーソナル心理メンター」です。
以下の心理学フレームワークに基づき、表面的な要約ではなく、ユーザーの行動パターンや心理的欲求に踏み込んだ週次レビューを作成してください。

【👤 ユーザー情報（内部参照用）】
※この情報はログの行動パターンを正しく解釈するための背景知識として使用すること。
※出力でプロフィール内容に直接言及しないこと（「理系のあなたは〜」「研究者として〜」のような表現は禁止）。
${userProfile}

【🧠 分析に使う心理学フレームワーク（内部参照用・出力には含めないこと）】

■ 自己決定理論 (SDT: Deci & Ryan)
以下の3つの基本的心理欲求の充足度をログから読み取ること。
- 自律性: 自分の意志で選択・行動できていたか（やらされ仕事 vs 自発的活動）
- 有能感: 「できた」「成長した」と感じられる出来事があったか
- 関係性: 人とのつながりや協力を感じる場面があったか
→ 欠けている欲求があれば、それを自然に満たせる行動を提案する

■ ポジティブ心理学 (Seligman: PERMA)
- 日記ログの中から「強み (Signature Strengths)」の発揮を見つけ、言語化する
- 「Three Good Things」の視点: 小さくてもポジティブな出来事を拾い上げ、その意味を深掘りする
- 重要: 「頑張ったね」のような漠然とした褒めではなく、「○○という行動は、あなたの△△という強みの表れです」のように具体化する

■ 成長マインドセット (Dweck)
- 結果ではなく「プロセス」と「戦略」を称賛する（プロセス・プレイズ）
  例: ×「成功してすごい」 → ○「新しいアプローチを試したこと自体が成長」
- 困難やネガティブな出来事は「学習機会」として肯定的にリフレーミングする
- ただし無理なポジティブ転換（Toxic Positivity）は厳禁。辛さを認めた上で意味づけする

■ 認知行動療法 (CBT) の視点
- 気分の推移パターンから「認知の歪み」の兆候を読み取る（全か無か思考、過度の一般化など）
- 気分が低下した日の前後関係から、トリガーとなる行動や状況を推測する
- 自動思考の修正ではなく、気づきを促す問いかけの形で伝える

【🚫 やってはいけないこと】
- フレームワーク名（SDT、PERMA、CBTなど）を出力に含めない。専門用語ではなく日常的な言葉で語ること
- 全セクションを均等に書かない。今週特に目立つテーマに重点を置き、メリハリをつけること
- 「頑張りましたね」「素晴らしいですね」など漠然とした褒め言葉は禁止。必ず具体的な行動を引用すること
- 日記に書かれていない事実を捏造しない。推測する場合は「もしかすると〜かもしれません」と明示すること
- **太字**、*斜体*、# 見出し、- リストなどMarkdown記法は一切使用禁止。LINEはMarkdown非対応のため、そのまま記号が表示されてしまう。強調したい場合は「」や【】で囲むこと

【📝 出力ルール】
- 全体で500〜700文字程度（LINEで読みやすい長さ）
- Markdown記法（**太字**など）は使用禁止。見出しは【 】と絵文字で表現
- 語りかける二人称「あなた」を使い、温かみのある口調で
- 分析の根拠を必ず日記ログの具体的内容に紐づけること（エビデンスベースド）

【📊 レビュー構成（この順序で出力）】

1. 🏆 今週のあなたの強み
   - ログから読み取れる「強みが発揮された瞬間」を1〜2個ピックアップ
   - 今週最も充実していた心理欲求（自律性・有能感・関係性）に日常語で触れる
   - 結果ではなく行動・姿勢を評価する

2. 🔄 気分と行動のパターン分析
   - ムード推移を時系列で読み取り、傾向を1〜2文で要約
   - 気分が上向いた日・下がった日の行動との相関を指摘（例: 「運動した日は気分が高い」）
   - もし認知の偏りが見られたら「〜と感じたのかもしれませんが、別の見方もできそうです」のように柔らかく問いかける

3. 💡 来週の「小さな実験」
   - 今週不足していた心理欲求を自然に満たせる、具体的で小さなアクション1つ
   - 「実験」というフレーミングで心理的ハードルを下げる（失敗OK）
   - 例: 「来週は1日だけ、研究の合間に10分散歩を入れてみてください」

4. 📝 一言メモ（任意）
   - 特に気になるパターンや、長期的に観察すべき傾向があれば一言添える
   - なければ省略可
`;

  // 前回レビューがあれば追加
  if (lastReview) {
    prompt += `\n【📌 前回の週次レビュー（参考）】\n以下は先週のレビュー内容です。先週提案した「小さな実験」が実行されたか、先週の課題が改善されたか、といった連続性を意識してください。\n${lastReview}\n`;
  }

  // 統計サマリー
  prompt += `\n【📈 今週の統計サマリー】\n${stats}\n`;

  // Few-shot例
  prompt += `\n【✏️ 出力例（このレベルの具体性で書くこと）】

🏆 今週のあなたの強み
火曜の「シミュレーション結果が合わなくてアプローチを変えた」という記録が印象的です。うまくいかないときに粘り強く別の方法を試すのは、あなたの探究心と柔軟さの表れです。また、木曜に自発的にGASの開発に取り組んでいたことから、自分で選んで動く力が今週は特に活きていました。

🔄 気分と行動のパターン分析
週前半は😊が続いていましたが、水曜の深夜作業の翌日に😰へ下がっています。睡眠時間と気分に関連があるかもしれません。金曜に筋トレをした後に再び😊に戻っており、体を動かすことがリセットになっている可能性があります。

💡 来週の小さな実験
今週は一人で集中する時間が多かったようです。来週は1日だけ、研究室の誰かとランチに行ってみてください。人とのつながりの時間が、思わぬリフレッシュになるかもしれません。

（例ここまで。上記はあくまで形式の参考です。実際のログ内容に基づいて書いてください）\n`;

  // 日記ログ
  prompt += `\n【日記ログ】\n`;
  logs.forEach(log => {
    prompt += `---\n[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")}\nタイトル: ${log.title}\n本文: ${log.body}\n`;
  });

  return prompt;
}

/**
 * 月次レビューのプロンプトを組み立てる (sendMonthlyReview / /monthly コマンド 共通)
 * 週次レビューの蓄積を主要な入力とし、月間ログのメタデータで補完する
 */
function buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, yearMonth, supplementLogs) {
  // yearMonthは呼び出し元から渡される（例: "2026年1月"）
  // supplementLogsは月末の未レビュー日の日記本文（補完用）

  let prompt = `あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。
以下のフレームワークと情報に基づき、この1ヶ月間を深く振り返る月次レビューを作成してください。
週次レビューが「1週間のスナップショット」であるのに対し、月次レビューは「1ヶ月の物語」です。
点と点をつなぎ、本人も気づいていない変化の流れを浮かび上がらせてください。

【👤 ユーザー情報（内部参照用）】
※この情報はログの行動パターンを正しく解釈するための背景知識として使用すること。
※出力でプロフィール内容に直接言及しないこと（「理系のあなたは〜」「研究者として〜」のような表現は禁止）。
${userProfile}

【🧠 月次レビュー用 分析フレームワーク（内部参照用・出力には含めないこと）】

■ ナラティブ・アイデンティティ（McAdams）
- 週次レビューの蓄積を「1ヶ月の物語」として読み解く
- 月の前半と後半で語り口や行動パターンに変化があったか
- ユーザーの「自分はこういう人間だ」という自己物語がどう表れているか
- 成長や変化を「物語の転換点」として捉え、言語化する

■ 自己決定理論 (SDT: Deci & Ryan) ── 月間スケールで
- 自律性・有能感・関係性の3つの心理欲求について、月全体での充足パターンを読む
- 週によって充足度に波がある場合、その波の原因（環境変化、プロジェクトの節目など）を推測する
- 月間を通じて慢性的に不足している欲求があれば、構造的な改善を提案する

■ ポジティブ心理学 (Seligman: PERMA) ── 強みの進化
- 1ヶ月の中で「繰り返し発揮されている強み」を特定する
- 月の前半と後半で強みの使い方に変化や深まりがあったかを検出する
- 新しく芽生えた強みや、まだ十分に活かされていない潜在的な強みに注目する

■ 習慣形成理論 (Clear: Atomic Habits)
- 記録の頻度パターンから習慣の定着度を読み取る
- 「習慣スタッキング」の兆候（ある行動が別の行動を自然に引き起こしている）を発見する
- 習慣が途切れた時期がある場合、その前後の状況からトリガーと障壁を推測する

■ フロー理論 (Csikszentmihalyi)
- タグやムードのパターンから、ユーザーが「没頭していた」と推測される活動を特定する
- スキルとチャレンジのバランスが取れていた時期・崩れていた時期を読み取る
- フロー状態に入りやすい条件（時間帯、前後の活動、環境）を推測する

■ 認知行動療法 (CBT) ── 長期パターン
- 1ヶ月のムード推移から、週次レビューでは見えなかった長期的な認知パターンを検出する
- 特定の曜日や週に気分が下がりやすいパターンがないか確認する
- 「思考の癖」が繰り返し現れている場合、それに気づかせる問いかけをする

【🚫 やってはいけないこと】
- フレームワーク名（SDT、PERMA、CBT、ナラティブなど）を出力に含めない。専門用語ではなく日常的な言葉で語ること
- 全セクションを均等に書かない。今月特に顕著だったテーマに重点を置き、メリハリをつけること
- 「頑張りましたね」「素晴らしいですね」「充実した1ヶ月でしたね」など漠然とした褒め言葉は禁止。具体的な行動や変化に言及すること
- 週次レビューに書かれていない事実を捏造しない。推測する場合は「もしかすると〜かもしれません」と明示すること
- 週次レビューの内容を単に並べ直すだけの要約にしない。週を横断して初めて見える「パターン」や「変化の流れ」を発見すること
- **太字**、*斜体*、# 見出し、- リストなどMarkdown記法は一切使用禁止。LINEはMarkdown非対応のため、そのまま記号が表示されてしまう。強調したい場合は「」や【】で囲むこと

【📝 出力ルール】
- 全体で700〜1000文字程度（月次レビューなのでやや長め。ただしLINEで読みきれる分量）
- Markdown記法（**太字**など）は使用禁止。見出しは【 】と絵文字で表現
- 語りかける二人称「あなた」を使い、温かみのある口調で
- 週次レビューの引用は「第○週のレビューで触れた〜」のように自然に織り込むこと
- 分析の根拠を必ずデータに紐づけること（エビデンスベースド）

【📊 月次レビュー構成（この順序で出力）】

1. 📆 ${yearMonth}の振り返り
   - この1ヶ月を一言で表すなら何か（キャッチフレーズ的な導入文を1行）
   - 月の全体像を2〜3文で俯瞰する。前半と後半で雰囲気の違いがあれば触れる

2. 🏆 今月発見された「あなたの強み」
   - 複数週にわたって繰り返し発揮された強みを1〜2個ピックアップ
   - 先月と比べて強みの使い方に変化や深まりがあれば言及する
   - 結果ではなく行動パターンや姿勢を評価する

3. 📈 1ヶ月のリズムとパターン
   - ムード推移の全体的な傾向（上向き傾向、波がある、安定しているなど）
   - 特定の活動や習慣と気分の相関で、月間データから初めて見えるもの
   - 記録の頻度パターンから読み取れる生活リズムの安定度

4. 🔄 繰り返し現れたテーマ
   - 複数の週次レビューで共通して登場したキーワード、課題、または成長テーマ
   - 月初に出ていた課題が月末までにどう変化（解決・継続・深化）したか
   - まだ解決されていない「持ち越し課題」があれば率直に指摘する

5. 🎯 来月への提案
   - 今月のパターンから導き出された、来月に試してほしい具体的なアクション1〜2個
   - 「続けるべきこと」と「変えてみること」をそれぞれ1つずつ
   - 実行しやすい粒度（いつ、何を、どのくらい）で提案する
`;

  // 前回の月次レビューがあれば追加
  if (lastMonthlyReview) {
    prompt += `\n【📌 前回の月次レビュー（参考）】\n以下は先月の月次レビュー内容です。先月提案した行動が実行されたか、先月の課題が改善されたか、といった月をまたいだ連続性を意識してください。\n${lastMonthlyReview}\n`;
  }

  // 月間統計サマリー
  prompt += `\n【📈 今月の統計サマリー】\n${stats}\n`;

  // 蓄積された週次レビュー
  if (weeklyReviews.length > 0) {
    prompt += `\n【📋 蓄積された週次レビュー（${weeklyReviews.length}件）】\nこれが月次レビューの最も重要な入力です。各週のレビュー内容を横断的に分析し、週を超えて見えるパターンや変化の流れを発見してください。\n※注意: 週次レビューは7日間単位で生成されるため、月初・月末付近のレビューには前月または翌月の数日分の内容が含まれている場合があります。${yearMonth}の内容に重点を置いて分析してください。\n`;
    weeklyReviews.forEach((review, i) => {
      prompt += `\n--- 第${i + 1}週 (${review.date}) ---\n${review.text}\n`;
    });
  } else {
    prompt += `\n【📋 週次レビューの蓄積】\n蓄積された週次レビューはありません。以下の日記ログのメタデータのみから分析してください。\n`;
  }

  // 日記ログのメタデータ
  prompt += `\n【日記ログメタデータ（${yearMonth}）】\n※基本的に本文は省略されています。タイトル・ムード・タグの推移パターンを分析に活用してください。\n`;
  logs.forEach(log => {
    prompt += `[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")} タイトル:${log.title}\n`;
  });

  // 月末補完ログ（本文付き）
  if (supplementLogs && supplementLogs.length > 0) {
    prompt += `\n【📝 月末の補完データ（本文付き）】\n以下は最後の週次レビュー以降の日記です。週次レビューでカバーされていないため、本文を含めて提供します。月末の分析に特に活用してください。\n`;
    supplementLogs.forEach(log => {
      prompt += `---\n[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")}\nタイトル: ${log.title}\n本文: ${log.body}\n`;
    });
  }

  return prompt;
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * ★改善4: 必須スクリプトプロパティのバリデーション
 */
function validateRequiredProps() {
  const required = ['LINE_TOKEN', 'NOTION_TOKEN', 'NOTION_DB_ID', 'GEMINI_API_KEY', 'DRIVE_FOLDER_ID'];
  return required.filter(key => !PROPS.getProperty(key));
}

/**
 * 前回の週次レビューを保存
 */
function saveLastReview(text) {
  // 長すぎる場合は切り詰め（PropertiesServiceの制限: 1値9KB）
  const safeText = (text || "").substring(0, 2000);
  PROPS.setProperty('LAST_WEEKLY_REVIEW', safeText);

  // 月次レビュー用: 直近5件の週次レビューを蓄積
  const history = JSON.parse(PROPS.getProperty('WEEKLY_REVIEW_HISTORY') || '[]');
  history.push({
    date: new Date().toLocaleDateString("ja-JP"),
    text: (text || "").substring(0, 1500)
  });
  // 直近5件のみ保持
  while (history.length > 5) history.shift();
  PROPS.setProperty('WEEKLY_REVIEW_HISTORY', JSON.stringify(history));
}

/**
 * 前回の週次レビューを取得
 */
function getLastReview() {
  return PROPS.getProperty('LAST_WEEKLY_REVIEW') || "";
}

/**
 * 蓄積された週次レビュー履歴を取得
 * @returns {Array<{date: string, text: string}>}
 */
function getWeeklyReviewHistory() {
  return JSON.parse(PROPS.getProperty('WEEKLY_REVIEW_HISTORY') || '[]');
}

/**
 * 週次レビュー配列を対象月でフィルタリングする
 * @param {Array<{date: string, text: string}>} reviews - 全週次レビュー
 * @param {Date} monthStart - 対象月の初日
 * @param {Date} monthEnd - 対象月の末日
 * @returns {Array<{date: string, text: string}>} 対象月に該当するレビューのみ
 */
function filterReviewsByMonth(reviews, monthStart, monthEnd) {
  return reviews.filter(review => {
    const d = new Date(review.date);
    return !isNaN(d.getTime()) && d >= monthStart && d <= monthEnd;
  });
}

/**
 * 前回の月次レビューを保存
 */
function saveLastMonthlyReview(text) {
  const safeText = (text || "").substring(0, 2000);
  PROPS.setProperty('LAST_MONTHLY_REVIEW', safeText);
}

/**
 * 前回の月次レビューを取得
 */
function getLastMonthlyReview() {
  return PROPS.getProperty('LAST_MONTHLY_REVIEW') || "";
}

/**
 * ログから統計サマリーを生成
 */
function buildLogStatistics(logs) {
  const totalEntries = logs.length;

  // ムード分布
  const moodCounts = {};
  logs.forEach(log => {
    moodCounts[log.mood] = (moodCounts[log.mood] || 0) + 1;
  });
  const moodSummary = Object.entries(moodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mood, count]) => `${mood}×${count}`)
    .join(", ");

  // タグ頻度
  const tagCounts = {};
  logs.forEach(log => {
    log.tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  const tagSummary = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => `${tag}(${count})`)
    .join(", ");

  // 曜日分布
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const dayCounts = {};
  logs.forEach(log => {
    // log.dateは "2026/2/10" のような形式
    const d = new Date(log.date);
    if (!isNaN(d.getTime())) {
      const dayName = dayNames[d.getDay()];
      dayCounts[dayName] = (dayCounts[dayName] || 0) + 1;
    }
  });
  const daySummary = Object.entries(dayCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([day, count]) => `${day}曜(${count})`)
    .join(", ");

  return `記録数: ${totalEntries}件\nムード分布: ${moodSummary}\nタグ頻度: ${tagSummary}\n記録曜日: ${daySummary}`;
}

// ============================================================
// ▼ 以下拡張機能: 過去振り返り機能 (/onthisday, /random)
// ============================================================

/**
 * /onthisday コマンド: 過去の今日の日記を表示
 */
function handleOnThisDayCommand(replyToken) {
  try {
    const today = new Date();
    const month = today.getMonth();
    const date = today.getDate();

    // 過去5年分を検索
    let messages = [];

    // 1年前〜5年前
    for (let i = 1; i <= 5; i++) {
      const targetYear = today.getFullYear() - i;
      const targetDate = new Date(targetYear, month, date);
      const logs = fetchLogsByDate(targetDate);

      if (logs.length > 0) {
        logs.forEach(log => {
          const label = `${i}年前の今日`;
          // Flex Messageを作成
          const flexContents = buildPastLogFlex(log, label);
          messages.push({
            type: "flex",
            altText: `📅 ${label} の記録`,
            contents: flexContents
          });
        });
      }
    }

    if (messages.length === 0) {
      replyLineMessage(replyToken, "📅 過去の同じ日の記録は見つかりませんでした。", buildCommandQuickReply());
    } else {
      // 最大5通までしか送れないため制限
      if (messages.length > 5) {
        messages = messages.slice(0, 5);
      }

      // QuickReplyを最後のメッセージに付与
      messages[messages.length - 1].quickReply = buildCommandQuickReply();

      // 複数メッセージ送信用の専用関数が必要だが、replyLineMessage等では単発しか送れないため
      // ここで汎用のreplyMessages関数を呼ぶ（下で定義）
      replyMessages(replyToken, messages);
    }
  } catch (e) {
    console.error("onthisday command error:", e);
    replyLineMessage(replyToken, "⚠️ エラーが発生しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /random コマンド: ランダムな過去の日記を表示
 */
function handleRandomCommand(replyToken) {
  try {
    // 全期間からランダムに1件取得
    // ※ランダム日付生成だと記録がない日にヒットする確率が高いため、
    //   一度全件の日付リスト（ID含む）を取得してからランダムに選択する方式に変更
    const allLogs = fetchAllLogDates();

    if (allLogs.length === 0) {
      replyLineMessage(replyToken, "🎲 記録が1件もありません。まずは日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }

    // ランダムに1件選択
    const randomLogMeta = allLogs[Math.floor(Math.random() * allLogs.length)];

    // 選択されたログの詳細（本文含む）を取得
    // ※fetchAllLogDatesはメタデータのみのため、詳細取得が必要
    const details = fetchLogDetails(randomLogMeta.id);
    if (!details) {
      replyLineMessage(replyToken, "🎲 日記ガチャ失敗… 記録が見つかりませんでした。", buildCommandQuickReply());
      return;
    }

    const dateStr = details.date; // 既にフォーマット済み
    const label = `🎲 ${dateStr} の記録`;

    replyFlexMessage(replyToken, label, buildPastLogFlex(details, "🎲 日記ガチャ"), buildCommandQuickReply());

  } catch (e) {
    console.error("random command error:", e);
    replyLineMessage(replyToken, "⚠️ エラーが発生しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * 全期間のログの日付とIDを取得（軽量版）
 * @returns {Array<{id: string, date: string}>}
 */
function fetchAllLogDates() {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  let allResults = [];
  let hasMore = true;
  let nextCursor = undefined;

  // 全件取得（IDと作成日時のみ必要なため、プロパティフィルタはかけないが、
  // ペイロードを軽く制限したかったがNotion APIはプロパティ指定取得不可。
  // 全プロパティが返ってくるが仕方ない）

  while (hasMore) {
    const payload = {
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 100 // 最大取得数
    };
    if (nextCursor) payload.start_cursor = nextCursor;

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) break;

    const data = JSON.parse(response.getContentText());
    if (data.results) {
      data.results.forEach(page => {
        allResults.push({
          id: page.id,
          date: new Date(page.created_time).toLocaleDateString("ja-JP")
        });
      });
    }
    hasMore = data.has_more;
    nextCursor = data.next_cursor;
  }

  return allResults;
}

/**
 * 指定IDのログ詳細を取得
 */
function fetchLogDetails(pageId) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) return null;

  const page = JSON.parse(response.getContentText());
  const props = page.properties;
  const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
  const body = fetchPageBodyText(page.id); // 本文も取得
  const d = new Date(page.created_time);

  return {
    date: d.toLocaleDateString("ja-JP"),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    title: props["Name"]?.title?.[0]?.plain_text || "無題",
    mood: props["Mood"]?.select?.name || "😐",
    tags: tags,
    body: body
  };
}


/**
 * 指定した日付（1日分）のログを取得
 * @param {Date} targetDate
 * @returns {Array} ログ配列
 */
function fetchLogsByDate(targetDate) {
  const start = new Date(targetDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(targetDate);
  end.setHours(23, 59, 59, 999);

  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const payload = {
    filter: {
      and: [
        { timestamp: "created_time", created_time: { on_or_after: start.toISOString() } },
        { timestamp: "created_time", created_time: { on_or_before: end.toISOString() } }
      ]
    }
  };

  // エラーハンドリングは呼び出し元で行う前提
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.error(`Notion data fetch error (${targetDate}): ${response.getContentText()}`);
    return [];
  }

  const data = JSON.parse(response.getContentText());
  return (data.results || []).map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const body = fetchPageBodyText(page.id); // 本文も取得
    const d = new Date(page.created_time);
    return {
      date: d.toLocaleDateString("ja-JP"),
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "😐",
      tags: tags,
      body: body
    };
  });
}

/**
 * 指定範囲内のランダムな日付を生成
 */
function getRandomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

/**
 * 過去ログ表示用 Flex Message ビルダー
 * @param {Object} log - ログデータ
 * @param {String} headerLabel - ヘッダーに表示するテキスト（例: "1年前の今日"）
 */
function buildPastLogFlex(log, headerLabel) {
  // カラーパレット: 過去ログは少し落ち着いた色（Indigo系）
  const HEADER_COLOR = "#3949AB";

  const tags = log.tags || [];
  const validTags = tags.filter(t => t && String(t).trim() !== "");
  const tagComponents = validTags.map(tag => ({
    type: "box",
    layout: "vertical",
    contents: [{ type: "text", text: tag, size: "xs", color: "#FFFFFF", align: "center" }],
    backgroundColor: "#5C6BC0", // 少し明るめのIndigo
    cornerRadius: "md",
    paddingAll: "4px",
    paddingStart: "8px",
    paddingEnd: "8px"
  }));

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: HEADER_COLOR }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: headerLabel, color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `${log.date} ${log.time || ""}`, size: "xs", color: "#999999" }, // 日付と時間を表示
        { type: "text", text: log.title, weight: "bold", size: "lg", wrap: true },
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          alignItems: "center",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: log.mood, size: "xl", align: "center", gravity: "center" }
              ],
              backgroundColor: "#E8EAF6", // 薄いIndigo
              cornerRadius: "xxl",
              width: "44px",
              height: "44px",
              justifyContent: "center",
              alignItems: "center",
              flex: 0
            },
            {
              type: "box",
              layout: "horizontal",
              spacing: "sm",
              flex: 1,
              contents: tagComponents.length > 0 ? tagComponents : [{ type: "text", text: "タグなし", size: "xs", color: "#999999" }]
            }
          ]
        },
        { type: "separator", margin: "md" },
        {
          type: "text",
          text: (log.body || "本文なし").substring(0, 100) + (log.body && log.body.length > 100 ? "..." : ""),
          size: "sm",
          color: "#666666",
          wrap: true,
          margin: "md"
        }
      ]
    }
  };
}

/**
 * 汎用: 複数メッセージを返信する関数
 */
function replyMessages(replyToken, messages) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`LINE Reply Error: ${response.getContentText()}`);
  }
}