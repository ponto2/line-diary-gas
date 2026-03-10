// ============================================================
// コマンド処理
// ============================================================

/**
 * コマンドルーター
 * LINEで "/" から始まるテキストを受信した際に呼ばれる
 */
function handleCommand(text, replyToken) {
  const cmd = text.split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '/help':
      replyFlexMessage(replyToken, "コマンド一覧", buildHelpFlex(), buildCommandQuickReply());
      break;

    case '/stats':
      handleStatsCommand(replyToken);
      break;

    case '/review':
      handleReviewCommand(replyToken);
      break;

    case '/today':
      handleTodayCommand(replyToken);
      break;

    case '/yesterday':
      handleYesterdayCommand(replyToken);
      break;

    case '/streak':
      handleStreakCommand(replyToken);
      break;

    case '/monthly':
      handleMonthlyCommand(replyToken);
      break;

    case '/onthisday':
      handleOnThisDayCommand(replyToken);
      break;

    case '/random':
      handleRandomCommand(replyToken);
      break;

    case '/saveimage':
      handleSaveImageCommand(replyToken);
      break;

    default:
      replyFlexMessage(replyToken, "不明なコマンドです", buildUnknownCommandFlex(cmd), buildCommandQuickReply());
      break;
  }
}

/**
 * /stats コマンド: 直近7日間の統計をFlex Messageで返信
 */
function handleStatsCommand(replyToken) {
  try {
    const logs = fetchWeeklyLogsFromNotion();
    if (logs.length === 0) {
      replyLineMessage(replyToken, "📊 直近7日間の記録がありません。日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }
    const flexContent = buildStatsFlex(logs);
    replyFlexMessage(replyToken, "📊 直近7日間の統計", flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("statsコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 統計の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /review コマンド: 週次レビューをオンデマンド生成
 */
function handleReviewCommand(replyToken) {
  try {
    const logs = fetchWeeklyLogsFromNotion();
    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 直近7日間の記録がないため、レビューを生成できません。", buildCommandQuickReply());
      return;
    }

    // sendWeeklyReviewと同様のロジックでレビュー生成
    const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
    const lastReview = getLastReview();
    const stats = buildLogStatistics(logs);

    const reviewContext = buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs);
    const result = generateTextWithFallback(reviewContext);

    if (result.text) {
      const header = "📅 【週次レビュー】\n\n";
      const safeReview = truncateForLine(result.text, 5000 - header.length);
      replyLineMessage(replyToken, header + safeReview, buildCommandQuickReply());
    } else {
      replyLineMessage(replyToken, "⚠️ レビュー生成に失敗しました。\n" + result.error, buildCommandQuickReply());
    }
  } catch (e) {
    console.error("reviewコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ レビューの生成に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /monthly コマンド: 月次レビューをオンデマンド生成
 * 当月の1日から実行時点までを対象にする
 */
function handleMonthlyCommand(replyToken) {
  try {
    // 対象範囲: 当月1日〜現在
    const now = new Date();
    const targetMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const targetMonthEnd = now; // 実行時点まで

    // 月末かどうか判定（明日が1日 = 今日が月末）
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isEndOfMonth = tomorrow.getDate() === 1;

    // 蓄積された週次レビューを取得し、当月のもののみフィルタ
    const allWeeklyReviews = getWeeklyReviewHistory();
    const weeklyReviews = filterReviewsByMonth(allWeeklyReviews, targetMonthStart, targetMonthEnd);

    // 当月のログメタデータを取得（本文なし）
    const logs = fetchMonthlyLogsFromNotion(targetMonthStart, targetMonthEnd);
    if (logs.length === 0 && weeklyReviews.length === 0) {
      replyLineMessage(replyToken, "📝 今月の記録と週次レビューの蓄積がないため、月次レビューを生成できません。", buildCommandQuickReply());
      return;
    }

    const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
    const lastMonthlyReview = getLastMonthlyReview();
    const stats = buildLogStatistics(logs);
    const targetYearMonth = targetMonthStart.getFullYear() + "年" + (targetMonthStart.getMonth() + 1) + "月";
    const label = isEndOfMonth ? targetYearMonth + " 月次レビュー" : targetYearMonth + " 月次レビュー（中間）";

    // 月末の未レビュー日の日記本文を補完取得
    const supplementLogs = fetchMonthEndSupplementLogs(weeklyReviews, logs, targetMonthEnd);

    const prompt = buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, targetYearMonth, supplementLogs);

    const result = generateTextWithFallback(prompt);

    if (result.text) {
      const header = "📆 【" + label + "】\n\n";
      const safeReview = truncateForLine(result.text, 5000 - header.length);
      replyLineMessage(replyToken, header + safeReview, buildCommandQuickReply());
    } else {
      replyLineMessage(replyToken, "⚠️ 月次レビュー生成に失敗しました。\n" + result.error, buildCommandQuickReply());
    }
  } catch (e) {
    console.error("monthlyコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 月次レビューの生成に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /today コマンド: 今日の記録一覧を表示
 */
function handleTodayCommand(replyToken) {
  try {
    const logs = fetchTodayLogsFromNotion();

    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 今日はまだ記録がありません。日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }

    const flexContent = buildTodayFlex(logs);
    replyFlexMessage(replyToken, `📝 今日の記録 (${logs.length}件)`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("todayコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 今日の記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /yesterday 昨日の記録一覧を表示
 */
function handleYesterdayCommand(replyToken) {
  try {
    const logs = fetchYesterdayLogsFromNotion();

    if (logs.length === 0) {
      replyLineMessage(replyToken, "📝 昨日の記録はありませんでした。", buildCommandQuickReply());
      return;
    }

    const flexContent = buildYesterdayFlex(logs);
    replyFlexMessage(replyToken, `📝 昨日の記録 (${logs.length}件)`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("yesterdayコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 昨日の記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /streak コマンド: 連続記録日数を表示（キャッシュベース）
 */
function handleStreakCommand(replyToken) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = formatDateKey(today);
    const yesterdayKey = formatDateKey(new Date(today.getTime() - 86400000));

    let streakCount = PROPS.getProperty('STREAK_COUNT');
    let lastDate = PROPS.getProperty('STREAK_LAST_DATE');
    let startDate = PROPS.getProperty('STREAK_START_DATE') || '';

    // キャッシュが未初期化の場合、フル計算
    if (streakCount === null || lastDate === null) {
      const result = initStreakCache();
      const flexContent = buildStreakFlex(result.streak, result.startDate);
      replyFlexMessage(replyToken, `🔥 連続${result.streak}日`, flexContent, buildCommandQuickReply());
      return;
    }

    streakCount = parseInt(streakCount, 10);

    // キャッシュから現在のstreakを算出
    let currentStreak;

    if (lastDate === todayKey || lastDate === yesterdayKey) {
      // 今日 or 昨日が最後 → streak継続中
      currentStreak = streakCount;
    } else {
      // 2日以上前 → streak途切れ
      currentStreak = 0;
      startDate = '';
    }

    const flexContent = buildStreakFlex(currentStreak, startDate);
    replyFlexMessage(replyToken, `🔥 連続${currentStreak}日`, flexContent, buildCommandQuickReply());
  } catch (e) {
    console.error("streakコマンドエラー:", e);
    replyLineMessage(replyToken, "⚠️ 連続記録の取得に失敗しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /onthisday コマンド: 過去の今日の日記を表示
 */
function handleOnThisDayCommand(replyToken) {
  try {
    const today = new Date();
    const month = today.getMonth();
    const date = today.getDate();

    // 過去5年分を検索
    let messages = [];

    // 1年前〜5年前
    for (let i = 1; i <= LIMITS.ONTHISDAY_YEARS; i++) {
      const targetYear = today.getFullYear() - i;
      const targetDate = new Date(targetYear, month, date);
      const logs = fetchLogsByDate(targetDate);

      if (logs.length > 0) {
        logs.forEach(log => {
          const label = `${i}年前の今日`;
          // Flex Messageを作成
          const flexContents = buildPastLogFlex(log, label);
          messages.push({
            type: "flex",
            altText: `📅 ${label} の記録`,
            contents: flexContents
          });
        });
      }
    }

    if (messages.length === 0) {
      replyLineMessage(replyToken, "📅 過去の同じ日の記録は見つかりませんでした。", buildCommandQuickReply());
    } else {
      // 最大5通までしか送れないため制限
      if (messages.length > 5) {
        messages = messages.slice(0, 5);
      }

      // QuickReplyを最後のメッセージに付与
      messages[messages.length - 1].quickReply = buildCommandQuickReply();

      // 複数メッセージ送信用の専用関数が必要だが、replyLineMessage等では単発しか送れないため
      // ここで汎用のreplyMessages関数を呼ぶ（下で定義）
      replyMessages(replyToken, messages);
    }
  } catch (e) {
    console.error("onthisday command error:", e);
    replyLineMessage(replyToken, "⚠️ エラーが発生しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /random コマンド: ランダムな過去の日記を表示
 * ランダムタイムスタンプ方式で効率的に1件取得（APIコール2〜3回）
 */
function handleRandomCommand(replyToken) {
  try {
    const details = fetchRandomLog();

    if (!details) {
      replyLineMessage(replyToken, "🎲 過去の記録が見つかりませんでした。まずは日記を書いてみましょう！", buildCommandQuickReply());
      return;
    }

    const label = `🎲 ${details.date} の記録`;
    replyFlexMessage(replyToken, label, buildPastLogFlex(details, "🎲 日記ガチャ"), buildCommandQuickReply());

  } catch (e) {
    console.error("random command error:", e);
    replyLineMessage(replyToken, "⚠️ エラーが発生しました: " + e.message, buildCommandQuickReply());
  }
}

/**
 * /saveimage コマンド: 待機中の写真をそのまま記録する
 */
function handleSaveImageCommand(replyToken) {
  try {
    const pending = getPendingImage();
    if (!pending) {
      replyLineMessage(replyToken, "📷 待機中の写真はありません。先に写真を送ってください。", buildCommandQuickReply());
      return;
    }
    finalizePendingImage(pending);
    replyFlexMessage(replyToken, "📷 写真日記を記録しました", buildDiaryRecordFlex({
      title: "📷 写真日記",
      mood: "😐",
      tags: ["写真"]
    }), buildCommandQuickReply());
  } catch (e) {
    console.error("saveimage command error:", e);
    replyLineMessage(replyToken, "⚠️ エラーが発生しました: " + e.message, buildCommandQuickReply());
  }
}