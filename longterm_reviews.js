// ============================================================
// 長期レビューシステム (半年 / 年次)
// モデル: Claude Opus 4.8（自動トリガー時）/ Gemini（フォールバック）
// 四半期レビューは廃止（コスト最適化のため）
// ============================================================

// ============================================================
// トリガーエントリーポイント
// ============================================================

/**
 * 半年レビュー: 毎日実行、半年末（6/30, 12/31）のみ動作
 * GASトリガーにこの関数を「日ベース」で設定する
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
 * GASトリガーにこの関数を「日ベース」で設定する
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

function sendHalfYearReview() {
  if (!LINE_USER_ID) return;
  try {
    var now = new Date();
    var half = now.getMonth() < 6 ? '上半期' : '下半期';
    var yearHalf = now.getFullYear() + '年 ' + half;

    // 直近6か月分の月次レビューを取得
    var allMonthly = getMonthlyReviewHistory();
    var recentMonthly = allMonthly.slice(-6);

    if (recentMonthly.length === 0) {
      pushLineMessage('📊 ' + yearHalf + 'の月次レビューの蓄積がないため、半年レビューを生成できません。');
      return;
    }

    var userProfile = PROPS.getProperty('USER_PROFILE') || 'ユーザーは目標達成に向けて努力している人物です。';
    var lastHalfYear = PROPS.getProperty('LAST_HALFYEAR_REVIEW') || '';
    var prompts = buildHalfYearReviewPrompt(userProfile, recentMonthly, lastHalfYear, yearHalf);
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, AI_MODELS.claude.longTermReview);

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
    var result = generateTextWithFallback(prompts.geminiPrompt, prompts.systemPrompt, prompts.userMessage, true, AI_MODELS.claude.longTermReview);

    if (result.text) {
      var header = '🎊 【' + year + ' 年次レビュー】\n\n';
      pushLineMessage(header + truncateForLine(result.text, 5000 - header.length));
      saveAnnualReview(result.text);
      // 年次レビュー後に月次・半年の蓄積をクリアして翌年に備える
      clearMonthlyReviewHistory();
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
