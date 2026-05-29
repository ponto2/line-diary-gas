// ============================================================
// Claude API (Anthropic)
// ============================================================

/**
 * Claude API でテキスト生成
 * Anthropic Messages API の system/user 分離形式で呼び出す
 *
 * 呼び出し元は utils.js の generateTextWithFallback() 経由で使用すること。
 * 直接呼び出しは避けること（エラーハンドリング・フォールバックがないため）。
 *
 * @param {string} systemPrompt - システムプロンプト（ロール・フレームワーク・ルール）
 * @param {string} userMessage  - ユーザーメッセージ（データ・ログ・統計）
 * @param {string} [model]      - 使用するモデル（省略時: AI_MODELS.claude.defaultText）
 *                                長期レビュー時は AI_MODELS.claude.longTermReview を指定
 * @returns {string} 生成テキスト
 * @throws {Error} APIエラー時
 */
function callClaudeForText(systemPrompt, userMessage, model) {
  var claudeModel = model || AI_MODELS.claude.defaultText;
  var url = 'https://api.anthropic.com/v1/messages';

  var payload = {
    model: claudeModel,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage }
    ]
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error('Claude API Error (' + code + '): ' + body.substring(0, 200));

  var json = JSON.parse(body);
  var text = json.content && json.content[0] && json.content[0].text;
  if (!text) throw new Error('Claude API: Empty response');
  console.log('Claude API 使用モデル: ' + claudeModel);
  return text;
}
