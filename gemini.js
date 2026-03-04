// ============================================================
// Gemini API
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
- 学習: 実用的な知識インプット活動。大学の講義、資格試験、英語学習、技術書の読書など。娯楽目的の読書（小説等）は含まない。
- 趣味: 娯楽としての活動。小説（ミステリ・ホラー等）、映画鑑賞、ゲーム、ライブ・コンサート、音楽鑑賞、ガジェット開封・レビューなど。
- 健康: 身体と心のメンテナンス。筋トレ、睡眠、体調管理、手術など。
- 資産: 金融資産に関する記録。NISA、仮想通貨、貯金残高、給料、ローン返済など。物品の購入（ガジェット・本・服など）は含まない。
- 食事: 食事の内容、自炊、外食、サプリメント摂取。
- 外出: 外出を伴う活動。デート、旅行、友人と遊ぶ、イベント参加、散歩など。
- 写真: 画像が送信された場合。
- その他: 上記のいずれにも当てはまらないもの。

【タグの判定ルール】
- タグは「実際に行った事実・記録」にのみ付与すること。以下のような付随的な言及にはタグを付けない:
  × 予定・願望（「明日〜しよう」「〜したいな」「どっか行く？」）
  × 質問・独り言（「〜食べに行く？」「何しよう」）
  × 比喩・慣用表現（「頭が痛い問題」→ 健康タグは不要）
- 画像がある場合は必ず "写真" タグを含めること。
- 料理の写真の場合は ["食事", "写真"] のように両方を選択すること。
- 金融資産の売買・管理（株・仮想通貨・NISA・給料等）は "資産" タグを使うこと。物品の購入（PC・本・服）には専用タグを付けない。
- 小説・映画・ゲームなどの娯楽は "趣味"、資格・講義・技術書などの実用的学びは "学習" にすること。
- 外食に出かけた記録は "食事" のみで良い。明確に「出かけた」ことが主題の場合のみ "外出" も付ける。
- "その他" タグは、他に該当するタグが1つもない場合にのみ使用すること。他のタグと "その他" を同時に付けてはいけない。

【入出力例】

入力: 「卒論の比較表を作り直す。終わったらどっかご飯食べに行く？」
出力: {"title": "卒論の比較表修正", "mood": "😐", "tags": ["研究"]}
理由: ご飯は質問/予定であり記録ではないためタグ不要

入力: 「新しいラーメン屋行ったけど味噌が濃すぎた。まあまあかな」
出力: {"title": "新しいラーメン屋の味噌ラーメン", "mood": "😐", "tags": ["食事"]}
理由: 食事の記録。感想は本文から読み取れるためタグ不要

入力: 「AirPods届いた！音質めっちゃいい」
出力: {"title": "AirPods開封", "mood": "🤩", "tags": ["趣味"]}
理由: ガジェット趣味

入力: 「彼女と渋谷で映画見た。楽しかった」
出力: {"title": "渋谷で映画デート", "mood": "😊", "tags": ["外出", "趣味"]}
理由: 外出+映画鑑賞（娯楽）

入力: 「ミステリ小説読み終わった。どんでん返しが最高だった」
出力: {"title": "ミステリ小説の読了", "mood": "🤩", "tags": ["趣味"]}
理由: 娯楽としての読書

入力: 「TOEIC対策の参考書を3章まで進めた」
出力: {"title": "TOEIC参考書を3章まで", "mood": "😐", "tags": ["学習"]}
理由: 実用的な知識インプット

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

  // Geminiレスポンスからテキストを取得しパース
  const rawText = JSON.parse(body)?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  return JSON.parse(rawText);
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