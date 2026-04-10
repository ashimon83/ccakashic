# ccsessions

Claude Code のセッションログ (`~/.claude/projects/`) をブラウザで見やすく閲覧するためのCLIツール。

## Usage

### npx

```bash
npx ccsessions
```

### リポジトリから直接実行

```bash
git clone git@github.com:ashimon83/ccsessions.git
cd ccsessions
npm start
```

ローカルHTTPサーバーが起動し、ブラウザが自動で開きます。

## Features

- **全てブラウザ内で完結** — プロジェクト一覧 → セッション一覧 → 会話詳細
- **チャット風レイアウト** — ユーザー/アシスタントのメッセージをバブル表示
- **ツール呼び出しの折りたたみ** — Bash, Read, Edit 等のツール実行を `<details>` で折りたたみ表示
- **diff表示** — ファイル編集の差分を赤/緑でハイライト
- **日付ナビゲーション** — サイドナビ + stickyヘッダーで日付間をジャンプ
- **トークン統計** — セッションごとの入出力トークン、キャッシュヒット率、所要時間を表示
- **サブエージェント会話のインライン表示** — Agent tool_useの中にネストして表示
- **パーマリンク** — 各メッセージのタイムスタンプからURL共有可能
- **ダークモード** — `prefers-color-scheme` に自動追従
- **フィルター検索** — 一覧ページでインクリメンタル絞り込み
- **キーボード操作** — `j` / `k` でメッセージ間移動
- **依存パッケージ 0** — Node.js 標準モジュールのみ

## Options

```bash
# ポート指定（デフォルト: 3333）
CC_HISTORY_PORT=3000 npx ccsessions
```

## Requirements

- Node.js >= 18
