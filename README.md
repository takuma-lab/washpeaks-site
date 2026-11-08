# Wash Peaks 公式サイト

静的サイト＋ブログ。`python3 build.py` で `dist/` に公開用ファイルを生成し、Cloudflare Pages で公開する。

ブログは LINE から投稿できる（写真＋メモ → AI が記事作成 → 投稿者が確認 → 公開）。しくみは `docs/architecture.md`、準備は `docs/line-setup.md`。

## フォルダ構成

```
washpeaks-site/
├── site.json            サイト設定（URL・メニュー・ブログのカテゴリ）
├── build.py             ビルド＆記事チェック（Python標準ライブラリのみ）
├── src/
│   ├── pages/           各ページ（{{header}} {{cta}} {{footer}} はビルド時に埋め込み）
│   ├── partials/        共通パーツ（ヘッダー・相談バナー・フッター）
│   └── assets/          css / js / img（そのまま dist にコピー）
├── templates/           ブログの一覧・記事ページの雛形
├── content/blog/        ★ブログ記事（.md）と images/ ── AIが追加するのはここだけ
├── worker/              LINE投稿ボット（Cloudflare Worker）
├── docs/
│   ├── architecture.md      公開・LINE投稿のしくみ
│   ├── line-setup.md        LINE投稿ボットの準備手順
│   ├── post-format.md       記事ファイルの書式
│   └── ai-instructions.md   ChatGPT / Gemini で手動作成するときの指示文
└── dist/                ビルド結果（自動生成。編集しない／Git管理しない）
```

## よく使う操作

```bash
python3 build.py            # ビルド
python3 build.py --check    # 記事のチェックだけ
python3 -m http.server -d dist 8000   # http://localhost:8000 で確認
```

## 編集の目安

| やりたいこと | 編集するファイル |
|---|---|
| ブログ記事を追加 | `content/blog/` に .md と画像を追加 |
| メニュー項目の変更 | `site.json` の `nav` |
| ブログのカテゴリ追加 | `site.json` の `blog.categories` |
| ヘッダー・フッターの変更 | `src/partials/*.html` |
| 各ページの文章 | `src/pages/*.html` |
| デザイン | `src/assets/css/style.css` |

## 公開前の残作業

- 「○○」の仮置き（料金・会社概要・事例など）を実データに差し替える
- 「業界初」「導入実績100社以上」「28%削減」などの表現は、根拠を確認してから使う
- フォームの送信先、LINE・SNSのリンク、地図を設定する
- サンプル記事 `content/blog/2026-11-08-coin-laundry-checklist.md` と画像を削除する
