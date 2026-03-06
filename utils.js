// ============================================================
// ユーティリティ
// ============================================================

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
  // 並行実行によるカウント不整合を防止
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
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
  } finally {
    lock.releaseLock();
  }
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
 * Notion APIへのリクエスト共通ヘルパー（リトライ付き）
 * Rate Limit (429) 時は Exponential Backoff で自動リトライする
 * @param {string} endpoint - APIエンドポイント（フルURLまたはパス）
 * @param {Object} [options] - { method, payload }
 * @param {number} [maxRetries=3] - 最大リトライ回数
 * @returns {Object} パース済みレスポンス
 * @throws {Error} HTTPエラー時（リトライ超過含む）
 */
function fetchNotionAPI(endpoint, options, maxRetries) {
  maxRetries = maxRetries || 3;
  const url = endpoint.startsWith('http') ? endpoint : `https://api.notion.com${endpoint}`;
  const method = (options && options.method) || 'post';
  const fetchOptions = {
    method: method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };
  if (options && options.payload) fetchOptions.payload = JSON.stringify(options.payload);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = UrlFetchApp.fetch(url, fetchOptions);
    const code = response.getResponseCode();

    if (code === 200) {
      return JSON.parse(response.getContentText());
    }

    // Rate Limit: リトライ（最終試行以外）
    if (code === 429 && attempt < maxRetries) {
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`Notion Rate Limit (429): ${waitMs}ms後にリトライ (${attempt + 1}/${maxRetries})`);
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error(`Notion API Error (${code}): ${response.getContentText().substring(0, 200)}`);
  }
}

/**
 * LINEメッセージの文字数制限に合わせてテキストを切り詰める
 * @param {string} text - 元テキスト
 * @param {number} [limit=5000] - 最大文字数
 * @returns {string}
 */
function truncateForLine(text, limit) {
  limit = limit || LIMITS.LINE_TEXT_MAX;
  if (text.length <= limit) return text;
  return text.substring(0, limit - 20) + "\n\n…（以下省略）";
}

/**
 * Geminiでテキスト生成（モデル自動フォールバック付き）
 * @param {string} prompt - プロンプト
 * @returns {{text: string, error: string}}
 */
function generateTextWithFallback(prompt) {
  let errorLog = "";
  for (const model of MODEL_CANDIDATES) {
    try {
      return { text: callGeminiForText(prompt, model), error: "" };
    } catch (e) {
      errorLog += `[${model}] ${e.message}\n`;
    }
  }
  return { text: "", error: errorLog };
}

/**
 * 必須スクリプトプロパティのバリデーション
 * @returns {string[]} 未設定のプロパティ名の配列
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
  const safeText = (text || "").substring(0, LIMITS.PROPERTY_VALUE_MAX);
  PROPS.setProperty('LAST_WEEKLY_REVIEW', safeText);

  // 月次レビュー用: 直近5件の週次レビューを蓄積
  const history = JSON.parse(PROPS.getProperty('WEEKLY_REVIEW_HISTORY') || '[]');
  history.push({
    date: new Date().toLocaleDateString("ja-JP"),
    text: (text || "").substring(0, LIMITS.REVIEW_TEXT_MAX)
  });
  // 直近N件のみ保持
  while (history.length > LIMITS.REVIEW_HISTORY_MAX) history.shift();
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
  const safeText = (text || "").substring(0, LIMITS.PROPERTY_VALUE_MAX);
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

/**
 * 日記記録の開始日を取得（キャッシュ付き）
 * 初回はNotion APIで最古の1件を取得し、PropertiesServiceに保存
 * @returns {string|null} ISO形式の日付文字列、記録がなければnull
 */
function getDiaryStartDate() {
  const cached = PROPS.getProperty('DIARY_START_DATE');
  if (cached) return cached;

  try {
    const data = fetchNotionAPI(`/v1/databases/${NOTION_DB_ID}/query`, {
      payload: {
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 1
      }
    });

    if (!data.results || data.results.length === 0) return null;

    const startDate = data.results[0].created_time;
    PROPS.setProperty('DIARY_START_DATE', startDate);
    return startDate;
  } catch (e) {
    console.error("DIARY_START_DATE取得エラー:", e.message);
    return null;
  }
}

/**
 * ランダムな過去の日記を1件取得（ランダムタイムスタンプ方式）
 * DIARY_START_DATE〜昨日の範囲でランダムなタイムスタンプを生成し、
 * その直後（または直前）のエントリを返す。APIコール: 2〜3回固定。
 * @returns {Object|null} ログ詳細オブジェクト、見つからなければnull
 */
function fetchRandomLog() {
  const startStr = getDiaryStartDate();
  if (!startStr) return null;

  const startMs = new Date(startStr).getTime();
  const endDate = new Date();
  endDate.setHours(0, 0, 0, 0); // 今日の00:00 = 昨日までを対象
  const endMs = endDate.getTime();

  if (endMs <= startMs) return null; // 今日が初日の場合

  // ランダムなタイムスタンプを生成
  const randomMs = startMs + Math.random() * (endMs - startMs);
  const randomTs = new Date(randomMs).toISOString();

  // 試行1: ランダムタイムスタンプ以降で最も近い1件
  let page = queryNotionByTimestamp(randomTs, "on_or_after", "ascending");

  // 試行2（フォールバック）: ランダムタイムスタンプ以前で最も近い1件
  if (!page) {
    page = queryNotionByTimestamp(randomTs, "before", "descending");
  }

  if (!page) return null;

  return fetchLogDetails(page.id);
}

/**
 * タイムスタンプ条件でNotionから1件取得するヘルパー
 * @param {string} timestamp - ISO形式のタイムスタンプ
 * @param {string} condition - "on_or_after" または "before"
 * @param {string} direction - "ascending" または "descending"
 * @returns {Object|null} Notionページオブジェクト、なければnull
 */
function queryNotionByTimestamp(timestamp, condition, direction) {
  try {
    const filter = { timestamp: "created_time", created_time: {} };
    filter.created_time[condition] = timestamp;

    const data = fetchNotionAPI(`/v1/databases/${NOTION_DB_ID}/query`, {
      payload: {
        filter: filter,
        sorts: [{ timestamp: "created_time", direction: direction }],
        page_size: 1
      }
    });
    return (data.results && data.results.length > 0) ? data.results[0] : null;
  } catch (e) {
    console.error("Notionランダムクエリエラー:", e.message);
    return null;
  }
}

/**
 * 指定IDのログ詳細を取得
 * @param {string} pageId - NotionページID
 * @returns {DiaryLog|null} ログ詳細、取得失敗時はnull
 */
function fetchLogDetails(pageId) {
  try {
    const page = fetchNotionAPI(`/v1/pages/${pageId}`, { method: 'get' });
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    const bodyResult = fetchPageBodyAndImageUrl(page.id);
    const d = new Date(page.created_time);

    return {
      date: d.toLocaleDateString("ja-JP"),
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "😐",
      tags: tags,
      body: bodyResult.body,
      imageUrl: bodyResult.imageUrl
    };
  } catch (e) {
    console.error(`ログ詳細取得エラー (${pageId}):`, e.message);
    return null;
  }
}


/**
 * 指定した日付（1日分）のログを取得
 * @param {Date} targetDate
 * @returns {Array<DiaryLog>} ログ配列（本文付き）
 */
function fetchLogsByDate(targetDate) {
  const start = new Date(targetDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return fetchLogsByDateRange(start, end, true);
}