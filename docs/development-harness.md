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

`/api/*`の入口ガード（`apps/worker/src/guard.ts`）が読む運用値。会ごとに変わるため`wrangler.jsonc`の`vars`へ値を書かない。どれも未設定のままでも既定動作で動くので、ローカル開発とE2Eでは設定不要である。

公開APIには、このほかに固定の上限が2つある。どちらも環境変数ではなくコード上の定数で、設定不要である。

- チャット送信: 1チーム1分あたり`CHAT_RATE_LIMIT_PER_MINUTE`通（既定20）。超過は429。
- スレッド作成: 手動追加が`MAX_MANUAL_THREADS_PER_TEAM`件（25）、ステージが自動で開くものが`MAX_STAGE_THREADS_PER_TEAM`件（8。ステージ5本＋改名・再設計の余裕）。作成時の`kind`（`"manual"` / `"stage"`、既定は`manual`）で振り分け、**枠は独立に数える**——上限を1本にすると、手動スレッドを作りすぎたチームがステージ進行そのものを止めてしまう。`kind`を持たない既存スレッドは`manual`として数える。超過は409で、Durable Objectには保存しない。

**Origin検証は認証ではない。** Originヘッダーも、それが無いことも、非ブラウザのクライアント（curl、スクリプト）は自由に詐称できる。この層で防げるのは「参加者のブラウザが、他サイトに置かれたページや埋め込みからAPIを叩かされる」経路——CSRFと他サイトからの読み取り——であって、攻撃者が自分の手元から直接叩くことではない。後者はチームコードの規則判定（配布した6桁コードを知らないと入れない）とレート制限で被害を抑える構成にしてある。推測不能なセッション資格情報の導入は本実装フェーズの課題とする。

| 変数 | 未設定時の既定 | 設定する場面 |
|---|---|---|
| `ALLOWED_ORIGINS` | 同一オリジンのみ | **追加で**許可するオリジンをカンマ区切りで列挙する（末尾スラッシュと空白は無視）。同一オリジン（リクエストURLと同じorigin）は設定の有無に関わらず常に許可されるので、ここへ書く必要はない——書き換えではなく追加なので、1つ足したとたんに配信元が弾かれる、ということは起きない。別オリジンのページからAPIを叩くとき（開発時に`localStorage.hellApiBase`で別ポートの`wrangler dev`へ向ける場合など）に設定する。許可した別オリジンには`Access-Control-Allow-Origin`と`Vary: Origin`を返し、`OPTIONS /api/*`のpreflightへ204を返す |
| `EVENT_NO` | 6桁なら任意のコードで入室できる（ローカル開発とE2Eを壊さないための意図的なfail-open） | 本番。**開催回を2桁数字（`02`のように0埋め）で設定する。** チームコードは`[開催回2桁][チーム番号4桁]`で、上2桁が`EVENT_NO`と一致し、下4桁が1〜`TEAM_MAX`のコードだけを通す。規則から外れたコードは入室・チーム操作・リーダーボード購読・進捗記録のすべてで404になり、Durable ObjectもD1の行も作らない。**2桁数字でない値（空文字・1桁・3桁・非数）はfail-closedで全コードを拒否する**（`guards.eventNo`が`"invalid"`）。秘匿情報ではない（入室資格はコード全体であって開催回ではない）が、開催回ごとに変えるので`wrangler secret put EVENT_NO`で与える |
| `TEAM_MAX` | 100 | チーム番号の上限を変えるとき。受け付けるのは1〜9999の数字だけで、**0・負・非数・空文字・9999超はfail-closedで全コードを拒否する**（`guards.teamMax`が`"invalid"`）——ここを既定へ倒すと、書き損じたまま「設定したつもりの上限」と違う範囲で当日が動く。`EVENT_NO`が未設定なら規則そのものが効かないので、この値は読まれない |
| `CHAT_RATE_LIMIT_PER_MINUTE` | 20 | 1チームが1分あたりに送れるチャット数を変えるとき。受け付けるのは1〜600の整数だけで、範囲外・非数値・`1e100`のような指数表記は既定の20へ倒す（実際に効いている値は`/api/health`の`guards.chatRateLimitPerMinute`に出る）。超過は429と`Retry-After`で返し、OpenAIを呼ばずユーザーメッセージも保存しない |

チームコードの判定は3状態しかない。どの状態にいるかは`GET /api/health`の`guards`だけで見分けられる。

| 状態 | 条件 | 挙動 | `guards` |
|---|---|---|---|
| fail-open | `EVENT_NO`未設定 | 6桁なら任意のコードが通る | `eventNo: false`、`teamMax: false` |
| 規則あり | `EVENT_NO`が2桁数字、`TEAM_MAX`が1〜9999 | 上2桁が一致し下4桁が1〜`TEAM_MAX`のコードだけ通る | `eventNo: "02"`、`teamMax: 100` |
| fail-closed | どちらかが壊れている | 全コードを拒否（全チームが404） | 壊れているほうが`"invalid"` |

本番デプロイ前の手順は次のとおり。

1. 開催回を決め、チームコードを`[開催回2桁][チーム番号4桁]`で配る（第2回のチーム1なら`020001`）。**予備コードは登録不要で、次の番号（`020007`、`020008`…）をそのまま配ればよい。** 開催回を切り替えれば、前回開催やリハーサルのチームは入室も配信もできなくなる。
2. `wrangler secret put EVENT_NO` で開催回を設定する（`apps/worker`で実行）。チーム数が100を超える場合だけ`wrangler deploy --var TEAM_MAX:200`のように上限も設定する。Cloudflareダッシュボードの Workers &gt; 対象Worker &gt; Settings &gt; Variables から入れてもよい。
3. 配信版はモックHTMLをWorkerのAssetsから同一オリジンで配るため、`ALLOWED_ORIGINS`は未設定のままでよい。別オリジン配信へ切り替えたときだけ設定する。
4. デプロイ後、`GET /api/health`の`guards`で設定が効いているか確認する。`{"status":"ok","guards":{"eventNo":"02","teamMax":100,"allowedOrigins":false,"chatRateLimitPerMinute":20}}`のように返るので、次の2つを必ず見る。許可オリジンの値は伏せてあるので、この応答から漏れない。
   - **`eventNo`が当日の開催回であること。** `false`なら`EVENT_NO`の設定漏れで、6桁なら誰でも入れる状態のまま本番を迎えることになる。`"invalid"`なら値が壊れている（2桁数字でない）状態で、**全チームが404で入室できない**——書き損じをここで捕まえる。前回の開催回のままなら、当日配ったコードが全部404になる。
   - **`teamMax`が配布したチーム番号の最大以上であること。** `"invalid"`なら`TEAM_MAX`の書き損じで全チームが入室できない。既定のまま運用するなら`100`と出る。
5. ブラウザから配布コードで入室できることと、別の開催回のコード（`010001`など）や上限を超えるチーム番号が404で弾かれることを確認する。素の`curl -X POST https://<worker>/api/session -d '{"teamCode":"100001"}'`はOriginが無いので403になるが、これはガードが配線されている確認であって防御の強さの確認ではない（`-H "Origin: https://<worker>"`を付ければ通る。上の注記を参照）。
