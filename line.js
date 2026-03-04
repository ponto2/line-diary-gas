// ============================================================
// LINE API 送受信
// ============================================================

/**
 * LINEプッシュ送信（テキスト）
 */
function pushLineMessage(text) {
  const safeText = truncateForLine(text);
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
 * LINE返信送信 (Reply API)
 * @param {string} replyToken
 * @param {string} text
 * @param {Object} [quickReply]
 */
function replyLineMessage(replyToken, text, quickReply) {
  const msg = { type: 'text', text: text };
  if (quickReply) msg.quickReply = quickReply;
  replyMessages(replyToken, [msg]);
}

/**
 * LINE Flex Message返信
 * @param {string} replyToken
 * @param {string} altText
 * @param {Object} flexContents
 * @param {Object} [quickReply]
 */
function replyFlexMessage(replyToken, altText, flexContents, quickReply) {
  const msg = {
    type: 'flex',
    altText: altText,
    contents: flexContents
  };
  if (quickReply) msg.quickReply = quickReply;
  replyMessages(replyToken, [msg]);
}

/**
 * 5-c. コマンド用 Quick Reply ボタンを生成
 */
function buildCommandQuickReply() {
  const items = [
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