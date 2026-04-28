// ============================================================
// 長期レビューシステム (四半期 / 半年 / 年次)
// モデル: Claude Opus 4.7（自動トリガー時）/ Gemini（フォールバック）
// ============================================================

var CLAUDE_OPUS = 'claude-opus-4-7';

// ============================================================
// トリガーエントリーポイント
// ============================================================

/**
 * 四半期レビュー: 毎日実行、四半期末（3/31, 6/30, 9/30, 12/31）のみ動作
 */
function checkAndSendQuarterlyReview() {
  var now = new Date();
  var month = now.getMonth() + 1; // 1-12
  var day = now.getDate();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var isQuarterEnd = (month === 3 || month === 6 || month === 9 || month === 12) && day === daysInMonth;
  if (isQuarterEnd) {
    sendQuarterlyReview();
  }
}

/**
 * 半年レビュー: 毎日実行、半年末（6/30, 12/31）のみ動作
 */
function checkAndSendHalfYearReview() {
  var now = new Date();
  var month = now.getMonth() + 1;
  var day = now.getDate();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var isHalfYearEnd = (month === 6 || month === 12) && day === daysInMonth;
  if (isHalfYearEnd) {
    sendHalfYearReview();
  }
}

/**
 * 年次レビュー: 毎日実行、12/31 のみ動作
 */
function checkAndSendAnnualReview() {
  var now = new Date();
  var isYearEnd = now.getMonth() === 11 && now.getDate() === 31;
  if (isYearEnd) {
    sendAnnualReview();
  }
}

// ============================================================
// 送信ロジック
// ============================================================

function sendQuarterlyReview() {
  if (!LINE_USER_ID) return;
  try {
    var now = new Date();
    var quarter = Math.ceil((now.getMonth() + 1) / 3);
    var yearQuarter = now.getFullYear() + '年 第' + quarter + '四半期';

    // 直近3か月分の月次レビューを取得
    var allMonthly = getMonthlyReviewHistory();
    var recentMonthly = allMonthly.slice(-3);

    if (recentMonthly.length === 0) {
      pushLineMessage('📊 ' + yearQuarter + 'の月次レビューの蓄積がないため、四半期レビューを生成できません。');
      return;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var lastQuarterly = PROPS.getProperty('LAST_QUARTERLY_REVIEW') || '';
    var prompts = buildQuarterlyReviewPrompt(userProfile, recentMonthly, lastQuarterly, yearQuarter);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, CLAUDE_OPUS);

    if (result.text) {
      var header = '📊 【' + yearQuarter + ' レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      saveQuarterlyReview(result.text, yearQuarter);
      PROPS.setProperty('LAST_QUARTERLY_REVIEW', result.text.substring(0, LIMITS.PROPERTY_VALUE_MAX));
    } else {
      pushLineMessage('⚠️ 四半期レビューの生成に失敗しました。\n' + result.error);
    }
  } catch (e) {
    console.error('四半期レビューエラー:', e);
    pushLineMessage('⚠️ 四半期レビューの生成に失敗しました: ' + e.message);
  }
}

function sendHalfYearReview() {
  if (!LINE_USER_ID) return;
  try {
    var now = new Date();
    var half = now.getMonth() < 6 ? '前半期' : '後半期';
    var yearHalf = now.getFullYear() + '年 ' + half;

    var allMonthly = getMonthlyReviewHistory();
    var recentMonthly = allMonthly.slice(-6);
    var allQuarterly = getQuarterlyReviewHistory();
    var recentQuarterly = allQuarterly.slice(-2);

    if (recentMonthly.length === 0) {
      pushLineMessage('📊 ' + yearHalf + 'の月次レビューの蓄積がないため、半年レビューを生成できません。');
      return;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var lastHalfYear = PROPS.getProperty('LAST_HALFYEAR_REVIEW') || '';
    var prompts = buildHalfYearReviewPrompt(userProfile, recentMonthly, recentQuarterly, lastHalfYear, yearHalf);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, CLAUDE_OPUS);

    if (result.text) {
      var header = '🗓️ 【' + yearHalf + ' レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      saveHalfYearReview(result.text, yearHalf);
      PROPS.setProperty('LAST_HALFYEAR_REVIEW', result.text.substring(0, LIMITS.PROPERTY_VALUE_MAX));
    } else {
      pushLineMessage('⚠️ 半年レビューの生成に失敗しました。\n' + result.error);
    }
  } catch (e) {
    console.error('半年レビューエラー:', e);
    pushLineMessage('⚠️ 半年レビューの生成に失敗しました: ' + e.message);
  }
}

function sendAnnualReview() {
  if (!LINE_USER_ID) return;
  try {
    var now = new Date();
    var year = now.getFullYear() + '年';

    var allMonthly = getMonthlyReviewHistory();
    var allHalfYear = getHalfYearReviewHistory();
    var lastAnnual = getLastAnnualReview();

    if (allMonthly.length === 0) {
      pushLineMessage('📊 ' + year + 'の月次レビューの蓄積がないため、年次レビューを生成できません。');
      return;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var prompts = buildAnnualReviewPrompt(userProfile, allMonthly, allHalfYear, lastAnnual, year);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, CLAUDE_OPUS);

    if (result.text) {
      var header = '🎊 【' + year + ' 年次レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      saveAnnualReview(result.text);
      // 年次レビュー後に月次・四半期・半年の蓄積をクリアして翌年に備える
      clearMonthlyReviewHistory();
      clearQuarterlyReviewHistory();
    } else {
      pushLineMessage('⚠️ 年次レビューの生成に失敗しました。\n' + result.error);
    }
  } catch (e) {
    console.error('年次レビューエラー:', e);
    pushLineMessage('⚠️ 年次レビューの生成に失敗しました: ' + e.message);
  }
}

// ============================================================
// プロンプト生成
// ============================================================

/**
 * 四半期レビュープロンプト
 * @returns {{geminiPrompt: string, systemPrompt: string, userMessage: string}}
 */
function buildQuarterlyReviewPrompt(userProfile, monthlyReviews, lastQuarterlyReview, yearQuarter) {

  // Gemini 向け
  var geminiPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n' +
    '以下の3か月分の月次レビューを統合し、' + yearQuarter + 'の四半期レビューを作成してください。\n' +
    '月次レビューが「1か月の物語」であるのに対し、四半期レビューは「3か月のトレンド」です。\n\n' +
    '【👤 ユーザー情報（内部参照用）】\n' + userProfile + '\n\n' +
    '【🚫 禁止事項】\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止。強調は「」や【】で\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名（「1月」「2月」等）や「四半期前半」「終盤」などの相対表現を使うこと\n\n' +
    '【📝 出力ルール】\n' +
    '- 全体で800〜1200文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n\n' +
    '【📊 四半期レビュー構成】\n' +
    '1. 📆 ' + yearQuarter + 'の総括（キャッチフレーズ1行 + 全体俯瞰2〜3文）\n' +
    '2. 📈 3か月間のトレンド（ムードや活動の変化の流れ）\n' +
    '3. 🏆 この四半期で発揮された強み（複数月にわたるパターン）\n' +
    '4. 🔄 持ち越し課題と成長テーマ\n' +
    '5. 🎯 次の四半期への提案（具体的アクション1〜2個）\n';

  if (lastQuarterlyReview) {
    geminiPrompt += '\n【前回の四半期レビュー（参考）】\n' + lastQuarterlyReview + '\n';
  }
  geminiPrompt += '\n【月次レビュー（3か月分）】\n';
  monthlyReviews.forEach(function(r, i) {
    geminiPrompt += '--- ' + (r.yearMonth || ('第' + (i + 1) + '月')) + ' ---\n' + r.text + '\n';
  });

  // Claude 向け system
  var systemPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n\n' +
    '<role>\n' +
    '月次レビューが「1か月の物語」であるのに対し、四半期レビューは「3か月のトレンド」です。\n' +
    '3つの月次レビューを横断的に分析し、月を超えて初めて見えるパターン・成長の流れを発見することが目的です。\n' +
    '</role>\n\n' +
    '<user_profile>\n' + userProfile + '\n</user_profile>\n\n' +
    '<constraints>\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名（「1月」「2月」等）や相対表現を使うこと\n' +
    '- 「頑張りましたね」など漠然とした褒め言葉は禁止\n' +
    '- 月次レビューに書かれていない事実を捏造しない\n' +
    '</constraints>\n\n' +
    '<output_rules>\n' +
    '- 全体で800〜1200文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n' +
    '</output_rules>\n\n' +
    '<output_structure>\n' +
    '1. 📆 ' + yearQuarter + 'の総括\n' +
    '   - キャッチフレーズ1行 + 全体俯瞰2〜3文\n' +
    '2. 📈 3か月間のトレンド\n' +
    '   - ムードや活動の変化の流れ\n' +
    '3. 🏆 この四半期で発揮された強み\n' +
    '   - 複数月にわたるパターン\n' +
    '4. 🔄 持ち越し課題と成長テーマ\n' +
    '5. 🎯 次の四半期への提案（具体的アクション1〜2個）\n' +
    '</output_structure>';

  // Claude 向け user message
  var userMessage = '以下のデータに基づいて' + yearQuarter + 'の四半期レビューを作成してください。\n\n';
  userMessage += '<monthly_reviews>\n';
  monthlyReviews.forEach(function(r, i) {
    userMessage += '<review month="' + (r.yearMonth || ('第' + (i + 1) + '月')) + '">\n' + r.text + '\n</review>\n';
  });
  userMessage += '</monthly_reviews>\n\n';
  if (lastQuarterlyReview) {
    userMessage += '<previous_quarterly_review>\n' + lastQuarterlyReview + '\n</previous_quarterly_review>';
  }

  return { geminiPrompt: geminiPrompt, systemPrompt: systemPrompt, userMessage: userMessage };
}

/**
 * 半年レビュープロンプト
 * @returns {{geminiPrompt: string, systemPrompt: string, userMessage: string}}
 */
function buildHalfYearReviewPrompt(userProfile, monthlyReviews, quarterlyReviews, lastHalfYearReview, yearHalf) {

  var geminiPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n' +
    '以下の月次・四半期レビューを統合し、' + yearHalf + 'の半年レビューを作成してください。\n' +
    '半年という長さで初めて見える「人生のパターン」と「深層にある価値観」を浮かび上がらせてください。\n\n' +
    '【👤 ユーザー情報（内部参照用）】\n' + userProfile + '\n\n' +
    '【🚫 禁止事項】\n' +
    '- フレームワーク名を出力に含めない\n' +
    '- Markdown記法は一切使用禁止\n' +
    '- 日付（数字の○月○日形式）で言及することは禁止。月名や「前半期」「後半期」などの相対表現を使うこと\n' +
    '- 「頑張りましたね」など漠然とした褒め言葉は禁止\n\n' +
    '【📝 出力ルール】\n' +
    '- 全体で1000〜1500文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n\n' +
    '【📊 半年レビュー構成】\n' +
    '1. 🗓️ ' + yearHalf + 'の物語（半年を1文で表すキャッチフレーズ）\n' +
    '2. 📈 6か月間の変化の流れ（前半と後半の比較・転換点）\n' +
    '3. 🏆 半年で確立された「あなたらしさ」\n' +
    '4. 💡 繰り返し現れた深層テーマ\n' +
    '5. 🔄 未解決の課題と来期への引き継ぎ\n' +
    '6. 🎯 後半期・来年への提案\n';

  if (lastHalfYearReview) {
    geminiPrompt += '\n【前回の半年レビュー（参考）】\n' + lastHalfYearReview + '\n';
  }
  if (quarterlyReviews.length > 0) {
    geminiPrompt += '\n【四半期レビュー】\n';
    quarterlyReviews.forEach(function(r) {
      geminiPrompt += '--- ' + (r.yearQuarter || '') + ' ---\n' + r.text + '\n';
    });
  }
  geminiPrompt += '\n【月次レビュー（6か月分）】\n';
  monthlyReviews.forEach(function(r, i) {
    geminiPrompt += '--- ' + (r.yearMonth || ('第' + (i + 1) + '月')) + ' ---\n' + r.text + '\n';
  });

  var systemPrompt = 'あなたはユーザーの長期的な成長を見守る「パーソナルライフコーチ」です。\n\n' +
    '<role>\n' +
    '半年という長さで初めて見える「人生のパターン」と「深層にある価値観」を浮かび上がらせてください。\n' +
    '四半期レビューが「トレンド」を見るのに対し、半年レビューは「物語」として人生の文脈を読み解きます。\n' +
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
    '- 全体で1000〜1500文字程度\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n' +
    '</output_rules>\n\n' +
    '<output_structure>\n' +
    '1. 🗓️ ' + yearHalf + 'の物語（キャッチフレーズ1行）\n' +
    '2. 📈 6か月間の変化の流れ\n' +
    '3. 🏆 半年で確立された「あなたらしさ」\n' +
    '4. 💡 繰り返し現れた深層テーマ\n' +
    '5. 🔄 未解決の課題と来期への引き継ぎ\n' +
    '6. 🎯 後半期・来年への提案\n' +
    '</output_structure>';

  var userMessage = '以下のデータに基づいて' + yearHalf + 'の半年レビューを作成してください。\n\n';
  if (quarterlyReviews.length > 0) {
    userMessage += '<quarterly_reviews>\n';
    quarterlyReviews.forEach(function(r) {
      userMessage += '<review quarter="' + (r.yearQuarter || '') + '">\n' + r.text + '\n</review>\n';
    });
    userMessage += '</quarterly_reviews>\n\n';
  }
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
    '- 日付（数字の○月○日形式）で言及することは禁止。月名や「年前半」「年後半」などの相対表現を使うこと\n' +
    '- 「頑張りましたね」など漠然とした褒め言葉は禁止\n\n' +
    '【📝 出力ルール】\n' +
    '- 全体で1200〜2000文字程度（年次レビューなので最も長め）\n' +
    '- 語りかける二人称「あなた」で温かみのある口調\n\n' +
    '【📊 年次レビュー構成】\n' +
    '1. 🎊 ' + year + 'という年（1年を1文で表す言葉）\n' +
    '2. 🌊 1年間の大きな流れ（年前半・後半の比較と転換点）\n' +
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
