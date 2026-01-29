# LINE Diary Bot (GAS)

LINEで送ったメッセージや写真を、自動でNotionデータベースにライフログとして記録するGoogle Apps Script (GAS) 製のボットです。
Google Gemini API を活用し、送信内容から「タイトル」「気分」「タグ」を自動生成してデータベースに整理します。

また、**週に一度、蓄積されたログをAIが分析し、あなたの専属コーチとして「週次レビュー」をLINEにプッシュ通知する機能**も備えています。

## 機能

* **Notion自動同期:** LINEのメッセージをNotionのデータベースに自動で蓄積。
* **AI解析 (Gemini):** 日記の本文や画像をAIが解析し、適切な「タイトル」「気分アイコン」「タグ」を自動で付与。
* **週次レビュー (New!):** 毎週指定した日時に、過去1週間分のログをAIが分析。「進捗」「コンディション」「メンタル」の観点からフィードバックをLINEで通知します。
* **パーソナライズ:** あなたの目標や状況（例：受験勉強中、筋トレ重視など）を設定することで、AIのアドバイス内容を自分専用にカスタマイズ可能。
* **画像管理:** 送信された写真はGoogle Driveに保存され、Notionには「閲覧用のDriveリンク」が自動記載されます。

## 必要要件

* **LINE Botの作成:** LINE Developersで新規チャネル（Messaging API）を作成する必要があります。
* **Google アカウント:** (Google Apps Script / Google Drive / Google AI Studio)
* **Notion アカウント:** (Notion Integration)

## セットアップ手順

### 1. LINE Bot (チャネル) の作成
1. LINE Developers コンソールにログインし、新規チャネル（Messaging API）を作成してください。
2. 作成後、「チャネルアクセストークン」を発行しておきます。

### 2. Google Driveの準備
1. Google Driveに、写真を保存するための**「専用フォルダ」を新規作成してください**（フォルダ名は自由です）。
   * ※ ここで作成したフォルダの ID が後で必要になります。

### 3. GASプロジェクトの作成
1. このリポジトリをクローン、またはコードをコピーして、新規 Google Apps Script プロジェクトを作成します。
2. GASエディタ左側の「サービス」から **Google Drive API** を追加して有効化します。

### 4. 環境変数の設定
GASエディタの「プロジェクトの設定（歯車アイコン）」 > 「スクリプト プロパティ」を開き、以下のキーと値を設定してください。
（各IDの取得方法はページ下部の「補足」を参照してください）

| プロパティ名 | 必須 | 説明 |
| --- | --- | --- |
| `LINE_TOKEN` | 必須 | LINE Botのチャネルアクセストークン |
| `GEMINI_API_KEY` | 必須 | Google AI Studioで発行したAPIキー |
| `NOTION_TOKEN` | 必須 | Notionインテグレーションのトークン |
| `NOTION_DB_ID` | 必須 | 保存先のNotionデータベースID |
| `DRIVE_FOLDER_ID` | 必須 | 手順2で作ったフォルダのID |
| `LINE_USER_ID` | **必須** | 週次レビューを送る宛先（あなたのLINEユーザーID） |
| `USER_PROFILE` | 推奨 | AIに教えるあなたの前提情報（詳細は後述） |

### 5. Notionデータベースの設定（重要）
Notionデータベースを新規作成し、以下のプロパティ名と選択肢を**一字一句正確に**設定してください。これらが一致していないと保存に失敗します。

| プロパティ名 | 種類 | 設定すべき選択肢 (オプション) |
| --- | --- | --- |
| **Name** | タイトル | (設定不要) |
| **Mood** | セレクト | `🤩`, `😊`, `😐`, `😰`, `😡` |
| **Tags** | マルチセレクト |`研究`, `開発`, `健康`, `勉強`, `評価`, `資産`, `購入`, `恋愛`, `食事`, `写真`, `その他` |

> **💡 タグのカスタマイズについて**
> このタグリストは、開発者のライフスタイルに合わせて定義されています。
> **とりあえず動かしたい場合**は、上記の通りに設定してください。
> ご自身の生活に合わせて変更したい場合は、以下の2箇所を修正してください。
> 1. `コード.js` 冒頭の `TAGS` 定数
> 2. **`callGeminiAPI` 関数内**にある `systemPrompt`（AIへの指示定義）

※ Notionインテグレーションを、対象のデータベースページに「コネクト（接続）」することを忘れないでください。

### 6. 週次レビュー用トリガーの設定
AIによる週次レビューを有効にするため、自動実行のタイマーを設定します。

1. GASエディタ左メニューの「トリガー（時計アイコン）」をクリック。
2. 「トリガーを追加」を選択。
3. 以下のように設定して保存します。
   * 実行する関数: **`sendWeeklyReview`**
   * イベントのソース: **時間主導型**
   * タイプ: **週ベースのタイマー**
   * 曜日: **日曜日**（または任意の曜日）
   * 時刻: **20:00 〜 21:00**（または任意の時間）

### 7. デプロイとWebhook設定
1. GASエディタ右上の「デプロイ」 > 「新しいデプロイ」を選択。
2. 種類の選択: **ウェブアプリ**
3. アクセスできるユーザー: **全員**
4. 「デプロイ」を実行し、発行された **ウェブアプリURL** をコピーします。
5. LINE Developersコンソールの「Messaging API設定」にて、**Webhook URL** に上記URLを貼り付け、「Webhookの利用」をオンにします。

---

## カスタマイズ：USER_PROFILE について

スクリプトプロパティ `USER_PROFILE` にあなたの情報を入力することで、週次レビューがパーソナライズされます。
以下のようなテキストを入力しておくと、AIがそれを前提としてアドバイスしてくれます。

**設定例:**
```text
【属性】
大学4年生（工学部）。現在は卒業論文の執筆と研究シミュレーションの追い込みが最優先事項。

【性格・ルーティン】
毎朝の自重トレーニングを欠かさないストイックな性格。
精神論よりも、論理的で具体的な改善策を好む。
```

## 補足：各種ID・キーの取得方法詳細

<details>
<summary><strong>LINE_TOKEN (チャネルアクセストークン)</strong></summary>

1. [LINE Developers コンソール](https://developers.line.biz/console/) にログイン。
2. チャネルを選択し、「Messaging API設定」タブを開く。
3. 一番下にある「チャネルアクセストークン（長期）」の発行ボタンを押してコピー。
</details>

<details>
<summary><strong>LINE_USER_ID (あなたのID)</strong></summary>

1. LINE Developers コンソールの「チャネル基本設定」タブを開く。
2. ページ下部にある「あなたのユーザーID」を探す。
3. `U` から始まる33文字程度の文字列をコピー。
</details>

<details>
<summary><strong>GEMINI_API_KEY</strong></summary>

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス。
2. 左上の「Get API key」をクリック。
3. 「Create API key」をクリックし、「Create API key in new project」を選択。
</details>

<details>
<summary><strong>NOTION_TOKEN (インテグレーションの作成)</strong></summary>

1. [Notion My Integrations](https://www.notion.so/my-integrations) にアクセス。
2. 「新しいインテグレーション」をクリック。
3. **基本情報**を入力:
   * **種類:** 内部インテグレーション（デフォルトのまま）
   * **名前:** わかりやすい名前（例: `DiaryBot`）
   * **機能:** 「コンテンツを読み取る」「コンテンツを更新」「コンテンツを挿入」すべてにチェックが入っていることを確認。
4. 「保存」をクリック。
5. 表示された **「内部インテグレーションシークレット」** をコピー（これが `NOTION_TOKEN` です）。
</details>

<details>
<summary><strong>【重要】Notionデータベースへの接続 (コネクト)</strong></summary>

**※ この作業を忘れるとボットは動きません。**

1. 保存先にしたい Notion のデータベースページを開く。
2. 右上の **「...（3点リーダー）」** メニューをクリック。
3. **「接続 (Connect)」** または **「接続先を追加」** をクリック。
4. 先ほど作成したインテグレーション（例: `DiaryBot`）を検索して選択し、アクセスを許可してください。
</details>

<details>
<summary><strong>NOTION_DB_ID (データベースID)</strong></summary>

1. ブラウザで Notion のデータベースページを開く（フルページ表示）。
2. ブラウザのアドレスバー（URL）を確認する。
   * 形式: `https://www.notion.so/myworkspace/`**`a1b2c3d4e5f64g7h8i9j0k1l2m3n4o5p`**`?v=...`
3. `notion.so/` の後ろから `?` の前までの **32桁の英数字** が ID です。
   * 上記の例なら `a1b2c3d4e5f64g7h8i9j0k1l2m3n4o5p` の部分だけをコピーしてください。
</details>

<details>
<summary><strong>DRIVE_FOLDER_ID</strong></summary>

1. Google Drive で作成した保存用フォルダを開く。
2. ブラウザのURLバーを確認。末尾の `folders/` より後ろの文字列がID。
</details>

## ライセンス
This project is licensed under the MIT License.