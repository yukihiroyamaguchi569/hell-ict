# 地獄のICT

医療従事者向けの、ゲーム型の AI 研修 Web アプリです。

ここでの ICT は Infection Control Team（感染制御チーム）のことです。参加者は架空の病院「聖クロノス総合病院」の感染制御チームとして、次々に起きる課題を AI を使いながら解いていきます。3〜4人で1チームを組み、チームに PC は1台。最初にゴールしたチームが勝ちのレース形式です。

## このリポジトリのシナリオはダミーです

`packages/content` に入っているのは、動作確認とテストのためのダミーシナリオ（`scenarioId = "dummy"`）です。本番の研修で出る問題・答え・台詞とは別物です。本番のシナリオは公開していません。

## 構成

pnpm の monorepo です。

| パス               | 中身                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| `apps/web`         | 参加者が操作する画面（Vue 3 / Vite）                                                    |
| `apps/worker`      | API と配信（Cloudflare Workers）。チームの状態とリーダーボードは Durable Objects に置く |
| `packages/domain`  | ゲームの状態遷移・判定・時間処理（副作用のない関数）                                    |
| `packages/content` | シナリオのデータ（このリポジトリではダミー）                                            |
| `e2e/`             | Playwright の E2E テスト                                                                |

AI の応答は OpenAI API を Worker 経由で呼びます。ブラウザから直接は呼びません。

## 開発の始め方

Node.js 22.18 以上と pnpm（`package.json` の `packageManager` の版）が要ります。

```bash
pnpm install
pnpm dev:worker      # Worker / Durable Objects: http://localhost:8787
pnpm dev             # 画面の開発サーバ（Vite）: http://localhost:5173
pnpm verify:checks   # format・lint・型検査・build・単体テスト
```

`pnpm verify` は E2E まで流します。ポートの変え方、環境変数、テストの分け方は [`docs/development-harness.md`](docs/development-harness.md) を、コードの書き方と検証の規則は [`AGENTS.md`](AGENTS.md) を見てください。

## ライセンス

ライセンスは付けていません。コード・文章・画像・音声の無断転載と再配布はお断りします。
