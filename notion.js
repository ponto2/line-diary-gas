// ============================================================
// Notion API
// ============================================================

/**
 * 日記をNotionに保存する
 * @param {AnalysisResult} data - タイトル・ムード・タグ
 * @param {string} bodyText - 本文（長文は NOTION_BODY_MAX 文字ごとの段落に分割して全文保存）
 * @param {string|string[]} [imageUrls] - 写真のDrive URL（1件または複数）
 * @param {Date} [recordedAt] - 日記の日時（省略時は現在）
 */
function saveToNotion(data, bodyText, imageUrls, recordedAt) {
  const url = 'https://api.notion.com/v1/pages';
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);

  // ブロック作成: 画像リンクがある場合は本文より先頭に配置
  const childrenBlocks = [];

  urls.forEach((imageUrl, i) => {
    const label = urls.length > 1
      ? `写真を開く ${i + 1}/${urls.length} (Google Drive)`
      : "写真を開く (Google Drive)";
    childrenBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: "🔗 " } },
          {
            type: 'text',
            text: {
              content: label,
              link: { url: imageUrl }
            }
          }
        ]
      }
    });
  });

  // Notionの rich_text は1要素2000文字までなので、段落を分けて全文を保存する
  // （読み出し側は段落を区切りなしで連結するため、元の本文に戻る）
  splitTextForNotion(bodyText || "", LIMITS.NOTION_BODY_MAX).forEach(chunk => {
    childrenBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
    });
  });

  const payload = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      "Name": { title: [{ text: { content: data.title || "無題" } }] },
      "Mood": { select: { name: data.mood || "😐" } },
      "Tags": { multi_select: (data.tags || []).map(tag => ({ name: tag })) },
      "Date": { date: { start: (recordedAt || new Date()).toISOString() } }
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
 * テキストを maxLen 文字以下の断片に分割する（サロゲートペアの途中では切らない）
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]} 空文字列の場合は [""]
 */
function splitTextForNotion(text, maxLen) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end--;   // 絵文字などの上位サロゲートで終わる場合は1つ手前で切る
    }
    chunks.push(text.substring(i, end));
    i = end;
  }
  return chunks.length > 0 ? chunks : [""];
}

/**
 * 直近7日間（6日前の0時〜現在）のログを取得（/stats・/review 用、本文付き）
 * 期間を指定すると、その期間のログを取得する（週次レビュー用）。
 * @param {Date} [start] - 開始（以上）
 * @param {Date} [end] - 終了（未満）
 * @returns {Array<DiaryLog>}
 * @throws {Error} Notionからの取得に失敗した場合
 */
function fetchWeeklyLogsFromNotion(start, end) {
  if (!start) {
    start = startOfDay(new Date());
    start.setDate(start.getDate() - 6);
  }
  return fetchLogsWithBody(start, end || new Date(), 0);
}

/**
 * 指定期間のログを本文付きで取得（レビュー用、ページネーション対応）
 * 取得エラー時は例外を投げる（空配列を返すと「記録なし」と区別できないため）
 * @param {Date} start - 開始（以上）
 * @param {Date} end - 終了（未満）
 * @param {number} [throttleMs=0] - 本文取得ごとの待機時間（大量取得時のRate Limit対策）
 * @returns {Array<DiaryLog>}
 * @throws {Error} Notionからの取得に失敗した場合
 */
function fetchLogsWithBody(start, end, throttleMs) {
  const basePayload = {
    filter: {
      and: [
        { property: "Date", date: { on_or_after: start.toISOString() } },
        { property: "Date", date: { before: end.toISOString() } }
      ]
    },
    sorts: [{ property: "Date", direction: "ascending" }],
    page_size: 100
  };

  let allResults = [];
  let nextCursor = null;
  do {
    const payload = Object.assign({}, basePayload);
    if (nextCursor) payload.start_cursor = nextCursor;
    const data = fetchNotionAPI(`/v1/databases/${NOTION_DB_ID}/query`, { payload: payload });
    allResults = allResults.concat(data.results || []);
    nextCursor = data.has_more ? data.next_cursor : null;
  } while (nextCursor);

  const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
  return allResults.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const body = fetchPageBodyText(page.id);
    if (throttleMs) Utilities.sleep(throttleMs);
    const dateObj = new Date(props["Date"]?.date?.start || page.created_time);
    return {
      date: dateObj.toLocaleDateString("ja-JP"),
      dayOfWeek: DAYS[dateObj.getDay()] + "曜",
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明",
      tags: tags,
      body: body
    };
  });
}

/**
 * 今日のログを取得
 */
function fetchTodayLogsFromNotion() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return fetchLogsByDateRange(today, tomorrow, false);
}

/**
 * 昨日のログを取得
 */
function fetchYesterdayLogsFromNotion() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return fetchLogsByDateRange(yesterday, today, false);
}

/**
 * 指定した日付範囲のログを取得する共通関数
 * @param {Date} start - 開始日（以上）
 * @param {Date} end - 終了日（未満）
 * @param {boolean} includeBody - 本文を取得するか
 * @returns {Array<DiaryLog>} ログ配列
 */
function fetchLogsByDateRange(start, end, includeBody) {
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
          { property: "Date", date: { on_or_after: start.toISOString() } },
          { property: "Date", date: { before: end.toISOString() } }
        ]
      },
      sorts: [{ property: "Date", direction: "ascending" }]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Notionデータ取得エラー: ${response.getContentText().substring(0, 200)}`);
  }

  const data = JSON.parse(response.getContentText());
  const results = data.results || [];

  return results.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const time = new Date(page.properties["Date"]?.date?.start || page.created_time);
    const log = {
      date: time.toLocaleDateString("ja-JP"),
      time: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "😐",
      tags: tags
    };
    if (includeBody) {
      const result = fetchPageBodyAndImageUrl(page.id);
      log.body = result.body;
      log.imageUrl = result.imageUrl;
    }
    return log;
  });
}

/**
 * キーワードで日記を検索する。
 * 新しい順に一定件数を走査し、タイトル・タグ・本文のいずれかに一致するログを返す。
 * @param {string} keyword
 * @returns {Array<DiaryLog>}
 */
function searchLogsFromNotion(keyword) {
  const query = normalizeSearchText(keyword);
  if (!query) return [];

  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;
  const results = [];
  let scanned = 0;
  let hasMore = true;
  let nextCursor = undefined;

  while (hasMore && scanned < LIMITS.SEARCH_SCAN_LIMIT && results.length < LIMITS.SEARCH_RESULT_MAX) {
    const remaining = LIMITS.SEARCH_SCAN_LIMIT - scanned;
    const payload = {
      sorts: [{ property: "Date", direction: "descending" }],
      page_size: Math.min(remaining, 20)
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

    if (response.getResponseCode() !== 200) {
      throw new Error(`Notion検索エラー: ${response.getContentText().substring(0, 200)}`);
    }

    const data = JSON.parse(response.getContentText());
    const pages = data.results || [];
    scanned += pages.length;
    hasMore = data.has_more === true;
    nextCursor = data.next_cursor;

    for (const page of pages) {
      if (results.length >= LIMITS.SEARCH_RESULT_MAX) break;

      const props = page.properties;
      const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
      const title = props["Name"]?.title?.[0]?.plain_text || "無題";
      const metaText = normalizeSearchText([title].concat(tags).join(" "));

      let bodyResult = null;
      let matched = metaText.indexOf(query) !== -1;
      if (!matched) {
        bodyResult = fetchPageBodyAndImageUrl(page.id);
        matched = normalizeSearchText(bodyResult.body).indexOf(query) !== -1;
      }

      if (matched) {
        if (!bodyResult) bodyResult = fetchPageBodyAndImageUrl(page.id);
        const d = new Date(props["Date"]?.date?.start || page.created_time);
        results.push({
          date: d.toLocaleDateString("ja-JP"),
          time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
          title: title,
          mood: props["Mood"]?.select?.name || "😐",
          tags: tags,
          body: bodyResult.body,
          imageUrl: bodyResult.imageUrl
        });
      }
    }
  }

  return results;
}

function normalizeSearchText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Notionページの本文テキストとDrive画像URLを取得
 * リンクブロック（Google Drive）は本文から除外し、imageUrlとして返す
 * @param {string} pageId - NotionページID
 * @returns {{body: string, imageUrl: string|null}}
 */
function fetchPageBodyAndImageUrl(pageId) {
  try {
    // fetchNotionAPI は Rate Limit (429) を自動リトライする
    const blocks = fetchNotionAPI(`/v1/blocks/${pageId}/children?page_size=100`, { method: 'get' }).results || [];
    let text = "";
    let imageUrl = null;

    for (const block of blocks) {
      const richTexts = block[block.type]?.rich_text || [];

      // ブロック内にDriveリンクがあるか判定
      let driveUrl = null;
      for (const rt of richTexts) {
        const href = rt.text?.link?.url || rt.href || null;
        if (href && href.indexOf("drive.google.com") !== -1) {
          driveUrl = href;
          break;
        }
      }

      if (driveUrl) {
        // Driveリンクブロックはbodyに含めず、URLだけ抽出（複数枚の場合は1枚目）
        if (!imageUrl) imageUrl = driveUrl;
      } else {
        // 通常ブロック → plain_textを連結
        for (const rt of richTexts) {
          text += rt.plain_text || "";
        }
      }
    }

    return { body: text || "(本文なし)", imageUrl: imageUrl };
  } catch (e) {
    console.error(`本文取得エラー (${pageId}):`, e);
    return { body: "(取得失敗)", imageUrl: null };
  }
}

/**
 * Notionページの本文テキストを取得
 */
function fetchPageBodyText(pageId) {
  try {
    // fetchNotionAPI は Rate Limit (429) を自動リトライする
    const blocks = fetchNotionAPI(`/v1/blocks/${pageId}/children?page_size=100`, { method: 'get' }).results || [];
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
