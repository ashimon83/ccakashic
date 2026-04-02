# cc-history

Claude Code のセッションログ (`~/.claude/projects/`) をブラウザで見やすく閲覧するためのCLIツール。

## Usage

```bash
npx cc-history
```

ローカルHTTPサーバーが起動し、ブラウザが自動で開きます。

## Features

- **全てブラウザ内で完結** — プロジェクト一覧 → セッション一覧 → 会話詳細
- **チャット風レイアウト** — ユーザー/アシスタントのメッセージをバブル表示
- **ツール呼び出しの折りたたみ** — Bash, Read, Edit 等のツール実行を `<details>` で折りたたみ表示
- **diff表示** — ファイル編集の差分を赤/緑でハイライト
- **日付ナビゲーション** — サイドナビ + stickyヘッダーで日付間をジャンプ
- **ダークモード** — `prefers-color-scheme` に自動追従
- **フィルター検索** — 一覧ページでインクリメンタル絞り込み
- **キーボード操作** — `j` / `k` でメッセージ間移動
- **依存パッケージ 0** — Node.js 標準モジュールのみ

## Options

```bash
# ポート指定
CC_HISTORY_PORT=3000 npx cc-history
```

## Requirements

- Node.js >= 18
