// ============================================================
// Claude API (Anthropic)
// ============================================================

/**
 * Claude Sonnet 4.6 でテキスト生成
 * Anthropic Messages API の system/user 分離形式で呼び出す
 *
 * 呼び出し元は utils.js の generateTextWithFallback() 経由で使用すること。
 * 直接呼び出しは避けること（エラーハンドリング・フォールバックがないため）。
 *
 * @param {string} systemPrompt - システムプロンプト（ロール・フレームワーク・ルール）
 * @param {string} userMessage  - ユーザーメッセージ（データ・ログ・統計）
 * @returns {string} 生成テキスト
 * @throws {Error} APIエラー時
 */
function callClaudeForText(systemPrompt, userMessage) {
  const url = 'https://api.anthropic.com/v1/messages';

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage }
    ]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error(`Claude API Error (${code}): ${body.substring(0, 200)}`);

  const json = JSON.parse(body);
  const text = json.content?.[0]?.text;
  if (!text) throw new Error('Claude API: Empty response');
  return text;
}
