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

const TAGS = ["研究", "開発", "健康", "勉強", "レビュー", "資産", "購入", "恋愛", "食事", "写真", "その他"];
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
    // Notion保存成功をFlex Messageで返信
    if (replyToken) {
      const flexContent = buildDiaryRecordFlex(result.data);
      replyFlexMessage(replyToken, "✅ 記録しました: " + (result.data.title || "無題"), flexContent);
    }
  } else {
    // 失敗時
    saveToNotion(
      { title: "📷 写真日記", mood: "😐", tags: ["その他"] },
      `⚠️ AI解析失敗\n\n【エラー】\n${result.error}\n\n【原文】\n${text}`,
      imageUrl
    );
    if (replyToken) {
      replyLineMessage(replyToken, "⚠️ AI解析に失敗しましたが、原文をNotionに保存しました");
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

【タグの定義と使い分け】
- 研究: 大学での研究活動全般。回路設計、実測、シミュレーション、論文執筆など。
- 開発: プライベートで行う開発。Bot作成、GAS、プログラミング、アプリ開発など。
- 健康: 身体と心のメンテナンス。筋トレ、睡眠、体調管理、手術など。
- 勉強: 知識インプット活動。大学の講義、資格試験、英語学習。
- レビュー: モノや体験に対する「感想」「評価」。本やライブの感想，製品の感想，食事の感想など。
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
- 食事をして、その味や店の感想を述べている場合は ["食事", "レビュー"] の両方を付けること。
- "その他" タグは、他に該当するタグが1つもない場合にのみ使用すること。他のタグと "その他" を同時に付けてはいけない。

【入出力例】

入力: 「卒論の比較表を作り直す。終わったらどっかご飯食べに行く？」
出力: {"title": "卒論の比較表修正", "mood": "😐", "tags": ["研究"]}
理由: ご飯は質問/予定であり記録ではないためタグ不要

入力: 「新しいラーメン屋行ったけど味噌が濃すぎた。まあまあかな」
出力: {"title": "新しいラーメン屋の感想", "mood": "😐", "tags": ["食事", "レビュー"]}
理由: 食事の記録+味の感想があるため両方

入力: 「AirPods届いた！音質めっちゃいい」
出力: {"title": "AirPods開封レビュー", "mood": "🤩", "tags": ["購入", "レビュー"]}
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
    pushLineMessage("📅 【週次レビュー】\n\n" + reviewText);
    // 次回のために今回のレビューを保存
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
 * 4. LINEプッシュ送信
 */
function pushLineMessage(text) {
  // ★改善6: LINEの5000文字制限に対応（超過分は切り詰め）
  const LINE_TEXT_LIMIT = 5000;
  const safeText = text.length > LINE_TEXT_LIMIT
    ? text.substring(0, LINE_TEXT_LIMIT - 20) + "\n\n…（以下省略）"
    : text;

  const url = "https://api.line.me/v2/bot/message/push";
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: safeText }]
    })
  });
}

/**
 * 5. LINE返信送信 (Reply API)
 */
function replyLineMessage(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error("LINE返信エラー:", e);
  }
}

/**
 * 5-b. LINE Flex Message返信
 */
function replyFlexMessage(replyToken, altText, flexContents) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{
          type: 'flex',
          altText: altText,
          contents: flexContents
        }]
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error("LINE Flex返信エラー:", e);
  }
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
      replyFlexMessage(replyToken, "コマンド一覧", buildHelpFlex());
      break;

    case '/stats':
      handleStatsCommand(replyToken);
      break;

    case '/review':
      handleReviewCommand(replyToken);
      break;

    default:
      replyFlexMessage(replyToken, "不明なコマンドです", buildUnknownCommandFlex(cmd));
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
      replyLineMessage(replyToken, "📊 直近7日間の記録がありません。日記を書いてみましょう！");
      return;
    }
    const flexContent = buildStatsFlex(logs);
    replyFlexMessage(replyToken, "📊 直近7日間の統計", flexContent);
  } catch (e) {
    console.error("statsコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 統計の取得に失敗しました: " + e.message);
  }
}

/**
 * /review コマンド: 週次レビューをオンデマンド生成
 */
function handleReviewCommand(replyToken) {
  try {
    const logs = fetchWeeklyLogsFromNotion();
    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 直近7日間の記録がないため、レビューを生成できません。");
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
      replyLineMessage(replyToken, header + safeReview);
      saveLastReview(reviewText);
    } else {
      replyLineMessage(replyToken, "⚠️ レビュー生成に失敗しました。\n" + errorLog);
    }
  } catch (e) {
    console.error("reviewコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ レビューの生成に失敗しました: " + e.message);
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

  // タグをラベル風に並べる
  const tagComponents = tags.map(tag => ({
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
        { type: "text", text: mood, size: "3xl", align: "center", margin: "md" },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: tagComponents.length > 0 ? tagComponents : [{ type: "text", text: "タグなし", size: "xs", color: "#999999" }],
          margin: "md"
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
        { type: "text", text: mood, size: "lg", flex: 1 },
        { type: "text", text: `${count}回`, size: "sm", color: "#666666", flex: 2, align: "start" }
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
        { type: "text", text: tag, size: "sm", flex: 2 },
        { type: "text", text: `${count}回`, size: "sm", color: "#666666", flex: 1, align: "end" }
      ]
    }));

  // 記録がある日数
  const uniqueDays = new Set(logs.map(log => log.date)).size;

  return {
    type: "bubble",
    styles: {
      header: { backgroundColor: "#0D47A1" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "📊 直近7日間の統計", color: "#FFFFFF", size: "md", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "lg",
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
        // ムード分布
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "text", text: "ムード分布", size: "sm", weight: "bold", color: "#333333" },
            ...moodItems
          ]
        },
        { type: "separator" },
        // タグ頻度 TOP5
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "text", text: "タグ頻度 TOP5", size: "sm", weight: "bold", color: "#333333" },
            ...tagItems
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
    { cmd: "/help", desc: "このヘルプを表示" },
    { cmd: "/stats", desc: "直近7日間の統計を表示" },
    { cmd: "/review", desc: "週次レビューをその場で生成" }
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
        { type: "text", text: "以下のコマンドが使えます", size: "sm", color: "#999999" },
        ...cmdComponents,
        { type: "separator", margin: "lg" },
        { type: "text", text: "💡 通常のテキストはそのまま日記として記録されます", size: "xs", color: "#999999", wrap: true, margin: "md" }
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
 * 週次レビューのプロンプトを組み立てる (sendWeeklyReview / /review コマンド 共通)
 */
function buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs) {
  let prompt = `あなたはユーザーの成長を見守る「パーソナル心理メンター」です。
以下の心理学フレームワークに基づき、表面的な要約ではなく、ユーザーの行動パターンや心理的欲求に踏み込んだ週次レビューを作成してください。

【👤 ユーザー情報】
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
}

/**
 * 前回の週次レビューを取得
 */
function getLastReview() {
  return PROPS.getProperty('LAST_WEEKLY_REVIEW') || "";
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