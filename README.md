# LINE Diary Bot (GAS)

LINEで送ったメッセージや写真を、自動でNotionデータベースにライフログとして記録するGoogle Apps Script (GAS) 製のボットです。
Google Gemini API を活用し、送信内容から「タイトル」「気分」「タグ」を自動生成してデータベースに整理します。

**※ 本ボットはログ保存専用です。LINEへの自動返信機能はありません。**

## 機能

* **Notion自動同期:** LINEのメッセージをNotionのデータベースに自動で蓄積。
* **AI解析 (Gemini):** 日記の本文や画像をAIが解析し、適切な「タイトル」「気分アイコン」「タグ」を自動で付与。
* **画像管理:** 送信された写真はGoogle Driveに保存され、Notionには「閲覧用のDriveリンク」が自動記載されます（Notionの容量圧迫を回避）。

## 必要要件

* Google アカウント (Google Apps Script / Google Drive)
* LINE Developers アカウント (Messaging API)
* Notion アカウント (Notion Integration)
* Google AI Studio アカウント (Gemini API)

## セットアップ手順

### 1. プロジェクトの準備
1. このリポジトリをクローン、またはコードをコピーして、新規 Google Apps Script プロジェクトを作成します。
2. GASエディタ左側の「サービス」から **Google Drive API** を追加して有効化します。

### 2. 環境変数の設定
GASエディタの「プロジェクトの設定（歯車アイコン）」 > 「スクリプト プロパティ」を開き、以下のキーと値を設定してください。

| プロパティ名 | 説明 | 取得方法 |
| --- | --- | --- |
| `LINE_TOKEN` | LINE Botのチャネルアクセストークン | LINE Developersコンソールで発行 |
| `GEMINI_API_KEY` | GeminiのAPIキー | Google AI Studioで発行 |
| `NOTION_TOKEN` | Notionインテグレーションのトークン | Notion Developersで発行 |
| `NOTION_DB_ID` | 保存先のNotionデータベースID | データベースのURLから取得 |
| `DRIVE_FOLDER_ID` | 画像保存先のGoogle DriveフォルダID | フォルダのURL末尾の文字列 |

### 3. Notionデータベースの設定（重要）
Notionデータベースを新規作成し、以下のプロパティ名と選択肢を**一字一句正確に**設定してください。これらが一致していないと保存に失敗します。

| プロパティ名 | 種類 | 設定すべき選択肢 (オプション) |
| --- | --- | --- |
| **Name** | タイトル | (設定不要) |
| **Mood** | セレクト | `🤩`, `😊`, `😐`, `😰`, `😡` |
| **Tags** | マルチセレクト | `研究`, `筋トレ`, `勉強`, `趣味`, `恋愛`, `食事`, `その他` |

※ プロパティ名（Mood, Tags）もコード内で指定されているため、英語のまま作成してください。
※ 作成したNotionインテグレーションを、対象のデータベースページに「コネクト（接続）」することを忘れないでください。

### 4. デプロイとWebhook設定
1. GASエディタ右上の「デプロイ」 > 「新しいデプロイ」を選択。
2. 種類の選択: **ウェブアプリ**
3. アクセスできるユーザー: **全員**
4. 「デプロイ」を実行し、発行された **ウェブアプリURL** をコピーします。
5. LINE Developersコンソールの「Messaging API設定」にて、**Webhook URL** に上記URLを貼り付け、「Webhookの利用」をオンにします。

## ライセンス
This project is licensed under the MIT License.