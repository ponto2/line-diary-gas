# LINE Diary Bot (GAS)

LINEで送ったメッセージや写真を、自動でNotionデータベースにライフログとして記録するGoogle Apps Script (GAS) 製のボットです。
Google Gemini API を活用し、送信内容から「タイトル」「気分」「タグ」を自動生成してデータベースに整理します。

**※ 本ボットはログ保存専用です。LINEへの自動返信機能は実装していません。**

## 機能

* **Notion自動同期:** LINEのメッセージをNotionのデータベースに自動で蓄積。
* **AI解析 (Gemini):** 日記の本文や画像をAIが解析し、適切な「タイトル」「気分アイコン」「タグ」を自動で付与。
* **画像管理:** 送信された写真はGoogle Driveに保存され、Notionには「閲覧用のDriveリンク」が自動記載されます（Notion上で直接プレビューできるのが理想ですが，セキュリティとの両立が難しく断念しました）。

## 必要要件

* **LINE Botの作成:** LINE Developersで新規チャネル（Messaging API）を作成する必要があります。
* **Google アカウント:** (Google Apps Script / Google Drive / Google AI Studio)
* **Notion アカウント:** (Notion Integration)

## セットアップ手順

### 1. LINE Bot (チャネル) の作成
1. LINE Developers コンソールにログインし、新規チャネル（Messaging API）を作成してください。
2. 作成後、「チャネルアクセストークン」を発行しておきます（後で使います）。

### 2. Google Driveの準備
1. Google Driveに、写真を保存するための**「専用フォルダ」を新規作成してください**（フォルダ名は自由です）。
   * ※ ここで作成したフォルダの ID が後で必要になります。

### 3. GASプロジェクトの作成
1. このリポジトリをクローン、またはコードをコピーして、新規 Google Apps Script プロジェクトを作成します。
2. GASエディタ左側の「サービス」から **Google Drive API** を追加して有効化します。

### 4. 環境変数の設定
GASエディタの「プロジェクトの設定（歯車アイコン）」 > 「スクリプト プロパティ」を開き、以下のキーと値を設定してください。
（各IDの取得方法はページ下部の「補足」を参照してください）

| プロパティ名 | 説明 |
| --- | --- |
| `LINE_TOKEN` | LINE Botのチャネルアクセストークン |
| `GEMINI_API_KEY` | Google AI Studioで発行したAPIキー |
| `NOTION_TOKEN` | Notionインテグレーションのトークン |
| `NOTION_DB_ID` | 保存先のNotionデータベースID |
| `DRIVE_FOLDER_ID` | 手順2で作ったフォルダのID |

### 5. Notionデータベースの設定（重要）
Notionデータベースを新規作成し、以下のプロパティ名と選択肢を**一字一句正確に**設定してください。これらが一致していないと保存に失敗します。

| プロパティ名 | 種類 | 設定すべき選択肢 (オプション) |
| --- | --- | --- |
| **Name** | タイトル | (設定不要) |
| **Mood** | セレクト | `🤩`, `😊`, `😐`, `😰`, `😡` |
| **Tags** | マルチセレクト | `研究`, `筋トレ`, `勉強`, `趣味`, `恋愛`, `食事`, `その他` |

※ Notionデータベース上の選択肢を変更する場合，コードにも変更を適用する必要があります。
※ プロパティ名（Mood, Tags）もコード内で指定されているため、英語のまま作成してください。
※ 作成したNotionインテグレーションを、対象のデータベースページに「コネクト（接続）」することを忘れないでください。

### 6. デプロイとWebhook設定
1. GASエディタ右上の「デプロイ」 > 「新しいデプロイ」を選択。
2. 種類の選択: **ウェブアプリ**
3. アクセスできるユーザー: **全員**
4. 「デプロイ」を実行し、発行された **ウェブアプリURL** をコピーします。
5. LINE Developersコンソールの「Messaging API設定」にて、**Webhook URL** に上記URLを貼り付け、「Webhookの利用」をオンにします。

---

## 補足：各種ID・キーの取得方法詳細

<details>
<summary><strong>LINE_TOKEN (チャネルアクセストークン)</strong></summary>

1. [LINE Developers コンソール](https://developers.line.biz/console/) にログイン。
2. 「プロバイダー作成」（名前は適当でOK）→「新規チャネル作成」→「Messaging API」を選択。
3. 必須項目を埋めて作成。
4. 作成したチャネルの「Messaging API設定」タブを開く。
5. 一番下にある「チャネルアクセストークン（長期）」の発行ボタンを押してコピー。
</details>

<details>
<summary><strong>GEMINI_API_KEY</strong></summary>

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス。
2. 左上の「Get API key」をクリック。
3. 「Create API key」をクリックし、「Create API key in new project」を選択。
4. 生成されたキー（`AIza` から始まる文字列）をコピー。
</details>

<details>
<summary><strong>NOTION_TOKEN (インテグレーション)</strong></summary>

1. [Notion My Integrations](https://www.notion.so/my-integrations) にアクセス。
2. 「新しいインテグレーション」をクリック。
3. 名前（例: `DiaryBot`）を入力して送信。
4. 表示された「シークレット（Internal Integration Secret）」をコピー（これが `NOTION_TOKEN` です）。
5. **重要:** Notionのデータベースを開き、右上の「...」→「接続 (Connect)」→「接続先を追加」から、今作ったインテグレーションを選択して許可してください。
</details>

<details>
<summary><strong>NOTION_DB_ID (データベースID)</strong></summary>

1. ブラウザで Notion のデータベースページを開く。
2. URLを確認する。
   * 例: `https://www.notion.so/myworkspace/a1b2c3d4e5f64g7h8i9j0k1l2m3n4o5p?v=...`
3. `notion.so/` の後ろから `?` の前までの **32桁の英数字** が ID です。
   * 上記の例なら `a1b2c3d4e5f64g7h8i9j0k1l2m3n4o5p` の部分。
</details>

<details>
<summary><strong>DRIVE_FOLDER_ID</strong></summary>

1. Google Drive で作成した保存用フォルダを開く。
2. ブラウザのURLバーを確認する。
   * 例: `https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0j`
3. 末尾の `folders/` より後ろの文字列が ID です。
</details>

## ライセンス
This project is licensed under the MIT License.
