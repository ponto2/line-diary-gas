// ============================================================
// Notion API
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