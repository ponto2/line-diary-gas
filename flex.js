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

  // タグをピル型ラベルに (空文字除外)
  const validTags = tags.filter(t => t && String(t).trim() !== "");
  const tagComponents = validTags.map(tag => ({
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
    size: "kilo",
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
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          alignItems: "center",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: mood, size: "xl", align: "center", gravity: "center" }
              ],
              backgroundColor: "#E8F5E9",
              cornerRadius: "xxl",
              width: "44px",
              height: "44px",
              justifyContent: "center",
              alignItems: "center",
              flex: 0
            },
            {
              type: "box",
              layout: "horizontal",
              spacing: "sm",
              flex: 1,
              contents: tagComponents.length > 0 ? tagComponents : [{ type: "text", text: "タグなし", size: "xs", color: "#999999" }]
            }
          ]
        }
      ]
    }
  };
}

/**
 * /today 今日の記録一覧のFlex Message
 */
function buildTodayFlex(logs) {
  const today = new Date();
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateStr = (today.getMonth() + 1) + '/' + today.getDate() + '(' + dayNames[today.getDay()] + ')';
  return buildDayLogListFlex(logs, dateStr);
}

/**
 * /yesterday 昨日の記録一覧のFlex Message
 */
function buildYesterdayFlex(logs) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateStr = (yesterday.getMonth() + 1) + '/' + yesterday.getDate() + '(' + dayNames[yesterday.getDay()] + ')';
  return buildDayLogListFlex(logs, dateStr);
}

/**
 * 日別ログ一覧の共通Flex Messageビルダー
 * @param {Array} logs - ログ配列
 * @param {string} dateStr - 表示用の日付文字列（例: "3/4(火)"）
 */
function buildDayLogListFlex(logs, dateStr) {
  const logItems = logs.map(function (log) {
    const tagText = log.tags.length > 0 ? log.tags.join(', ') : '';
    const subText = [log.mood, tagText].filter(Boolean).join('  ');
    return {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            { type: "text", text: log.time, size: "xs", color: "#999999", flex: 0 },
            { type: "text", text: log.title, size: "sm", weight: "bold", wrap: true, flex: 1 }
          ]
        },
        { type: "text", text: subText, size: "xs", color: "#666666", margin: "xs" }
      ]
    };
  });

  const bodyContents = [];
  logItems.forEach(function (item, i) {
    bodyContents.push(item);
    if (i < logItems.length - 1) {
      bodyContents.push({ type: "separator", margin: "md" });
    }
  });

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1B5E20" }
    },
    header: {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: dateStr + " の記録", color: "#FFFFFF", size: "sm", weight: "bold", flex: 1 },
        { type: "text", text: logs.length + "件", color: "#E8F5E9", size: "sm", align: "end", flex: 0 }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents
    }
  };
}

/**
 * /streak 連続記録のFlex Message
 * @param {number} streak - 連続日数
 * @param {string} startDateKey - 開始日 (YYYY-MM-DD形式)
 */
function buildStreakFlex(streak, startDateKey) {
  const milestones = [7, 14, 30, 50, 100, 200, 365, 500, 730, 1000];
  const isOnMilestone = milestones.indexOf(streak) !== -1;

  let emoji, message;
  if (streak === 0) {
    emoji = "✍";
    message = "今日から始めましょう！";
  } else if (isOnMilestone) {
    // マイルストーン達成時の特別メッセージ
    if (streak === 7) { emoji = "🎉"; message = "1週間達成！素晴らしいスタート！"; }
    else if (streak === 14) { emoji = "🎊"; message = "2週間達成！習慣が根付いてきました！"; }
    else if (streak === 30) { emoji = "🏅"; message = "1ヶ月達成！立派な習慣です！"; }
    else if (streak === 50) { emoji = "🌟"; message = "50日達成！半端ない継続力！"; }
    else if (streak === 100) { emoji = "💯"; message = "100日達成！圧倒的な意志力！"; }
    else if (streak === 200) { emoji = "👑"; message = "200日達成！記録の達人！"; }
    else if (streak === 365) { emoji = "🎆"; message = "1年達成！伝説の始まりです！"; }
    else if (streak === 500) { emoji = "🏆"; message = "500日達成！もはや生活の一部！"; }
    else if (streak === 730) { emoji = "💎"; message = "2年達成！揺るぎない日課！"; }
    else { emoji = "🏆"; message = "驚異的なマイルストーン達成！"; }
  } else if (streak < 3) {
    emoji = "🌱";
    message = "良いスタートです！";
  } else if (streak < 7) {
    emoji = "🔥";
    message = "絶好調！その調子！";
  } else if (streak < 14) {
    emoji = "⭐";
    message = "素晴らしい習慣です！";
  } else if (streak < 30) {
    emoji = "💎";
    message = "規律的な記録が定着しています！";
  } else {
    emoji = "🏆";
    message = "伝説級の継続力！";
  }

  let startDateText = "—";
  if (startDateKey && streak > 0) {
    const parts = startDateKey.split('-');
    const startYear = parseInt(parts[0], 10);
    const startMonth = parseInt(parts[1], 10);
    const startDay = parseInt(parts[2], 10);
    const currentYear = new Date().getFullYear();
    if (startYear !== currentYear) {
      startDateText = startYear + "/" + startMonth + "/" + startDay;
    } else {
      startDateText = startMonth + "/" + startDay;
    }
  }

  let milestoneText = "—";
  if (streak > 0) {
    let nextMilestone = null;
    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i] > streak) {
        nextMilestone = milestones[i];
        break;
      }
    }
    if (nextMilestone) {
      milestoneText = nextMilestone + "日まで あと" + (nextMilestone - streak) + "日";
    } else {
      milestoneText = "全マイルストーン達成！";
    }
  }

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#E65100" }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: emoji + " 連続記録", color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "lg",
      contents: [
        { type: "text", text: streak + "日", size: "3xl", weight: "bold", align: "center", color: "#E65100" },
        { type: "text", text: message, size: "sm", align: "center", color: "#666666", wrap: true },
        { type: "separator" },
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "horizontal",
              justifyContent: "center",
              spacing: "sm",
              contents: [
                { type: "text", text: "開始日", size: "xs", color: "#999999", flex: 0, gravity: "center" },
                { type: "text", text: startDateText, size: "sm", weight: "bold", flex: 0 }
              ]
            },
            {
              type: "box",
              layout: "horizontal",
              justifyContent: "center",
              spacing: "sm",
              contents: [
                { type: "text", text: "次の節目", size: "xs", color: "#999999", flex: 0, gravity: "center" },
                { type: "text", text: milestoneText, size: "sm", weight: "bold", flex: 0 }
              ]
            }
          ]
        }
      ]
    }
  };
}

/**
 * /stats 統計カードのFlex Message（週次）
 */
function buildStatsFlex(logs) {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const now = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  const dateRange = (from.getMonth() + 1) + "/" + from.getDate() + "(" + dayNames[from.getDay()] + ") ~ " + (now.getMonth() + 1) + "/" + now.getDate() + "(" + dayNames[now.getDay()] + ")";

  return buildStatsFlexCore(logs, {
    headerText: "📊 " + dateRange + " の統計",
    themeColor: "#0D47A1"
  });
}

/**
 * 月間統計のFlex Message（深紫テーマで週次と視覚的に区別）
 * @param {Array} logs - 月間ログ
 * @param {Date} monthStart - 対象月の初日
 * @param {Date} monthEnd - 対象月の末日
 */
function buildMonthlyStatsFlex(logs, monthStart, monthEnd) {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dateRange = (monthStart.getMonth() + 1) + "/" + monthStart.getDate() + "(" + dayNames[monthStart.getDay()] + ") ~ " + (monthEnd.getMonth() + 1) + "/" + monthEnd.getDate() + "(" + dayNames[monthEnd.getDay()] + ")";
  const daysInMonth = monthEnd.getDate();

  return buildStatsFlexCore(logs, {
    headerText: "📊 " + dateRange + " の月間統計",
    themeColor: "#4A148C",
    daysInMonth: daysInMonth
  });
}

/**
 * 統計カード共通ビルダー
 * @param {Array} logs - ログ配列
 * @param {Object} options
 * @param {string} options.headerText - ヘッダーテキスト
 * @param {string} options.themeColor - テーマカラー（HEX）
 * @param {number} [options.daysInMonth] - 月の日数（指定時は記録率カラムを追加）
 */
function buildStatsFlexCore(logs, options) {
  const totalEntries = logs.length;
  const themeColor = options.themeColor;

  // ムード分布
  const moodCounts = {};
  logs.forEach(log => { moodCounts[log.mood] = (moodCounts[log.mood] || 0) + 1; });
  const moodItems = Object.entries(moodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mood, count]) => ({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "filler", flex: 1 },
        { type: "text", text: mood, size: "md", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
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
        { type: "filler", flex: 1 },
        { type: "text", text: tag, size: "sm", flex: 2, align: "center", gravity: "center" },
        {
          type: "box",
          layout: "horizontal",
          flex: 2,
          justifyContent: "center",
          alignItems: "center",
          contents: [
            { type: "text", text: String(count), size: "sm", color: "#666666", flex: 0 },
            { type: "text", text: "回", size: "sm", color: "#666666", flex: 0, margin: "xs" }
          ]
        },
        { type: "filler", flex: 1 }
      ]
    }));

  // 記録がある日数
  const uniqueDays = new Set(logs.map(log => log.date)).size;

  // サマリーカラム（記録数 + 日数）
  const summaryColumns = [
    {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: String(totalEntries), size: "xxl", weight: "bold", align: "center", color: themeColor },
        { type: "text", text: "記録数", size: "xs", align: "center", color: "#999999" }
      ],
      flex: 1
    },
    {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: String(uniqueDays), size: "xxl", weight: "bold", align: "center", color: themeColor },
        { type: "text", text: "日数", size: "xs", align: "center", color: "#999999" }
      ],
      flex: 1
    }
  ];

  // 月次の場合は記録率カラムを追加
  if (options.daysInMonth) {
    const recordRate = Math.round((uniqueDays / options.daysInMonth) * 100);
    summaryColumns.push({
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: recordRate + "%", size: "xxl", weight: "bold", align: "center", color: themeColor },
        { type: "text", text: "記録率", size: "xs", align: "center", color: "#999999" }
      ],
      flex: 1
    });
  }

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: themeColor }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: options.headerText, color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: summaryColumns
        },
        { type: "separator" },
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          contents: [
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "ムード", size: "xs", weight: "bold", color: "#333333" },
                ...moodItems
              ]
            },
            { type: "separator" },
            {
              type: "box",
              layout: "vertical",
              spacing: "xs",
              flex: 1,
              alignItems: "center",
              contents: [
                { type: "text", text: "タグ TOP5", size: "xs", weight: "bold", color: "#333333" },
                ...tagItems
              ]
            }
          ]
        }
      ]
    }
  };
}

/**
 * 過去ログ表示用 Flex Message ビルダー
 * @param {Object} log - ログデータ
 * @param {String} headerLabel - ヘッダーに表示するテキスト（例: "1年前の今日"）
 */
function buildPastLogFlex(log, headerLabel) {
  // カラーパレット: 過去ログは少し落ち着いた色（Indigo系）
  const HEADER_COLOR = "#3949AB";

  const tags = log.tags || [];
  const validTags = tags.filter(t => t && String(t).trim() !== "");
  const tagComponents = validTags.map(tag => ({
    type: "box",
    layout: "vertical",
    contents: [{ type: "text", text: tag, size: "xs", color: "#FFFFFF", align: "center" }],
    backgroundColor: "#5C6BC0", // 少し明るめのIndigo
    cornerRadius: "md",
    paddingAll: "4px",
    paddingStart: "8px",
    paddingEnd: "8px"
  }));

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: HEADER_COLOR }
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: headerLabel, color: "#FFFFFF", size: "sm", weight: "bold" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `${log.date} ${log.time || ""}`, size: "xs", color: "#999999" }, // 日付と時間を表示
        { type: "text", text: log.title, weight: "bold", size: "lg", wrap: true },
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          alignItems: "center",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: log.mood, size: "xl", align: "center", gravity: "center" }
              ],
              backgroundColor: "#E8EAF6", // 薄いIndigo
              cornerRadius: "xxl",
              width: "44px",
              height: "44px",
              justifyContent: "center",
              alignItems: "center",
              flex: 0
            },
            {
              type: "box",
              layout: "horizontal",
              spacing: "sm",
              flex: 1,
              contents: tagComponents.length > 0 ? tagComponents : [{ type: "text", text: "タグなし", size: "xs", color: "#999999" }]
            }
          ]
        },
        { type: "separator", margin: "md" }
      ].concat(log.imageUrl ? [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          margin: "md",
          paddingAll: "10px",
          backgroundColor: "#E8EAF6",
          cornerRadius: "md",
          action: { type: "uri", uri: log.imageUrl },
          contents: [
            { type: "text", text: "📷", size: "sm", flex: 0 },
            { type: "text", text: "写真を開く (Google Drive)", size: "sm", color: "#3949AB", weight: "bold", flex: 1, decoration: "underline" }
          ]
        }
      ] : [
        {
          type: "text",
          text: (log.body || "本文なし").substring(0, 100) + (log.body && log.body.length > 100 ? "..." : ""),
          size: "sm",
          color: "#666666",
          wrap: true,
          margin: "md"
        }
      ])
    }
  };
}