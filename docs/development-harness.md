# P1A 開発ハーネス

P1Aではゲーム機能を実装せず、以後の実装を安全に行うための境界と検証経路だけを用意する。

## 構成

| 場所              | 責務                                            | 依存できる場所    |
| ----------------- | ----------------------------------------------- | ----------------- |
| `packages/domain` | Pure Function、runtime schema、port（外部境界） | なし              |
| `apps/worker`     | HTTP入力の検証、Cloudflare binding、adapter     | `packages/domain` |
| `apps/web`        | React表示                                       | `packages/domain` |

UIは判定・永続化を持たない。Workerは外部入力を`packages/domain`のschemaで検証してから渡す。OpenAI・Storage・時刻・乱数・IDは`ports`に依存し、テストは`fakes`を使う。OpenAIの本番adapter（`apps/worker/src/openai-gateway.ts`）はP1Cで実装済み。Storage・時刻・乱数・IDの本番adapterは、それぞれ必要になった工程で追加する。依存は外側から内側へ一方向であり、domainはReact・Cloudflare SDK・ストレージをimportしない。

`HarnessCounter`はP1A限定の最小オブジェクトであり、P1Bで撤去した。現在のDO構成と最小状態管理の契約は [P1B 最小状態管理](p1b-minimal-team-state.md) を正とする。

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

### 公開APIガードの環境変数

`/api/*`の入口ガード（`apps/worker/src/guard.ts`）が読む運用値。秘匿情報ではないので`wrangler secret`にはしないが、会ごとに変わるため`wrangler.jsonc`の`vars`へ値を書かない。3つとも未設定のままでも既定動作で動くので、ローカル開発とE2Eでは設定不要である。

| 変数 | 未設定時の既定 | 設定する場面 |
|---|---|---|
| `ALLOWED_ORIGINS` | リクエストURLと同じoriginだけ許可 | 別オリジンのページからAPIを叩くとき（開発時に`localStorage.hellApiBase`で別ポートの`wrangler dev`へ向ける場合など）。カンマ区切り、末尾スラッシュと空白は無視する |
| `TEAM_CODES` | 6桁なら任意のコードで入室できる | 本番。事前配布した6桁コードをカンマ区切りで列挙する。列挙外のコードは404で拒否し、Durable Objectも作らない |
| `CHAT_RATE_LIMIT_PER_MINUTE` | 20 | 1チームが1分あたりに送れるチャット数を変えるとき。超過は429と`Retry-After`で返し、OpenAIを呼ばずユーザーメッセージも保存しない |

本番デプロイ前の手順は次のとおり。

1. 当日配布するチームコードを決める（2026-08-23のテストプレイはチームA〜Gへ`100001`〜`100007`を配った）。
2. `wrangler deploy --var TEAM_CODES:100001,100002,...` で設定する。Cloudflareダッシュボードの Workers &gt; 対象Worker &gt; Settings &gt; Variables から入れてもよい。
3. 配信版はモックHTMLをWorkerのAssetsから同一オリジンで配るため、`ALLOWED_ORIGINS`は未設定のままでよい。別オリジン配信へ切り替えたときだけ設定する。
4. デプロイ後、`curl -X POST https://<worker>/api/session -d '{"teamCode":"100001"}'`が403で拒否されること（Originが無いPOST）と、ブラウザから配布コードで入室できることを確認する。
