// ============================================================
// レビューシステム（プロンプト・送信ロジック）
// ============================================================

/**
 * 0. デイリーリマインダー (トリガー実行)
 * 夜に日記が未記録の場合に通知
 */
function sendDailyReminder() {
  if (!LINE_USER_ID) return;

  try {
    const logs = fetchTodayLogsFromNotion();
    if (logs.length === 0) {
      pushLineMessage("こんばんは！🌙\n今日はまだ日記が記録されていないようです。\n\n一日の終わりに、今日の出来事や気持ちを少しだけ残してみませんか？✍️");
    } else {
      console.log("本日は既に日記が記録されています。");
    }
  } catch (e) {
    console.error("Reminder Error:", e);
  }
}

/**
 * 1. 週次レビューのエントリーポイント (トリガー実行)
 */
function sendWeeklyReview() {
  if (!LINE_USER_ID) {
    console.log("LINE_USER_ID未設定のためレビューをスキップします");
    return;
  }

  // 1-1. Notionから過去7日間のログを取得
  const logs = fetchWeeklyLogsFromNotion();
  if (logs.length === 0) {
    pushLineMessage("今週は日記の記録がありませんでした。来週は記録してみましょう！📓");
    return;
  }

  // 1-2. AIへのコンテキスト作成
  const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
  const lastReview = getLastReview();
  const stats = buildLogStatistics(logs);

  const reviewContext = buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs);
  const result = generateTextWithFallback(reviewContext);

  if (result.text) {
    const header = "📅 【週次レビュー】\n\n";
    const safeReview = truncateForLine(result.text, 5000 - header.length);

    const statsMsg = { type: 'flex', altText: '📊 今週の統計', contents: buildStatsFlex(logs) };
    statsMsg.quickReply = buildCommandQuickReply();
    const messages = [
      { type: 'text', text: header + safeReview },
      statsMsg
    ];
    pushMessages(messages);
    saveLastReview(result.text);
  } else {
    pushLineMessage("週次レビューの生成に失敗しました。\n" + result.error);
  }
}

/**
 * 月次レビューのトリガーエントリーポイント
 * 毎日実行され、月末（明日が1日）のみ sendMonthlyReview を実行する
 * GASトリガーにはこの関数を「日ベース」で設定する
 */
function checkAndSendMonthlyReview() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getDate() === 1) {
    // 明日が1日 = 今日が月末
    sendMonthlyReview();
  }
}

/**
 * 月次レビューを生成・送信する
 * 当月の1日から月末（実行時点）までを対象とする
 */
function sendMonthlyReview() {
  if (!LINE_USER_ID) {
    console.log("LINE_USER_ID未設定のため月次レビューをスキップします");
    return;
  }

  // 対象範囲: 当月1日〜現在
  const now = new Date();
  const targetMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const targetMonthEnd = now;

  // 1. 蓄積された週次レビューを取得し、当月のもののみフィルタ
  const allWeeklyReviews = getWeeklyReviewHistory();
  const weeklyReviews = filterReviewsByMonth(allWeeklyReviews, targetMonthStart, targetMonthEnd);

  // 2. 当月のログメタデータを取得（本文は省略してトークン節約）
  const logs = fetchMonthlyLogsFromNotion(targetMonthStart, targetMonthEnd);
  if (logs.length === 0 && weeklyReviews.length === 0) {
    pushLineMessage("今月は日記の記録と週次レビューの蓄積がありませんでした。来月は記録してみましょう！📓");
    return;
  }

  // 3. コンテキスト作成
  const userProfile = PROPS.getProperty('USER_PROFILE') || "ユーザーは目標達成に向けて努力している人物です。";
  const lastMonthlyReview = getLastMonthlyReview();
  const stats = buildLogStatistics(logs);
  const targetYearMonth = targetMonthStart.getFullYear() + "年" + (targetMonthStart.getMonth() + 1) + "月";

  // 3-b. 月末の未レビュー日の日記本文を補完取得
  const supplementLogs = fetchMonthEndSupplementLogs(weeklyReviews, logs, targetMonthEnd);

  const prompt = buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, targetYearMonth, supplementLogs);

  const result = generateTextWithFallback(prompt);

  if (result.text) {
    const header = "📆 【" + targetYearMonth + " 月次レビュー】\n\n";
    const safeReview = truncateForLine(result.text, 5000 - header.length);

    const statsMsg = { type: 'flex', altText: '📊 ' + targetYearMonth + 'の統計', contents: buildMonthlyStatsFlex(logs, targetMonthStart, targetMonthEnd) };
    statsMsg.quickReply = buildCommandQuickReply();
    const messages = [
      { type: 'text', text: header + safeReview },
      statsMsg
    ];
    pushMessages(messages);
    saveLastMonthlyReview(result.text);

    // 月次レビュー送信後、週次レビュー蓄積をクリア
    PROPS.setProperty('WEEKLY_REVIEW_HISTORY', '[]');
  } else {
    pushLineMessage("月次レビューの生成に失敗しました。\n" + result.error);
  }
}

/**
 * Notionから指定期間のログメタデータを取得（本文省略版）
 * @param {Date} monthStart - 対象月の初日
 * @param {Date} monthEnd - 対象月の末日
 */
function fetchMonthlyLogsFromNotion(monthStart, monthEnd) {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`;

  const basePayload = {
    filter: {
      and: [
        { timestamp: "created_time", created_time: { on_or_after: monthStart.toISOString() } },
        { timestamp: "created_time", created_time: { on_or_before: monthEnd.toISOString() } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  };

  // ページネーション対応
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
      console.error(`Notion月次データ取得エラー (${code}): ${response.getContentText().substring(0, 200)}`);
      break;
    }

    const data = JSON.parse(response.getContentText());
    allResults = allResults.concat(data.results || []);
    hasMore = data.has_more === true;
    nextCursor = data.next_cursor;
  }

  // 本文は取得しない（トークン節約・API呼び出し削減）
  return allResults.map(page => {
    const props = page.properties;
    const tags = (props["Tags"]?.multi_select || []).map(t => t.name);
    return {
      date: new Date(page.created_time).toLocaleDateString("ja-JP"),
      title: props["Name"]?.title?.[0]?.plain_text || "無題",
      mood: props["Mood"]?.select?.name || "不明",
      tags: tags,
      body: "" // 月次では本文を省略
    };
  });
}

/**
 * 月末の未レビュー日の日記本文を補完取得する
 * 週次レビューの最終日以降のエントリの本文を取得し、月末の情報量を補う
 * @param {Array} weeklyReviews - フィルタ済み週次レビュー
 * @param {Array} logs - 全月間ログ（本文なし）
 * @param {Date} monthEnd - 対象月の末日
 * @returns {Array} 本文付きの補完ログ
 */
function fetchMonthEndSupplementLogs(weeklyReviews, logs, monthEnd) {
  if (weeklyReviews.length === 0) return []; // レビューがない場合は補完不要

  // 最後の週次レビューの日付を取得
  const lastReviewDate = new Date(weeklyReviews[weeklyReviews.length - 1].date);
  if (isNaN(lastReviewDate.getTime())) return [];

  // 最終レビュー日の翌日から月末までを補完対象とする
  const supplementStart = new Date(lastReviewDate);
  supplementStart.setDate(supplementStart.getDate() + 1);
  supplementStart.setHours(0, 0, 0, 0);

  // 補完対象の日付があるかチェック
  const supplementEntries = logs.filter(log => {
    const d = new Date(log.date);
    return !isNaN(d.getTime()) && d >= supplementStart;
  });

  if (supplementEntries.length === 0) return [];

  // Notion APIで補完対象期間のページを再取得（本文付き）
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
          { timestamp: "created_time", created_time: { on_or_after: supplementStart.toISOString() } },
          { timestamp: "created_time", created_time: { on_or_before: monthEnd.toISOString() } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.error("月末補完データ取得エラー");
    return [];
  }

  const data = JSON.parse(response.getContentText());
  return (data.results || []).map(page => {
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
 * 週次レビューのプロンプトを組み立てる (sendWeeklyReview / /review コマンド 共通)
 */
function buildWeeklyReviewPrompt(userProfile, lastReview, stats, logs) {
  let prompt = `あなたはユーザーの成長を見守る「パーソナル心理メンター」です。
以下の心理学フレームワークに基づき、表面的な要約ではなく、ユーザーの行動パターンや心理的欲求に踏み込んだ週次レビューを作成してください。

【👤 ユーザー情報（内部参照用）】
※この情報はログの行動パターンを正しく解釈するための背景知識として使用すること。
※出力でプロフィール内容に直接言及しないこと（「理系のあなたは〜」「研究者として〜」のような表現は禁止）。
${userProfile}

【🧠 分析に使う心理学フレームワーク（内部参照用・出力には含めないこと）】

■ 自己決定理論 (SDT: Deci & Ryan)
以下の3つの基本的心理欲求の充足度をログから読み取ること。
- 自律性: 自分の意志で選択・行動できていたか（やらされ仕事 vs 自発的活動）
- 有能感: 「できた」「成長した」と感じられる出来事があったか
- 関係性: 人とのつながりや協力を感じる場面があったか
→ 欠けている欲求があれば、それを自然に満たせる行動を提案する

■ ポジティブ心理学 (Seligman: PERMA)
- 日記ログの中から「強み (Signature Strengths)」の発揮を見つけ、言語化する
- 「Three Good Things」の視点: 小さくてもポジティブな出来事を拾い上げ、その意味を深掘りする
- 重要: 「頑張ったね」のような漠然とした褒めではなく、「○○という行動は、あなたの△△という強みの表れです」のように具体化する

■ 成長マインドセット (Dweck)
- 結果ではなく「プロセス」と「戦略」を称賛する（プロセス・プレイズ）
  例: ×「成功してすごい」 → ○「新しいアプローチを試したこと自体が成長」
- 困難やネガティブな出来事は「学習機会」として肯定的にリフレーミングする
- ただし無理なポジティブ転換（Toxic Positivity）は厳禁。辛さを認めた上で意味づけする

■ 認知行動療法 (CBT) の視点
- 気分の推移パターンから「認知の歪み」の兆候を読み取る（全か無か思考、過度の一般化など）
- 気分が低下した日の前後関係から、トリガーとなる行動や状況を推測する
- 自動思考の修正ではなく、気づきを促す問いかけの形で伝える

【🚫 やってはいけないこと】
- フレームワーク名（SDT、PERMA、CBTなど）を出力に含めない。専門用語ではなく日常的な言葉で語ること
- 全セクションを均等に書かない。今週特に目立つテーマに重点を置き、メリハリをつけること
- 「頑張りましたね」「素晴らしいですね」など漠然とした褒め言葉は禁止。必ず具体的な行動を引用すること
- 日記に書かれていない事実を捏造しない。推測する場合は「もしかすると〜かもしれません」と明示すること
- **太字**、*斜体*、# 見出し、- リストなどMarkdown記法は一切使用禁止。LINEはMarkdown非対応のため、そのまま記号が表示されてしまう。強調したい場合は「」や【】で囲むこと

【📝 出力ルール】
- 全体で500〜700文字程度（LINEで読みやすい長さ）
- Markdown記法（**太字**など）は使用禁止。見出しは【 】と絵文字で表現
- 語りかける二人称「あなた」を使い、温かみのある口調で
- 分析の根拠を必ず日記ログの具体的内容に紐づけること（エビデンスベースド）

【📊 レビュー構成（この順序で出力）】

1. 🏆 今週のあなたの強み
   - ログから読み取れる「強みが発揮された瞬間」を1〜2個ピックアップ
   - 今週最も充実していた心理欲求（自律性・有能感・関係性）に日常語で触れる
   - 結果ではなく行動・姿勢を評価する

2. 🔄 気分と行動のパターン分析
   - ムード推移を時系列で読み取り、傾向を1〜2文で要約
   - 気分が上向いた日・下がった日の行動との相関を指摘（例: 「運動した日は気分が高い」）
   - もし認知の偏りが見られたら「〜と感じたのかもしれませんが、別の見方もできそうです」のように柔らかく問いかける

3. 💡 来週の「小さな実験」
   - 今週不足していた心理欲求を自然に満たせる、具体的で小さなアクション1つ
   - 「実験」というフレーミングで心理的ハードルを下げる（失敗OK）
   - 例: 「来週は1日だけ、研究の合間に10分散歩を入れてみてください」

4. 📝 一言メモ（任意）
   - 特に気になるパターンや、長期的に観察すべき傾向があれば一言添える
   - なければ省略可
`;

  // 前回レビューがあれば追加
  if (lastReview) {
    prompt += `\n【📌 前回の週次レビュー（参考）】\n以下は先週のレビュー内容です。先週提案した「小さな実験」が実行されたか、先週の課題が改善されたか、といった連続性を意識してください。\n${lastReview}\n`;
  }

  // 統計サマリー
  prompt += `\n【📈 今週の統計サマリー】\n${stats}\n`;

  // Few-shot例
  prompt += `\n【✏️ 出力例（このレベルの具体性で書くこと）】

🏆 今週のあなたの強み
火曜の「シミュレーション結果が合わなくてアプローチを変えた」という記録が印象的です。うまくいかないときに粘り強く別の方法を試すのは、あなたの探究心と柔軟さの表れです。また、木曜に自発的にGASの開発に取り組んでいたことから、自分で選んで動く力が今週は特に活きていました。

🔄 気分と行動のパターン分析
週前半は😊が続いていましたが、水曜の深夜作業の翌日に😰へ下がっています。睡眠時間と気分に関連があるかもしれません。金曜に筋トレをした後に再び😊に戻っており、体を動かすことがリセットになっている可能性があります。

💡 来週の小さな実験
今週は一人で集中する時間が多かったようです。来週は1日だけ、研究室の誰かとランチに行ってみてください。人とのつながりの時間が、思わぬリフレッシュになるかもしれません。

（例ここまで。上記はあくまで形式の参考です。実際のログ内容に基づいて書いてください）\n`;

  // 日記ログ
  prompt += `\n【日記ログ】\n`;
  logs.forEach(log => {
    prompt += `---\n[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")}\nタイトル: ${log.title}\n本文: ${log.body}\n`;
  });

  return prompt;
}

/**
 * 月次レビューのプロンプトを組み立てる (sendMonthlyReview / /monthly コマンド 共通)
 * 週次レビューの蓄積を主要な入力とし、月間ログのメタデータで補完する
 */
function buildMonthlyReviewPrompt(userProfile, weeklyReviews, lastMonthlyReview, stats, logs, yearMonth, supplementLogs) {
  // yearMonthは呼び出し元から渡される（例: "2026年1月"）
  // supplementLogsは月末の未レビュー日の日記本文（補完用）

  let prompt = `あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。
以下のフレームワークと情報に基づき、この1ヶ月間を深く振り返る月次レビューを作成してください。
週次レビューが「1週間のスナップショット」であるのに対し、月次レビューは「1ヶ月の物語」です。
点と点をつなぎ、本人も気づいていない変化の流れを浮かび上がらせてください。

【👤 ユーザー情報（内部参照用）】
※この情報はログの行動パターンを正しく解釈するための背景知識として使用すること。
※出力でプロフィール内容に直接言及しないこと（「理系のあなたは〜」「研究者として〜」のような表現は禁止）。
${userProfile}

【🧠 月次レビュー用 分析フレームワーク（内部参照用・出力には含めないこと）】

■ ナラティブ・アイデンティティ（McAdams）
- 週次レビューの蓄積を「1ヶ月の物語」として読み解く
- 月の前半と後半で語り口や行動パターンに変化があったか
- ユーザーの「自分はこういう人間だ」という自己物語がどう表れているか
- 成長や変化を「物語の転換点」として捉え、言語化する

■ 自己決定理論 (SDT: Deci & Ryan) ── 月間スケールで
- 自律性・有能感・関係性の3つの心理欲求について、月全体での充足パターンを読む
- 週によって充足度に波がある場合、その波の原因（環境変化、プロジェクトの節目など）を推測する
- 月間を通じて慢性的に不足している欲求があれば、構造的な改善を提案する

■ ポジティブ心理学 (Seligman: PERMA) ── 強みの進化
- 1ヶ月の中で「繰り返し発揮されている強み」を特定する
- 月の前半と後半で強みの使い方に変化や深まりがあったかを検出する
- 新しく芽生えた強みや、まだ十分に活かされていない潜在的な強みに注目する

■ 習慣形成理論 (Clear: Atomic Habits)
- 記録の頻度パターンから習慣の定着度を読み取る
- 「習慣スタッキング」の兆候（ある行動が別の行動を自然に引き起こしている）を発見する
- 習慣が途切れた時期がある場合、その前後の状況からトリガーと障壁を推測する

■ フロー理論 (Csikszentmihalyi)
- タグやムードのパターンから、ユーザーが「没頭していた」と推測される活動を特定する
- スキルとチャレンジのバランスが取れていた時期・崩れていた時期を読み取る
- フロー状態に入りやすい条件（時間帯、前後の活動、環境）を推測する

■ 認知行動療法 (CBT) ── 長期パターン
- 1ヶ月のムード推移から、週次レビューでは見えなかった長期的な認知パターンを検出する
- 特定の曜日や週に気分が下がりやすいパターンがないか確認する
- 「思考の癖」が繰り返し現れている場合、それに気づかせる問いかけをする

【🚫 やってはいけないこと】
- フレームワーク名（SDT、PERMA、CBT、ナラティブなど）を出力に含めない。専門用語ではなく日常的な言葉で語ること
- 全セクションを均等に書かない。今月特に顕著だったテーマに重点を置き、メリハリをつけること
- 「頑張りましたね」「素晴らしいですね」「充実した1ヶ月でしたね」など漠然とした褒め言葉は禁止。具体的な行動や変化に言及すること
- 週次レビューに書かれていない事実を捏造しない。推測する場合は「もしかすると〜かもしれません」と明示すること
- 週次レビューの内容を単に並べ直すだけの要約にしない。週を横断して初めて見える「パターン」や「変化の流れ」を発見すること
- **太字**、*斜体*、# 見出し、- リストなどMarkdown記法は一切使用禁止。LINEはMarkdown非対応のため、そのまま記号が表示されてしまう。強調したい場合は「」や【】で囲むこと

【📝 出力ルール】
- 全体で700〜1000文字程度（月次レビューなのでやや長め。ただしLINEで読みきれる分量）
- Markdown記法（**太字**など）は使用禁止。見出しは【 】と絵文字で表現
- 語りかける二人称「あなた」を使い、温かみのある口調で
- 週次レビューの引用は「第○週のレビューで触れた〜」のように自然に織り込むこと
- 分析の根拠を必ずデータに紐づけること（エビデンスベースド）

【📊 月次レビュー構成（この順序で出力）】

1. 📆 ${yearMonth}の振り返り
   - この1ヶ月を一言で表すなら何か（キャッチフレーズ的な導入文を1行）
   - 月の全体像を2〜3文で俯瞰する。前半と後半で雰囲気の違いがあれば触れる

2. 🏆 今月発見された「あなたの強み」
   - 複数週にわたって繰り返し発揮された強みを1〜2個ピックアップ
   - 先月と比べて強みの使い方に変化や深まりがあれば言及する
   - 結果ではなく行動パターンや姿勢を評価する

3. 📈 1ヶ月のリズムとパターン
   - ムード推移の全体的な傾向（上向き傾向、波がある、安定しているなど）
   - 特定の活動や習慣と気分の相関で、月間データから初めて見えるもの
   - 記録の頻度パターンから読み取れる生活リズムの安定度

4. 🔄 繰り返し現れたテーマ
   - 複数の週次レビューで共通して登場したキーワード、課題、または成長テーマ
   - 月初に出ていた課題が月末までにどう変化（解決・継続・深化）したか
   - まだ解決されていない「持ち越し課題」があれば率直に指摘する

5. 🎯 来月への提案
   - 今月のパターンから導き出された、来月に試してほしい具体的なアクション1〜2個
   - 「続けるべきこと」と「変えてみること」をそれぞれ1つずつ
   - 実行しやすい粒度（いつ、何を、どのくらい）で提案する
`;

  // 前回の月次レビューがあれば追加
  if (lastMonthlyReview) {
    prompt += `\n【📌 前回の月次レビュー（参考）】\n以下は先月の月次レビュー内容です。先月提案した行動が実行されたか、先月の課題が改善されたか、といった月をまたいだ連続性を意識してください。\n${lastMonthlyReview}\n`;
  }

  // 月間統計サマリー
  prompt += `\n【📈 今月の統計サマリー】\n${stats}\n`;

  // 蓄積された週次レビュー
  if (weeklyReviews.length > 0) {
    prompt += `\n【📋 蓄積された週次レビュー（${weeklyReviews.length}件）】\nこれが月次レビューの最も重要な入力です。各週のレビュー内容を横断的に分析し、週を超えて見えるパターンや変化の流れを発見してください。\n※注意: 週次レビューは7日間単位で生成されるため、月初・月末付近のレビューには前月または翌月の数日分の内容が含まれている場合があります。${yearMonth}の内容に重点を置いて分析してください。\n`;
    weeklyReviews.forEach((review, i) => {
      prompt += `\n--- 第${i + 1}週 (${review.date}) ---\n${review.text}\n`;
    });
  } else {
    prompt += `\n【📋 週次レビューの蓄積】\n蓄積された週次レビューはありません。以下の日記ログのメタデータのみから分析してください。\n`;
  }

  // 日記ログのメタデータ
  prompt += `\n【日記ログメタデータ（${yearMonth}）】\n※基本的に本文は省略されています。タイトル・ムード・タグの推移パターンを分析に活用してください。\n`;
  logs.forEach(log => {
    prompt += `[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")} タイトル:${log.title}\n`;
  });

  // 月末補完ログ（本文付き）
  if (supplementLogs && supplementLogs.length > 0) {
    prompt += `\n【📝 月末の補完データ（本文付き）】\n以下は最後の週次レビュー以降の日記です。週次レビューでカバーされていないため、本文を含めて提供します。月末の分析に特に活用してください。\n`;
    supplementLogs.forEach(log => {
      prompt += `---\n[${log.date}] 気分:${log.mood} タグ:${log.tags.join(", ")}\nタイトル: ${log.title}\n本文: ${log.body}\n`;
    });
  }

  return prompt;
}