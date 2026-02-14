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

  // ▼ 更新: 「買い物」→「購入」へ名称変更。経済活動・行動・評価を厳密に定義。
  const systemPrompt = `
あなたはユーザーの日記を分析し、メタデータを付与するAIアシスタントです。
ユーザーの入力（テキストまたは画像）を読み取り、以下の3つの要素を含むJSONオブジェクトのみを出力してください。

1. title: 内容を端的に表すタイトル（20文字以内の日本語）。
2. mood: 内容から読み取れる気分を [${MOODS.join(", ")}] から1つ選択。
3. tags: 以下のリストから、内容に合致するタグを選択（複数選択可）。

【タグの定義と使い分け】
- 研究: 大学での研究活動全般。回路設計、実測、シミュレーション、論文執筆など。
- 開発: プライベートで行う開発。Bot作成、GAS、プログラミング、アプリ開発など。
- 健康: 身体と心のメンテナンス。筋トレ、睡眠、体調管理、手術など。
- 勉強: 知識インプット活動。大学の講義、資格試験、英語学習。
- レビュー: モノや体験に対する「感想」「評価」。本やライブの感想，製品の感想など。
- 資産: 金融資産の記録。NISA、仮想通貨、貯金残高、給料、ローン返済など。
- 購入: 物品の購入ログ。ガジェット、本、服などが「届いた」「買った」という記録。
- 恋愛: パートナーとの関係、デート、感情の機微。
- 食事: 食事の内容、自炊、外食、サプリメント摂取。
- 写真: 画像が送信された場合。
- その他: 上記のいずれにも当てはまらないもの。

【判定のヒント】
- 画像がある場合は必ず "写真" タグを含めること。
- 金融商品（株・仮想通貨）の売買は "資産"。消費財（PC・本・服）の購入は "購入"。
- 料理の写真の場合は ["食事", "写真"] のように両方を選択すること。

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

  let reviewContext = `あなたはユーザーの成長を見守る「パーソナル心理メンター」です。
以下の心理学フレームワークに基づき、表面的な要約ではなく、ユーザーの行動パターンや心理的欲求に踏み込んだ週次レビューを作成してください。

【👤 ユーザー情報】
${userProfile}

【🧠 分析に使う心理学フレームワーク】

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

【📝 出力ルール】
- 全体で500〜700文字程度（LINEで読みやすい長さ）
- Markdown記法（**太字**など）は使用禁止。見出しは【 】と絵文字で表現
- 語りかける二人称「あなた」を使い、温かみのある口調で
- 分析の根拠を必ず日記ログの具体的内容に紐づけること（エビデンスベースド）

【📊 レビュー構成（この順序で出力）】

1. 🏆 今週のあなたの強み
   - ログから読み取れる「強みが発揮された瞬間」を1〜2個ピックアップ
   - SDTの3欲求のうち、今週最も満たされていたものに触れる
   - プロセス・プレイズで称賛する（結果ではなく行動・姿勢を評価）

2. � 気分と行動のパターン分析
   - ムード推移を時系列で読み取り、傾向を1〜2文で要約
   - 気分が上向いた日・下がった日の行動との相関を指摘（例: 「運動した日は気分が高い」）
   - CBTの視点で、もし認知の偏りが見られたら「〜と感じたのかもしれませんが、別の見方もできそうです」のように柔らかく問いかける

3. 💡 来週の「小さな実験」
   - SDTで不足していた欲求を自然に満たせる、具体的で小さなアクション1つ
   - 「実験」というフレーミングで心理的ハードルを下げる（失敗OK）
   - 例: 「来週は1日だけ、研究の合間に10分散歩を入れてみてください。有能感に偏りがちなので、関係性を回復する時間になるかもしれません」

4. 📝 一言メモ（任意）
   - 特に気になる認知パターンや、長期的に観察すべき傾向があれば一言添える
   - なければ省略可

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
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
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