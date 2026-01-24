# LINE Diary Bot (GAS)

LINEで送ったメッセージをNotionに日記として保存し、画像はGoogle Driveに自動保存するGoogle Apps Script (GAS) 製のボットです。
Gemini APIを利用して、日記の内容に基づいた返信や要約を行います。

## 機能

* **日記保存:** LINEのテキストメッセージをNotionのデータベースに自動保存。
* **画像保存:** 送信された画像をGoogle Driveに保存し、Notionに埋め込み表示。
* **AI返信:** Google Gemini APIを使用し、日記の内容に寄り添った返信を生成。

## 必要要件

* Google アカウント (Google Apps Script / Google Drive)
* LINE Developers アカウント (Messaging API)
* Notion アカウント (Notion Integration)
* Google AI Studio アカウント (Gemini API)

## セットアップ手順

### 1. プロジェクトの準備
1. このリポジトリをクローン、またはコードをコピーして、新規 Google Apps Script プロジェクトを作成します。
2. Google Drive API を「サービス」から追加して有効化します。

### 2. 環境変数の設定
GASエディタの「プロジェクトの設定（歯車アイコン）」 > 「スクリプト プロパティ」を開き、以下のキーと値を設定してください。
**※コード内に直接APIキーを書かないでください。**

| プロパティ名 | 説明 | 取得方法 |
| --- | --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Botのアクセストークン | LINE Developersコンソールで発行 |
| `GEMINI_API_KEY` | GeminiのAPIキー | Google AI Studioで発行 |
| `NOTION_TOKEN` | Notionインテグレーションのトークン | Notion Developersで発行 |
| `NOTION_DATABASE_ID` | 保存先のNotionデータベースID | データベースのURLから取得 |
| `DRIVE_FOLDER_ID` | 画像保存先のGoogle DriveフォルダID | フォルダのURL末尾の文字列 |

### 3. Notionデータベースの設定
Notionデータベースには、最低限以下のプロパティを作成してください。

* **名前 (タイトル):** `Date` (日付など)
* **テキスト:** `Content` (日記本文)
* **ファイル＆メディア:** (必要に応じて)
* ※ 作成したNotionインテグレーションを、対象のデータベースページに「コネクト（接続）」することを忘れないでください。

### 4. デプロイ
1. GASエディタ右上の「デプロイ」 > 「新しいデプロイ」を選択。
2. 種類の選択: **ウェブアプリ**
3. アクセスできるユーザー: **全員**
4. 「デプロイ」を実行し、発行された **ウェブアプリURL** をコピーします。

### 5. Webhookの設定
1. LINE Developersコンソールの「Messaging API設定」を開きます。
2. **Webhook URL** に、先ほどコピーしたウェブアプリURLを貼り付けます。
3. 「Webhookの利用」をオンにします。

## ライセンス
This project is licensed under the MIT License.
