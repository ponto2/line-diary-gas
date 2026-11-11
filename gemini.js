// ============================================================
// Gemini API
// ============================================================

function analyzeWithGemini(text, imageBlob) {
  let errorLog = "";
  for (const model of DIARY_MODEL_CANDIDATES) {
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

  const systemPrompt = buildDiaryAnalysisPrompt();

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

  // タイトル・気分・タグの分類だけなので思考レベルは low で十分（既定の medium は応答が遅い）
  const fetchWithConfig = generationConfig => UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: generationConfig }),
    muteHttpExceptions: true
  });

  let response = fetchWithConfig({
    response_mime_type: "application/json",
    thinkingConfig: { thinkingLevel: "low" }
  });
  if (response.getResponseCode() === 400) {
    // thinkingLevel 非対応のモデルの場合は指定なしで再試行
    console.warn(`[${modelName}] thinkingLevel 指定で400。指定なしで再試行: ${response.getContentText().substring(0, 200)}`);
    response = fetchWithConfig({ response_mime_type: "application/json" });
  }

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error(`API Error (${code}): ${body.substring(0, 200)}`);

  // Geminiレスポンスからテキストを取得しパース
  const rawText = extractGeminiText(JSON.parse(body));
  return JSON.parse(rawText);
}

/**
 * Geminiのレスポンスから本文テキストを取り出す（全partを連結、思考partは除外）
 * 本文が空の場合（セーフティブロック等）は理由付きで例外を投げる。
 * 空応答を成功扱いすると、次のモデルへのフォールバックが働かないため。
 * @param {Object} json - generateContent のレスポンス
 * @returns {string}
 * @throws {Error} 本文が空の場合
 */
function extractGeminiText(json) {
  const candidate = json?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter(part => !part.thought && typeof part.text === 'string')
    .map(part => part.text)
    .join('');

  if (!text.trim()) {
    const reason = candidate?.finishReason || json?.promptFeedback?.blockReason || 'unknown';
    throw new Error(`Empty response from Gemini (reason: ${reason})`);
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.warn(`Gemini finishReason: ${candidate.finishReason}`);
  }
  return text;
}

/**
 * Gemini API (テキスト生成版)
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

  return extractGeminiText(JSON.parse(body));
}