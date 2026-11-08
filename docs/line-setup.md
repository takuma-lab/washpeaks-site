# LINE 投稿ボットの準備手順

上から順に進めます。所要時間の目安は 1〜2 時間です。

## 0. 用意するもの

- [ ] GitHub アカウント
- [ ] Cloudflare アカウント
- [ ] LINE ビジネスID（LINE公式アカウントの作成に使用）
- [ ] Google アカウント（Gemini API キーの発行に使用）
- [ ] Node.js（LTS 版）: https://nodejs.org ── 設定を送り込む `wrangler` コマンドに必要

## 1. GitHub にサイトを置く

1. GitHub で **非公開（Private）** リポジトリ `washpeaks-site` を作る
2. このフォルダ（`washpeaks-site/`）の中身をそのリポジトリに登録する
3. 記事を書き込むためのトークンを作る
   - GitHub →「Settings」→「Developer settings」→「Fine-grained tokens」→「Generate new token」
   - Repository access: `washpeaks-site` のみ
   - Permissions: **Contents → Read and write**
   - 有効期限: 1年など（**期限が切れると公開できなくなる**ので、更新日をカレンダーに登録）
   - 表示されたトークンを控える（→ 手順5で使う）

## 2. Cloudflare Pages でサイトを公開する

1. Cloudflare →「Workers & Pages」→「作成」→「Pages」→「Git に接続」→ `washpeaks-site` を選択
2. ビルド設定:

   | 項目 | 値 |
   |---|---|
   | ビルドコマンド | `python3 build.py` |
   | ビルド出力ディレクトリ | `dist` |
   | 本番ブランチ | `main` |

3. 公開された URL（例 `https://washpeaks.pages.dev`）を控え、次の2か所に書く
   - `site.json` の `url`
   - `worker/wrangler.toml` の `SITE_URL`

## 3. LINE公式アカウントを作る

1. https://www.linebiz.com/jp/entry/ から LINE公式アカウントを作成（無料プラン）
2. LINE Official Account Manager →「設定」→「Messaging API」→「Messaging APIを利用する」
3. LINE Official Account Manager →「応答設定」
   - **応答メッセージ: オフ**（オンだと自動返信がボットの返事と混ざる）
   - **Webhook: オン**
4. LINE Developers コンソール（https://developers.line.biz/console/）で、作成されたチャネルを開く
   - 「チャネル基本設定」→ **チャネルシークレット** を控える
   - 「Messaging API設定」→ **チャネルアクセストークン（長期）** を発行して控える

## 4. Gemini の API キーを作る

1. Google AI Studio（https://aistudio.google.com/）→「Get API key」→ キーを作成して控える
2. 顧客の写真を扱うため、**課金を有効にした有料枠で使う**のを推奨（無料枠は入力内容が Google の製品改善に使われる）

OpenAI を使う場合は https://platform.openai.com/ で API キーを作成。

## 5. ボットを Cloudflare に送り込む

ターミナルで:

```bash
cd washpeaks-site/worker
npm install
npx wrangler login                     # ブラウザで Cloudflare にログイン
npx wrangler kv namespace create KV    # 表示された id を wrangler.toml の kv_namespaces.id に貼る
```

`wrangler.toml` の `GITHUB_REPO` を `GitHubユーザー名/washpeaks-site` に書き換えてから、秘密情報を登録する（1つずつ聞かれるので貼り付ける）:

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put REGISTER_CODE        # クライアントに伝える合言葉（推測されにくいもの）
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

最後に表示される URL（例 `https://washpeaks-line-bot.xxxx.workers.dev`）を控える。

## 6. LINE と接続する

1. LINE Developers →「Messaging API設定」→「Webhook URL」に
   `https://washpeaks-line-bot.xxxx.workers.dev/line/webhook` を入力
2. 「検証」を押して「成功」と出ればOK
3. 「Webhookの利用」をオン

## 7. 動作確認

1. スマホで LINE公式アカウントを友だち追加
2. `登録 合言葉` と送る →「登録しました」
3. 写真を1〜3枚とメモを送り、`送信` と送る
4. 届いたボタンを開き、記事が作成されるのを確認
5. 「公開する」→ 数分後にサイトのブログに出ることを確認
6. 確認後、テスト記事は GitHub の `content/blog/` から削除する

## 運用メモ

- **AI を切り替える**: `wrangler.toml` の `AI_PROVIDER` を `openai` にし、`npx wrangler secret put OPENAI_API_KEY` → `npx wrangler deploy`
- **AI の文章ルールを変える**: `worker/src/prompt.md` を編集 → `npx wrangler deploy`
- **カテゴリを増やす**: `site.json` の `blog.categories` と `wrangler.toml` の `CATEGORIES` の両方を変更
- **投稿者を追加する**: 合言葉を伝えるだけ。合言葉を変えるときは `npx wrangler secret put REGISTER_CODE`
- **動作ログを見る**: `npx wrangler tail`
- **公開した記事を取り消す**: GitHub で該当の `.md` を削除（または `draft: true` を追記）→ 自動で再公開
