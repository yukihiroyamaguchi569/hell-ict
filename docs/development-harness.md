# P1A 開発ハーネス

P1Aではゲーム機能を実装せず、以後の実装を安全に行うための境界と検証経路だけを用意する。

## 構成

| 場所              | 責務                                            | 依存できる場所    |
| ----------------- | ----------------------------------------------- | ----------------- |
| `packages/domain` | Pure Function、runtime schema、port（外部境界） | なし              |
| `apps/worker`     | HTTP入力の検証、Cloudflare binding、adapter     | `packages/domain` |
| `apps/web`        | React表示                                       | `packages/domain` |

UIは判定・永続化を持たない。Workerは外部入力を`packages/domain`のschemaで検証してから渡す。OpenAI・Storage・時刻・乱数・IDは`ports`に依存し、本番adapterはP1C以降、テストは`fakes`を使う。依存は外側から内側へ一方向であり、domainはReact・Cloudflare SDK・ストレージをimportしない。

`HarnessCounter`はチーム状態ではない。Cloudflare Durable Objectsのローカル設定と統合テストを検証するためだけの、P1A限定の最小オブジェクトである。

## 開発と検証

```sh
pnpm install --frozen-lockfile
pnpm dev             # React/Vite: http://localhost:5173
pnpm dev:worker      # Worker/DO: http://localhost:8787
pnpm verify
pnpm verify:full
```

`pnpm verify`はformat、lint、型検査、React/ViteとWorkerのbuild、domain、教材整合、Worker統合、主要E2Eを実行する。`pnpm verify:full`は全E2E、domainへのMutation Testing、重複検査、production dependency監査を追加する。CIも同じscriptを実行し、通常PRは`verify`、手動監査は`verify:full`を使う。

## Cloudflare構成

`apps/worker/wrangler.jsonc`をWorker設定の正とする。compatibility dateは設定時点の日付で、DOはSQLite migration（`v1`）を宣言する。型は`wrangler types`の出力を更新し、設定を変えたPRで型検査に含める。

フロントエンドはCloudflare Pagesへ、WorkerはCloudflare Workersへ配備する予定である。P1Aは本番リソースや秘密情報を作成・接続しない。ローカルWorkerのDurable ObjectはWranglerのローカル永続化を使う。
