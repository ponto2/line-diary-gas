// ============================================================
// 長期レビューシステム (半年 / 年次)
// モデル: Claude Opus 4.6（自動トリガー時）/ Gemini（フォールバック）
// ============================================================

// ============================================================
// トリガーエントリーポイント
// ============================================================

/**
 * 期末レビュー（月次 → 半年 → 年次）のエントリーポイント
 * GASトリガーにこの関数を「日ベース」で1つだけ設定する。
 * 毎日実行され、月末は月次、6/30・12/31 は続けて半年、12/31 はさらに年次を、この順番で実行する。
 * 半年・年次は直前に保存した月次レビューを入力に使うため、別々のトリガーにすると順番が保証されない。
 *
 * - 同じ期間のレビューは一度完了したら再送しない（REVIEW_DONE_*）
 * - 複数のトリガーが同時に動いても、実行中フラグ（REVIEW_RUN_STARTED_AT）で1つだけが処理する
 * - 失敗したレビューは、同じ日に別のトリガーが動けば再試行される
 */
function checkAndSendPeriodReviews() {
  var steps = getDuePeriodReviewSteps(new Date());
  if (steps.length === 0) return;

  if (!acquireReviewRun()) {
    console.log('期末レビューは別の実行が処理中のためスキップします');
    return;
  }
  try {
    // タイムアウト済みの待機写真を先に確定（後から過去日付で記録されて集計から漏れるのを防ぐ）
    flushStalePendingImage();

    steps.forEach(function (step) {
      if (PROPS.getProperty(step.doneKey) === step.period) return;   // 完了済み
      var done = false;
      try {
        done = step.run();
      } catch (e) {
        console.error(step.name + 'エラー:', e);
        notifyOwner('⚠️ ' + step.name + 'の生成に失敗しました: ' + e.message);
      }
      if (done) PROPS.setProperty(step.doneKey, step.period);
    });
  } finally {
    PROPS.deleteProperty('REVIEW_RUN_STARTED_AT');
  }
}

/**
 * 今日実行すべき期末レビューを、実行順に返す
 * @param {Date} now
 * @returns {Array<{name: string, doneKey: string, period: string, run: function(): boolean}>}
 */
function getDuePeriodReviewSteps(now) {
  var tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getDate() !== 1) return [];   // 月末以外は何もしない

  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var steps = [{
    name: '月次レビュー',
    doneKey: 'REVIEW_DONE_MONTHLY',
    period: year + '-' + String(month).padStart(2, '0'),
    run: sendMonthlyReview
  }];
  if (month === 6 || month === 12) {
    steps.push({
      name: '半年レビュー',
      doneKey: 'REVIEW_DONE_HALFYEAR',
      period: year + '-H' + (month === 6 ? 1 : 2),
      run: sendHalfYearReview
    });
  }
  if (month === 12) {
    steps.push({
      name: '年次レビュー',
      doneKey: 'REVIEW_DONE_ANNUAL',
      period: String(year),
      run: sendAnnualReview
    });
  }
  return steps;
}

/**
 * 期末レビューの実行権を取る（取れなければ別の実行が処理中）
 * 実行が強制終了されてフラグが残った場合は、REVIEW_RUN_STALE_MS 経過後に取り直せる。
 * @returns {boolean}
 */
function acquireReviewRun() {
  return withScriptLock(function () {
    var startedAt = parseInt(PROPS.getProperty('REVIEW_RUN_STARTED_AT') || '0', 10);
    if (startedAt && Date.now() - startedAt < LIMITS.REVIEW_RUN_STALE_MS) return false;
    PROPS.setProperty('REVIEW_RUN_STARTED_AT', String(Date.now()));
    return true;
  });
}

// 旧トリガー名（互換用）: 既存のトリガーをそのまま使えるよう、すべて同じ処理を呼ぶ。
// 3つとも設定されていても、同じ期間のレビューが重複送信されることはない。
function checkAndSendMonthlyReview() { checkAndSendPeriodReviews(); }
function checkAndSendHalfYearReview() { checkAndSendPeriodReviews(); }
function checkAndSendAnnualReview() { checkAndSendPeriodReviews(); }

// ============================================================
// 送信ロジック
// ============================================================

/**
 * 半年レビューを生成・送信する（6/30・12/31 に、当月の月次レビューの後で呼ばれる）
 * @returns {boolean} 完了したか
 */
function sendHalfYearReview() {
  if (!LINE_USER_ID) return false;
  try {
    var now = new Date();
    var isFirstHalf = now.getMonth() < 6;
    var half = isFirstHalf ? '上半期' : '下半期';
    var yearHalf = now.getFullYear() + '年 ' + half;

    // 対象半期（1〜6月 / 7〜12月）の月次レビューだけを使う
    var allMonthly = getMonthlyReviewHistory();
    var recentMonthly = filterMonthlyReviewsByRange(allMonthly, now.getFullYear(), isFirstHalf ? 1 : 7, isFirstHalf ? 6 : 12);

    if (recentMonthly.length === 0) {
      pushLineMessage('📊 ' + yearHalf + 'の月次レビューの蓄積がないため、半年レビューを生成できません。');
      return true;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var lastHalfYear = PROPS.getProperty('LAST_HALFYEAR_REVIEW') || '';
    var prompts = buildHalfYearReviewPrompt(userProfile, recentMonthly, lastHalfYear, yearHalf);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, AI_MODELS.claude.longTermReview);

    if (result.text) {
      var header = '🗓️ 【' + yearHalf + ' レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      // 送信済みなので、保存に失敗しても完了扱いにする（再送を防ぐ）
      try {
        saveHalfYearReview(result.text, yearHalf);
        PROPS.setProperty('LAST_HALFYEAR_REVIEW', result.text.substring(0, LIMITS.PROPERTY_VALUE_MAX));
      } catch (saveErr) {
        console.error('半年レビューの保存に失敗:', saveErr);
      }
      return true;
    }
    pushLineMessage('⚠️ 半年レビューの生成に失敗しました。\n' + result.error);
    return false;
  } catch (e) {
    console.error('半年レビューエラー:', e);
    notifyOwner('⚠️ 半年レビューの生成に失敗しました: ' + e.message);
    return false;
  }
}

/**
 * 年次レビューを生成・送信する（12/31 に、月次・半年レビューの後で呼ばれる）
 * @returns {boolean} 完了したか
 */
function sendAnnualReview() {
  if (!LINE_USER_ID) return false;
  try {
    var now = new Date();
    var yearNumber = now.getFullYear();
    var year = yearNumber + '年';

    // 対象年の月次・半年レビューだけを使う（前年の年次レビューが失敗して残っていても混ざらない）
    var allMonthly = filterMonthlyReviewsByRange(getMonthlyReviewHistory(), yearNumber, 1, 12);
    var allHalfYear = getHalfYearReviewHistory().filter(function (r) {
      return (r.yearHalf || '').indexOf(year) === 0;
    });
    var lastAnnual = getLastAnnualReview();

    if (allMonthly.length === 0) {
      pushLineMessage('📊 ' + year + 'の月次レビューの蓄積がないため、年次レビューを生成できません。');
      return true;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var prompts = buildAnnualReviewPrompt(userProfile, allMonthly, allHalfYear, lastAnnual, year);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, AI_MODELS.claude.longTermReview);

    if (result.text) {
      var header = '🎊 【' + year + ' 年次レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      // 送信済みなので、保存に失敗しても完了扱いにする（再送を防ぐ）
      try {
        saveAnnualReview(result.text);
      } catch (saveErr) {
        console.error('年次レビューの保存に失敗:', saveErr);
      }
      // 年次レビュー後に月次の蓄積をクリアして翌年に備える（半年は最大2件で自動的に入れ替わる）
      clearMonthlyReviewHistory();
      return true;
    }
    pushLineMessage('⚠️ 年次レビューの生成に失敗しました。\n' + result.error);
    return false;
  } catch (e) {
    console.error('年次レビューエラー:', e);
    notifyOwner('⚠️ 年次レビューの生成に失敗しました: ' + e.message);
    return false;
  }
}

// ============================================================
// プロンプト生成
// ============================================================

/**
 * 半年レビュープロンプト
 * 入力: 月次レビュー×6 + 前回半年レビュー
 * @returns {{geminiPrompt: string, systemPrompt: string, userMessage: string}}
 */
function buildHalfYearReviewPrompt(userProfile, monthlyReviews, lastHalfYearReview, yearHalf) {

  // Gemini 向け
  var geminiPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n' +
    '以下の6か月分の月次レビューを統合し、' + yearHalf + 'の半年レビューを作成してください。\n' +
    '半年という長さで初めて見える「人生のパターン」と「深層にある価値観」を浮かび上がらせてください。\n\n' +
    '【👤 ユーザー情報（内部参照用）】\n' + userProfile + '\n\n' +
    '【🚫 禁止事項】\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止。強調は「」や【】で\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名や「上半期」「下半期」などの相対表現を使うこと\n' +
    '- 「頑張りましたね」など漠然とした褒め言葉は禁止\n\n' +
    '【📝 出力ルール】\n' +
    '- 全体で1000〜1500文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n\n' +
    '【📊 半年レビュー構成】\n' +
    '1. 🗓️ ' + yearHalf + 'の物語（半年を1文で表すキャッチフレーズ）\n' +
    '2. 📈 6か月間の変化の流れ（上半期と下半期の比較・転換点）\n' +
    '3. 🏆 半年で確立された「あなたらしさ」\n' +
    '4. 💡 繰り返し現れた深層テーマ\n' +
    '5. 🔄 未解決の課題と来期への引き継ぎ\n' +
    '6. 🎯 下半期・来年への提案\n';

  if (lastHalfYearReview) {
    geminiPrompt += '\n【前回の半年レビュー（参考）】\n' + lastHalfYearReview + '\n';
  }
  geminiPrompt += '\n【月次レビュー（6か月分）】\n';
  monthlyReviews.forEach(function(r, i) {
    geminiPrompt += '--- ' + (r.yearMonth || ('第' + (i + 1) + '月')) + ' ---\n' + r.text + '\n';
  });

  // Claude 向け system
  var systemPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n\n' +
    '<role>\n' +
    '半年という長さで初めて見える「人生のパターン」と「深層にある価値観」を浮かび上がらせてください。\n' +
    '月次レビューの積み重ねではなく、6か月を俯瞰して「物語」として人生の文脈を読み解きます。\n' +
    '</role>\n\n' +
    '<user_profile>\n' + userProfile + '\n</user_profile>\n\n' +
    '<constraints>\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名や「上半期」「下半期」などの相対表現を使うこと\n' +
    '- 漠然とした褒め言葉は禁止\n' +
    '- 月次レビューに書かれていない事実を捏造しない\n' +
    '</constraints>\n\n' +
    '<output_rules>\n' +
    '- 全体で1000〜1500文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n' +
    '</output_rules>\n\n' +
    '<output_structure>\n' +
    '1. 🗓️ ' + yearHalf + 'の物語（キャッチフレーズ1行）\n' +
    '2. 📈 6か月間の変化の流れ\n' +
    '3. 🏆 半年で確立された「あなたらしさ」\n' +
    '4. 💡 繰り返し現れた深層テーマ\n' +
    '5. 🔄 未解決の課題と来期への引き継ぎ\n' +
    '6. 🎯 下半期・来年への提案\n' +
    '</output_structure>';

  // Claude 向け user message
  var userMessage = '以下のデータに基づいて' + yearHalf + 'の半年レビューを作成してください。\n\n';
  userMessage += '<monthly_reviews>\n';
  monthlyReviews.forEach(function(r, i) {
    userMessage += '<review month="' + (r.yearMonth || ('第' + (i + 1) + '月')) + '">\n' + r.text + '\n</review>\n';
  });
  userMessage += '</monthly_reviews>\n\n';
  if (lastHalfYearReview) {
    userMessage += '<previous_halfyear_review>\n' + lastHalfYearReview + '\n</previous_halfyear_review>';
  }

  return { geminiPrompt: geminiPrompt, systemPrompt: systemPrompt, userMessage: userMessage };
}

/**
 * 年次レビュープロンプト
 * 入力: 月次レビュー×12 + 半年レビュー×2 + 前回年次レビュー
 * @returns {{geminiPrompt: string, systemPrompt: string, userMessage: string}}
 */
function buildAnnualReviewPrompt(userProfile, monthlyReviews, halfYearReviews, lastAnnualReview, year) {

  var geminiPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n' +
    '以下の1年分の月次・半年レビューを統合し、' + year + 'の年次レビューを作成してください。\n' +
    '年次レビューは人生の節目として、この1年を「自分の物語」として総括する特別なレビューです。\n\n' +
    '【👤 ユーザー情報（内部参照用）】\n' + userProfile + '\n\n' +
    '【🚫 禁止事項】\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名や「上半期」「下半期」などの相対表現を使うこと\n' +
    '- 「頑張りましたね」など漠然とした褒め言葉は禁止\n\n' +
    '【📝 出力ルール】\n' +
    '- 全体で1200〜2000文字程度（年次レビューなので最も長め）\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n\n' +
    '【📊 年次レビュー構成】\n' +
    '1. 🎊 ' + year + 'という年（1年を1文で表す言葉）\n' +
    '2. 🌊 1年間の大きな流れ（上半期・下半期の比較と転換点）\n' +
    '3. 🏆 この1年で確立した「あなたの強み」\n' +
    '4. 🌱 最も大きな成長・変化\n' +
    '5. 💡 繰り返し現れた人生のテーマ\n' +
    '6. 🔄 来年に持ち越す課題\n' +
    '7. 🎯 来年のあなたへ（具体的なメッセージと提案）\n';

  if (lastAnnualReview) {
    geminiPrompt += '\n【前年の年次レビュー（参考）】\n' + lastAnnualReview + '\n';
  }
  if (halfYearReviews.length > 0) {
    geminiPrompt += '\n【半年レビュー】\n';
    halfYearReviews.forEach(function(r) {
      geminiPrompt += '--- ' + (r.yearHalf || '') + ' ---\n' + r.text + '\n';
    });
  }
  geminiPrompt += '\n【月次レビュー（1年分）】\n';
  monthlyReviews.forEach(function(r, i) {
    geminiPrompt += '--- ' + (r.yearMonth || ('第' + (i + 1) + '月')) + ' ---\n' + r.text + '\n';
  });

  // Claude 向け system
  var systemPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n\n' +
    '<role>\n' +
    '年次レビューは人生の節目として、この1年を「自分の物語」として総括する特別なレビューです。\n' +
    '1年分の月次・半年レビューを俯瞰し、来年へと続く物語の転換点を言語化してください。\n' +
    'これはユーザーが来年読み返したときに、自分の成長を実感できる記録になる必要があります。\n' +
    '</role>\n\n' +
    '<user_profile>\n' + userProfile + '\n</user_profile>\n\n' +
    '<constraints>\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止\n' +
    '- 漠然とした褒め言葉は禁止\n' +
    '- レビューに書かれていない事実を捏造しない\n' +
    '</constraints>\n\n' +
    '<output_rules>\n' +
    '- 全体で1200〜2000文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n' +
    '</output_rules>\n\n' +
    '<output_structure>\n' +
    '1. 🎊 ' + year + 'という年（1年を1文で表す言葉）\n' +
    '2. 🌊 1年間の大きな流れ\n' +
    '3. 🏆 この1年で確立した「あなたの強み」\n' +
    '4. 🌱 最も大きな成長・変化\n' +
    '5. 💡 繰り返し現れた人生のテーマ\n' +
    '6. 🔄 来年に持ち越す課題\n' +
    '7. 🎯 来年のあなたへ\n' +
    '</output_structure>';

  // Claude 向け user message
  var userMessage = '以下のデータに基づいて' + year + 'の年次レビューを作成してください。\n\n';
  if (halfYearReviews.length > 0) {
    userMessage += '<halfyear_reviews>\n';
    halfYearReviews.forEach(function(r) {
      userMessage += '<review half="' + (r.yearHalf || '') + '">\n' + r.text + '\n</review>\n';
    });
    userMessage += '</halfyear_reviews>\n\n';
  }
  userMessage += '<monthly_reviews>\n';
  monthlyReviews.forEach(function(r, i) {
    userMessage += '<review month="' + (r.yearMonth || ('第' + (i + 1) + '月')) + '">\n' + r.text + '\n</review>\n';
  });
  userMessage += '</monthly_reviews>\n\n';
  if (lastAnnualReview) {
    userMessage += '<previous_annual_review>\n' + lastAnnualReview + '\n</previous_annual_review>';
  }

  return { geminiPrompt: geminiPrompt, systemPrompt: systemPrompt, userMessage: userMessage };
}
