# P1A 開発ハーネス

P1Aではゲーム機能を実装せず、以後の実装を安全に行うための境界と検証経路だけを用意する。

## 構成

| 場所              | 責務                                            | 依存できる場所    |
| ----------------- | ----------------------------------------------- | ----------------- |
| `packages/domain` | Pure Function、runtime schema、port（外部境界） | `packages/content` |
| `packages/content` | 画面に出す教材・台詞・メール・ビューア本文の型付きデータ | なし |
| `apps/worker`     | HTTP入力の検証、Cloudflare binding、adapter     | `packages/domain` |
| `apps/web`        | Vue表示                                         | `packages/domain` |

UIは判定・永続化を持たない。Workerは外部入力を`packages/domain`のschemaで検証してから渡す。OpenAI・Storage・時刻・乱数・IDは`ports`に依存し、テストは`fakes`を使う。OpenAIの本番adapter（`apps/worker/src/openai-gateway.ts`）はP1Cで実装済み。Storage・時刻・乱数・IDの本番adapterは、それぞれ必要になった工程で追加する。依存は外側から内側へ一方向であり、domainはVue・Cloudflare SDK・ストレージをimportしない。判定が使う教材データ（S5の報告書・発熱患者一覧、S6のメール本文・候補画像の種類など）は`packages/content`を正とし、domainはそれを読む（#260）。contentはzodだけに依存する純粋なデータなので、domainの副作用のなさは崩れない。contentはdomainをimportしない（循環になるため。ESLintで止める）。

`HarnessCounter`はP1A限定の最小オブジェクトであり、P1Bで撤去した。現在のDO構成と最小状態管理の契約は [P1B 最小状態管理](p1b-minimal-team-state.md) を正とする。

## 開発と検証

```sh
pnpm install --frozen-lockfile
pnpm dev             # Vue/Vite: http://localhost:5173
pnpm dev:worker      # Worker/DO: http://localhost:8787
pnpm verify
pnpm verify:full
```

### ポートの切り替え

ローカル開発とE2Eが使うポートは環境変数で上書きできる。既定のままなら設定は要らない。worktreeを2つ同時に走らせるときだけ、片方をずらす。

| 変数 | 既定 | 何のポートか |
|---|---|---|
| `WORKER_PORT` | 8787 | `wrangler dev`（Worker/DO、Vueアプリ`/`の配信元）。Playwrightの`baseURL`であり、`pnpm dev`のViteが`/api`をproxyする先でもある |
| `OPENAI_STUB_PORT` | 8789 | E2EのOpenAIスタブ（`e2e/openai-stub.mjs`）。Workerへは`--var OPENAI_BASE_URL`で渡る |

```sh
WORKER_PORT=8801 OPENAI_STUB_PORT=8802 pnpm test:e2e
WORKER_PORT=8801 pnpm dev:worker
```

E2EはVite開発サーバーを起動しない。VueアプリのE2E（`e2e/shell/`）も、本番と同じく`pnpm build:testplay`が`apps/worker/public/`へ置いたビルドを、Workerの`/`から同一オリジンで開く。

TypeScript側の正は`e2e/ports.ts`で、`playwright.config.ts`と`e2e/`配下はここをimportする。specから直接`process.env`を読まない——1箇所の読み漏れが、クリップボード権限の付与漏れやスタブ照会の空振りという無関係に見える失敗になる。`apps/web/vite.config.ts`と`e2e/openai-stub.mjs`は、アプリ側の設定をE2Eコードへ依存させないため、同じ変数名・既定値・受け付ける書式（10進数字だけ、1〜65535）を`process.env`から読み直す。`apps/worker`の`dev` scriptは`${WORKER_PORT:-8787}`のシェル展開で、未設定と空文字のときの既定値だけをそろえる——書式と範囲の解釈はwranglerに委ねる。

`playwright-core`には`patches/playwright-core@1.57.0.patch`を当てている（`pnpm-workspace.yaml`の`patchedDependencies`）。macOSの製品版Chrome（`PLAYWRIGHT_CHANNEL=chrome`）は、Chromeのstdoutを`GoogleUpdater`に、stderrを`chrome_crashpad_handler`に引き継がせる。Chrome終了後もこれらが数分〜無期限に居残るためNodeの`close`が来ず、`browser.close()`が返らない——E2Eが全件✓のあと集計行を出さずに止まる。パッチはChromeの終了から1秒たってもstdout/stderrが閉じないときにこちらから閉じる（プロトコル通信のfd 3/4には触れない）。**Playwrightを更新したらパッチを作り直し（`pnpm patch playwright-core@<version>`）、この Mac（製品版Chrome）で`pnpm test:e2e`が最後まで終わることを確かめる。** バージョン固定のパッチなので、更新すると黙って外れる。

`pnpm verify`はformat、lint、型検査、Vue/ViteとWorkerのbuild、domain、content、教材整合、Worker統合、主要E2Eを実行する。`pnpm verify:full`は全E2E、domainへのMutation Testing、重複検査、production dependency監査を追加する。ローカルではどちらも1コマンドで全部回る。CI（`.github/workflows/verify.yml`）は同じ中身を並列ジョブに分けて走らせる。通常PRは`verify`の中身（`verify:checks`とshardに分けた主要E2E）、監査レーン（`監査レーン`ラベルか手動実行）はそれに加えて`verify:full`の残り（journey E2E・Mutation Testing・重複検査と依存関係監査）を走らせる。

### 公開用スナップショットの検査

private だったこのリポジトリを`hell-ict-archive`に改名して残し、mainから除外リストを引いた中身を新しい履歴にして public の`hell-ict`を作る（Issue #368）。その中身を手元で組み立てて検査するのが`scripts/public-snapshot.sh`である。pushやGitHubへの操作はしない。

```sh
bash scripts/public-snapshot.sh                    # origin/main を検査する
bash scripts/public-snapshot.sh <ref> --verify     # 除外したうえで verify:checks まで通す
bash scripts/public-snapshot.sh <ref> --verify --out <dir>   # すべて通ったときだけ <dir> に置く
```

- 外すパスは`scripts/public-exclude.txt`（`!`で再包含）。ref ではなく手元の作業ツリーのものを読む。
- 出てはいけない語のリストは公開しない。`docs/public-banned-words.txt`が手元にあればそれを、無ければ（public repo では）`HELL_ICT_BANNED_WORDS`が指すファイルを読む。`HELL_ICT_BANNED_WORDS`は環境変数か、リポジトリ直下の`.deploy.env`に、`hell-ict-scenario`の`docs/public-banned-words.txt`の場所を書く（例: `HELL_ICT_BANNED_WORDS=/path/to/hell-ict-scenario/docs/public-banned-words.txt`）。`public-snapshot.sh`はどちらも無ければ止まる。指したファイルが無いときも止まる。
- `--out <dir>`を付けると、検査（`--verify`を付けたときはそれも）がすべて通ったときだけ、スナップショットを`<dir>`に置く。`<dir>`がすでにあれば検査の前に止まり、検査に通らなければ何も置かない。`--verify`はスナップショットの写しの中で流すので、置くものに`node_modules`は入らない。
- 報告するのは、除外漏れ（外したファイルとその名前への参照が残っていないか）、サイズ・ファイル数・大きいファイル上位10件、ネタバレ語のヒット（ファイルと語と件数）、`--verify`の結果。
- 終了コードは、除外漏れ1、ネタバレ語のヒット2、verifyの失敗3（複数に当たるときは1、3、2の順）、`--out`の書き出しの失敗4。
- 切り替えでは、`--verify --out`で置いたスナップショットを新しい repo の最初の中身にする。

### ダミーシナリオと本物のシナリオ

このリポジトリの`packages/content`はダミーシナリオ（`scenarioId`は`dummy`）である。本物は private repo `hell-ict-scenario` にあり、デプロイのときだけ重ねる（次節「シナリオの overlay」）。

- **content の文言やシナリオを変えるときは、ダミー（このリポジトリ）と本物（`hell-ict-scenario`）の両方を直す。** 片方だけに足したファイルや形の食い違いは、デプロイ時の overlay の検査と、`scripts/scenario-check.sh`の型検査・テストで止まる。
- `pnpm verify:checks`の最後に`scripts/check-public-scenario.sh`が走り、`scenarioId`が`dummy`、`packages/content/test/scenario/`・`packages/domain/test/scenario/`が無い、`.scenario-overlay`が無い、ネタバレ語のリスト（`docs/public-banned-words.txt`か`HELL_ICT_BANNED_WORDS`。前節）があるときは`public-snapshot.sh HEAD`が0、を確かめる。リストがどちらにも無ければ（CI など）最後の検査は飛ばす。
- pre-commitフック（`scripts/hooks/pre-commit`）は、ステージした追加行のうち公開に残るファイルのものがネタバレ語のリスト（同じく`docs/public-banned-words.txt`か`HELL_ICT_BANNED_WORDS`）の語に当たれば、コミットを止める。リストがどちらにも無ければ語の検査は飛ばすので、public repo では`.deploy.env`に`HELL_ICT_BANNED_WORDS`を書いておく。

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
| `EVENT_NO` | 6桁なら任意のコードで入室できる（ローカル開発とE2Eを壊さないための意図的なfail-open） | 本番。**開催回を2桁数字（`02`のように0埋め）で設定する。** チームコードは`[開催回2桁][チーム番号4桁]`で、上2桁が`EVENT_NO`と一致し、下4桁が1〜`TEAM_MAX`のコードだけを通す。規則から外れたコードは入室・チーム操作・リーダーボード購読・進捗記録のすべてで404になり、Durable ObjectもD1の行も作らない。**2桁数字でない値（空文字・1桁・3桁・非数）はfail-closedで全コードを拒否する**（`guards.eventNo`が`"invalid"`）。開催回だけで入室できるわけではない（入室資格はコード全体）が、知られると通るコードの範囲が狭まるので、`wrangler secret put EVENT_NO`で与え、`/api/health`にも値そのものは出さない。**活動ログ（`activity_events.event_id`）にもこの値がそのまま書かれる**ので、開催回を持つ設定はこれ1つだけである（ログ分析手順（`hell-ict-scenario`の`docs/testplay/ログ分析手順.md`）） |
| `TEAM_MAX` | 100 | チーム番号の上限を変えるとき。受け付けるのは1〜9999の数字だけで、**0・負・非数・空文字・9999超はfail-closedで全コードを拒否する**（`guards.teamMax`が`"invalid"`）——ここを既定へ倒すと、書き損じたまま「設定したつもりの上限」と違う範囲で当日が動く。`EVENT_NO`が未設定なら規則そのものが効かないので、この値は読まれない |
| `CHAT_RATE_LIMIT_PER_MINUTE` | 20 | 1チームが1分あたりに送れるチャット数を変えるとき。受け付けるのは1〜600の整数だけで、範囲外・非数値・`1e100`のような指数表記は既定の20へ倒す（実際に効いている値は`/api/health`の`guards.chatRateLimitPerMinute`に出る）。超過は429と`Retry-After`で返し、OpenAIを呼ばずユーザーメッセージも保存しない |

チームコードの判定は3状態しかない。どの状態にいるかは`GET /api/health`の`guards`だけで見分けられる。

| 状態 | 条件 | 挙動 | `guards` |
|---|---|---|---|
| fail-open | `EVENT_NO`未設定 | 6桁なら任意のコードが通る | `eventNo: false`、`teamMax: false` |
| 規則あり | `EVENT_NO`が2桁数字、`TEAM_MAX`が1〜9999 | 上2桁が一致し下4桁が1〜`TEAM_MAX`のコードだけ通る | `eventNo: true`、`teamMax: 100` |
| fail-closed | どちらかが壊れている | 全コードを拒否（全チームが404） | 壊れているほうが`"invalid"` |

規則判定は許可リストより受け入れ範囲が広い（既定では開催回あたり100通り）。**本番当日は`TEAM_MAX`を「配布数＋予備」まで下げて範囲を絞る**——2026-09-26の6チーム＋予備なら`TEAM_MAX`は10程度でよい。既定の100は開発とリハーサルの利便性のための値であって、当日そのまま使うことを前提にしていない。推測不能なセッション資格情報の導入は、上の注記のとおり本実装フェーズの課題とする。

本番デプロイ前の手順は次のとおり。

1. 開催回を決め、チームコードを`[開催回2桁][チーム番号4桁]`で配る（開催回が`NN`のチーム1なら`NN0001`）。**予備コードは登録不要で、次の番号（`NN0007`、`NN0008`…）をそのまま配ればよい。** 開催回を切り替えれば、前回開催やリハーサルのチームは入室も配信もできなくなる。
2. `wrangler secret put EVENT_NO` で開催回を設定する（`apps/worker`で実行）。**あわせて`wrangler secret put TEAM_MAX`で、配布数＋予備まで上限を下げる**（100を超えるチーム数のときだけ上げる）。`ALLOWED_ORIGINS`と`CHAT_RATE_LIMIT_PER_MINUTE`を変えるときも同じく`wrangler secret put`を使う。**Cloudflareダッシュボードの Variables と `wrangler deploy --var` は使わない**——`wrangler deploy`は設定ファイルに無い通常の変数を消すので、デプロイ（次節）のたびに設定が失われる。secretは消えない。
3. Vueアプリ（`/`）はWorkerのAssetsから同一オリジンで配るため、`ALLOWED_ORIGINS`は未設定のままでよい。別オリジン配信へ切り替えたときだけ設定する。
4. デプロイ後、`GET /api/health`の`guards`で設定が効いているか確認する。`{"status":"ok","guards":{"eventNo":true,"teamMax":100,"allowedOrigins":false,"chatRateLimitPerMinute":20}}`のように返るので、次の2つを必ず見る。**開催回そのものと許可オリジンの値は伏せてある**——healthはOrigin不問で誰でも読めるため、開催回が見えると通るコードの範囲が6桁全体から1万通りへ狭まる。
   - **`eventNo`が`true`であること。** `false`なら`EVENT_NO`の設定漏れで、6桁なら誰でも入れる状態のまま本番を迎えることになる。`"invalid"`なら値が壊れている（2桁数字でない）状態で、**全チームが404で入室できない**——書き損じをここで捕まえる。値そのものは出ないので、**設定した開催回が合っているかは手順6（実際に入室してみる）で確かめる**。前回の開催回のままだと、当日配ったコードが全部404になる。
   - **`teamMax`が配布したチーム番号の最大以上であること。** `"invalid"`なら`TEAM_MAX`の書き損じで全チームが入室できない。既定のまま運用するなら`100`と出る。
5. **リハーサルの痕跡は、本番の入室が始まる前に片付ける。** 同じ開催回（`EVENT_NO`）のままD1の行が残っていると、`GET /api/progress/summary`が毎回その分まで読み、無料プランのD1 rows read（500万/日）を余計に削る（[Issue #125](https://github.com/yukihiroyamaguchi569/hell-ict-archive/issues/125)）。別の開催回の行はインデックスで飛ばすので、開催回を切り替えればサマリーは読まない（[hell-ict#22](https://github.com/yukihiroyamaguchi569/hell-ict/issues/22)）。それ以上に重要なのは、**D1を消してもDurable Object側（`TeamRoom`のチーム状態・チェックポイント・会話・リセット世代、`RaceLeaderboard`の行）は消えない**ことである——同じチームコードを本番で配り直すと、そのチームだけリハーサルの途中状態から復帰する。

   - **推奨: 本番は未使用の開催回（`EVENT_NO`）で行う。** 手順1・2のとおり開催回を切り替えれば、リハーサルで使ったコードは入室そのものができなくなり、DO側の状態にも当たらない。リハーサル用と本番用で開催回を分けておくのがいちばん簡単で確実である。
   - **同じ`EVENT_NO`を使い続ける場合は、リハーサルで使った全チームをGMリセット（下記）してから、D1を消す。** 先にD1を消してからリセットすると、リセットが積む`reset`行が本番のテーブルへ最初から残る（集計は正しく動くが、ダッシュボードの通信記録にリハーサルの後始末が並ぶ）。GMリセットは`/dashboard.html#gm`の各行のボタンか、`POST /api/gm/teams/:code/reset`で行う。

   D1の削除は次のとおり（リハーサルの後・本番の入室前の1回だけ。**本番の進行中は絶対に実行しない**——当日の記録が消え、ダッシュボードから全チームが消える）。

   ```sh
   cd apps/worker
   pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "DELETE FROM progress_events"
   pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "DELETE FROM activity_events"
   ```

   **片付けは次の手順6（入室確認）より先に行う。** 確認で入室したチームにもDO側の状態とチェックポイントが残るので、順番が前後して確認の後に片付けたときは、**確認に使ったコードを本番で配らない**か、**そのコードをGMリセットしてから配る**。

   rows readを削っているのは`progress_events`だけで、`activity_events`はサマリーが読まない——こちらは本番のログにリハーサル分が混ざらないようにするための削除である。**リハーサルのログを分析に使うなら、消す前にログ分析手順（`hell-ict-scenario`の`docs/testplay/ログ分析手順.md`）でエクスポートしておく。**

   `migrations`テーブルは消さない（消しても害はないが、PII伏せ字化の移行がもう一度走るだけである）。`progress_events`の`reset`行が消えるので集計の下限は0へ戻るが、以後に積まれる行の世代はDOが持つ現在の世代（0以上）なので、位置の集計は正しく動く。

6. **`EVENT_NO`と一致するコード（開催回が`NN`ならチーム1は`NN0001`）で実際に入室できることを確認する。** healthは開催回の値を出さないので、設定した値が合っているかはこれでしか分からない。あわせて、別の開催回のコードや上限を超えるチーム番号が404で弾かれることも確認する。素の`curl -X POST https://<worker>/api/session -d '{"teamCode":"100001"}'`はOriginが無いので403になるが、これはガードが配線されている確認であって防御の強さの確認ではない（`-H "Origin: https://<worker>"`を付ければ通る。上の注記を参照）。**この確認に使ったコードは手順5の注記のとおり扱う**——本番で配らないか、配るならGMリセットしてから配る。
7. **前日と当日の開始前に、OpenAIの Billing（https://platform.openai.com/settings/organization/billing ）でクレジット残高を確かめ、十分に積む。** Limits（レート制限・予算）とは別の画面である。Limitsだけを見て残高切れに気づかなかったことが2回あり、2回目の2026-09-26本番ではAIが約11分止まった。
8. **自動チャージ（auto recharge）は有効にしない。** 安全のため、課金が自動で積み上がる設定は使わない（2026-10-03 決定）。開催中の残高切れには、手順7で十分に積んでおくことと、下記の予備キー（別組織の`OPENAI_API_KEY_BACKUP`）で備える。
9. **進捗ボード（`/dashboard.html`）は、会場へ映す1〜2タブだけ開く。** ボードはタブごとに10秒おきに`GET /api/progress/summary`を読むので、D1の読み取りは見えているタブの数に比例し、無料プランの500万行/日に効く。1回に読むのは今の開催回の行数の約2〜3倍（GMリセットしたチームが多いほど3倍に近づく）で、過去の回の行は読まない。今の回が1,000行のまま1タブを4時間映しても約290万〜440万行に収まるが、2タブ目からは枠を超えうる。タブが裏に回っている間と最小化している間は読まず、見えたときに1回すぐ取り直す（[hell-ict#22](https://github.com/yukihiroyamaguchi569/hell-ict/issues/22)）。

### OpenAIの予備キー・予備モデル

主キーのクレジットが尽きたとき（2026-09-26本番で約11分止まった）に備え、予備を置ける（`apps/worker/src/ai-failover.ts`）。どちらも未設定なら予備なしで、従来どおり動く。

| secret | 中身 | 切り替わる失敗 |
|---|---|---|
| `OPENAI_API_KEY_BACKUP` | **別の組織（またはプロジェクト）**のAPIキー。同じ組織のキーでは残高を共有するので効かない。予備側にもクレジットを積んでおく | 429 `insufficient_quota`（残高切れ）、401・403（キーの失効・停止） |
| `OPENAI_MODEL_BACKUP` | 主モデル（`apps/worker/wrangler.jsonc`の`vars`の`OPENAI_MODEL`。今は`gpt-4.1-mini`）が使えないときのモデル名。本番には`gpt-4o`を登録する運用とする。主キーのまま呼ぶ | 404・`model_not_found` |

```sh
cd apps/worker
pnpm exec wrangler secret put OPENAI_API_KEY_BACKUP
pnpm exec wrangler secret put OPENAI_MODEL_BACKUP   # 本番では gpt-4o を登録する
```

- **切り替えは自動。** 主系が上の失敗を返したときだけ、同じ送信を予備へ1回だけ送り直す。予備で通ったら5分間は主系を呼ばずに予備へ送り、過ぎたら主系を1回試す——クレジットを補充すれば、運営が何もしなくても5分以内に主系へ戻る。
- **一時的な失敗では切り替えない。** レート制限（429 `rate_limit_exceeded`）・5xx・タイムアウト・通信断は、参加者の再試行に任せる。タイムアウトと通信断はOpenAI側で課金済みのことがあり、予備へ送ると二重に払うためである。
- **確かめ方**: `GET /api/health`の`ai`を見る。`{"route":"primary","backupKey":true,"backupModel":false,"fallbackConfigured":true}`のように、予備が設定済みかどうか（キーの値は出さない）と、応答したWorkerの今の経路（`primary` / `backup-key` / `backup-model`。手で切り替えた他社の予備は`fallback`。次節）が出る。経路はWorkerのインスタンスごとに持つので、切り替わっていても`primary`と出ることがある。**実際に切り替わったかは活動ログで確かめる**——`chat.assistant`・`chat.failure`・`chat.refusal`のmetaに`aiRoute`が、切り替えたその送信には`aiSwitchCause`（`key` / `model`）が残る。

  ```sh
  pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "SELECT created_at, kind, json_extract(meta, '$.aiRoute') AS route, json_extract(meta, '$.errorCode') AS code FROM activity_events WHERE json_extract(meta, '$.aiRoute') != 'primary' ORDER BY id DESC LIMIT 20"
  ```

- 予備に切り替わったら、手順7のBillingで主キーの残高を補充する（予備のクレジットも有限である）。

#### OpenAIが落ちたとき: 他社の予備（Claude Haiku 5.5）へ手で切り替える

上の予備はOpenAIの中での備えで、OpenAIそのものの障害（5xx・タイムアウトが続く）には効かない。そのときは運営が手で、Anthropicの OpenAI 互換の接続先（`claude-haiku-5-5`）へ切り替える。切り替えのスイッチも secret 1つ（`AI_ROUTE`）にしてあり、デプロイせずに数秒で反映される。

| secret | 中身 | 例 |
|---|---|---|
| `AI_ROUTE` | `fallback`で予備へ。未設定・空・`primary`は主系（今のまま） | `fallback` |
| `AI_FALLBACK_BASE_URL` | 予備の接続先。httpsのみ受け付ける | `https://api.anthropic.com/v1` |
| `AI_FALLBACK_API_KEY` | 予備のキー（Anthropicの本番用キー。期限は11/30など本番後） | — |
| `AI_FALLBACK_MODEL` | 予備のモデル | `claude-haiku-5-5` |

どれも`wrangler.jsonc`の`vars`には書かない（`vars`はデプロイのたびに上書きされ、切り替えが消える）。

- **予備だけを呼ぶ。** `AI_ROUTE=fallback`で予備の3つがそろっていれば、OpenAI（主系・予備キー・予備モデル）へは送らない。予備の呼び出しにだけ、思考を切る指定（`thinking: {"type": "disabled"}`）を足す——ai-bench で比較・負荷テストに使ったのと同じ本文である。主系の本文は変わらない。
- **書き損じではAIを止めない。** `AI_ROUTE`が`fallback`以外の値（`Fallback`・末尾の改行など）、予備の3つのどれかが無い、接続先がhttpsでない（またはクエリ`?`・フラグメント`#`付き）、のいずれでも主系のまま動く。どちらで動いているかは`/api/health`の`ai.route`で確かめる。
- PIIゲートは経路によらずAIの呼び出しより先に止める。予備へ切り替えても、PIIを含む送信は他社へも届かない。

**事前の登録（本番前に1回）**

```sh
cd apps/worker
printf https://api.anthropic.com/v1 | pnpm exec wrangler secret put AI_FALLBACK_BASE_URL
pnpm exec wrangler secret put AI_FALLBACK_API_KEY      # 対話で貼る
printf claude-haiku-5-5 | pnpm exec wrangler secret put AI_FALLBACK_MODEL
curl -s "$HELL_ICT_PROD_URL/api/health" | jq .ai       # fallbackConfigured: true、route: primary
```

- `HELL_ICT_PROD_URL`はリポジトリ直下の`.deploy.env`のもの（`set -a; . ../../.deploy.env; set +a`で読む）。
- Anthropicの組織（Console の Billing）にクレジットが十分あることも確かめる。
- `AI_ROUTE`はまだ入れない。
- 手元で本物の Anthropic へ通して確かめるには `scripts/ai-fallback-smoke.sh` を使う（下の「手元での確認」）。

**いつ切り替えるか（目安）**

- OpenAIのステータスページ（https://status.openai.com/）に障害が出ている。または
- 活動ログの`chat.failure`が、5xx・タイムアウト（`failureReason`が`timeout`・`network`、`httpStatus`が5xx）で続いている。

  ```sh
  pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "SELECT created_at, json_extract(meta, '$.failureReason') AS reason, json_extract(meta, '$.httpStatus') AS status, json_extract(meta, '$.aiRoute') AS route FROM activity_events WHERE kind = 'chat.failure' ORDER BY id DESC LIMIT 20"
  ```

**切り替え**（`apps/worker`で）

```sh
printf fallback | pnpm exec wrangler secret put AI_ROUTE
curl -s "$HELL_ICT_PROD_URL/api/health" | jq .ai       # route: fallback になったことを確かめる
```

参加者には再送してもらえば通る。活動ログの`aiRoute`が`fallback`になる。

**戻し**

```sh
printf primary | pnpm exec wrangler secret put AI_ROUTE
curl -s "$HELL_ICT_PROD_URL/api/health" | jq .ai       # route: primary を確かめる
```

`printf`を使う（`echo`だと末尾に改行が入り、`fallback`と一致せず主系のままになる）。

**手元での確認**（本物の Anthropic へ Worker を通す）

```sh
read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
bash scripts/ai-fallback-smoke.sh
```

`wrangler dev --local`を予備の設定（`AI_ROUTE=fallback`ほか）で起動し、テスト用のチームで入室してチャットを数回送り、応答の有無・所要時間・活動ログの`aiRoute`を表示して、終わったらdevを止める。キーはファイル（`.dev.vars`など）に書かず`--var`で渡す（devが動いている間だけプロセスの引数に載る）。D1とDOは手元のローカルのもの（一時ディレクトリ）だけを使い、本番には触れない。

### デプロイの流れ

**`main`へマージしたあと、手元で`pnpm deploy:prod`を実行すると、本番Worker（`hell-ict`）へデプロイされる。** マージしただけでは本番に出ない。`scripts/deploy-prod.sh`は`origin/main`を取得し、そのコミットが`.github/workflows/verify.yml`（`main`へのpushでも走る）を通っていることを確かめてから、一時ディレクトリへworktreeとして取り出し、そこで`pnpm install`→`pnpm build:testplay`→`wrangler deploy`→本番のsmoke（`scripts/smoke-prod.sh`）を流す。出すのは`origin/main`のコミット済みの内容だけなので、どのブランチにいても実行でき、手元の未コミット・未追跡のファイルは混ざらない。一時worktreeは成功しても失敗しても片付ける。`docs/`（`docs/materials/`を除く）とリポジトリ直下の`*.md`だけの変更は`verify.yml`が走らないので、直近の検証済みコミットまで遡り、そこからの変更がそれらのファイルだけなら続ける。検証中・失敗・検証を通っていない変更があるときは理由を表示して止まる。

**`https://<worker>/`は新アプリ（Vue。Issue #238）**（ローカルの`wrangler dev`なら`http://127.0.0.1:8787/`）。`pnpm build:testplay`が`apps/web`のViteビルド（`index.html`と`app/`）を`apps/worker/public/`へ組み立てる。

**参加者が進行中のあいだはデプロイしない。デプロイしたら全端末をリロードさせる。** 開いたままの旧タブは旧い版の画面のまま動き続け、サーバとの取り決め（画面id・チェックポイントの形）が食い違いうる。サーバ側は旧形式を受け取れるよう読み替えを入れてあるが（`packages/domain/src/legacy-ids.ts`）、旧UIは保存が拒否されても参加者に何も伝えず進むので、拒否されるとリロードした時点でデプロイ前の状態まで巻き戻る。リロードの伝え方はGMリセットの手順（後述）と同じでよい。

**その端末で初めてデプロイするときは、先に`cd apps/worker && pnpm exec wrangler login`で認証しておく。** `pnpm deploy:prod`はさらに`main`のCI結果を`gh`で読むので、`gh auth login`も済ませておく（未導入・未認証なら止まる）。**CloudflareのAPIトークンはGitHub Secretsに置かない**——本番Workerを書き換えられるトークンをGitHubとワークフロー内の第三者Actionへ預けないため、デプロイは手元からに限り、認証は手元の`wrangler login`だけに置く（Issue #366）。GitHub Actionsはテスト（`verify.yml`）にだけ使う。

**本番WorkerのURLはリポジトリに書かない。** その端末で初めてデプロイするときに、リポジトリ直下へ`.deploy.env`を作り、次の1行を書く（`.gitignore`で除外してあるのでコミットされない）。URLは`wrangler deploy`の出力やCloudflareダッシュボードのWorkerの画面で分かる。

```sh
HELL_ICT_PROD_URL=https://<本番WorkerのURL>
```

`pnpm deploy:prod`は最初にこのファイルを読み、`HELL_ICT_PROD_URL`が無ければ`pnpm install`より前に止まる。読んだ値は最後のsmoke（`scripts/smoke-prod.sh`）へ環境変数として渡る。

#### シナリオの overlay

**本番には本物のシナリオを載せる。** 正解・罠・system prompt・教材などのシナリオは private repo `hell-ict-scenario` にあり、このリポジトリの`packages/content`はダミーである（#368B）。`pnpm deploy:prod`は一時worktreeへ本物を上書き（overlay）してから組み立てる。そのため`.deploy.env`に、`hell-ict-scenario`をcloneした場所も書く。

```sh
HELL_ICT_SCENARIO_DIR=/path/to/hell-ict-scenario
# 任意。取り出すコミット（既定 origin/main）。
# HELL_ICT_SCENARIO_REF=origin/main
# public repo では書く。ネタバレ語のリスト（pre-commit・check-public-scenario・public-snapshot が読む。「公開用スナップショットの検査」）。
# HELL_ICT_BANNED_WORDS=/path/to/hell-ict-scenario/docs/public-banned-words.txt
```

`HELL_ICT_SCENARIO_DIR`が無い、またはgitリポジトリでなければ、`pnpm install`より前に止まる。流れは次のとおり。

1. `.deploy.env`を読み、`HELL_ICT_PROD_URL`と`HELL_ICT_SCENARIO_DIR`を確かめる。デプロイの仕組み（`deploy-prod.sh`・`lib/deploy-checks.sh`・`lib/scenario-overlay.sh`・`smoke-prod.sh`）が`origin/main`と同じか、`main`のCIが緑かを確かめる。
2. `origin/main`を一時worktreeへ取り出し、シナリオの repo を`fetch`して`HELL_ICT_SCENARIO_REF`を`git archive`で取り出す（作業ツリーではなくpush済みのコミットを使う）。それを一時worktreeへoverlayし、シナリオのcommitとid（`scenarioId`）をログに出す。
3. `pnpm install`→`pnpm typecheck`→`pnpm test:content`→`pnpm test:domain`→`pnpm test:worker`。落ちたら出さない。
4. `pnpm build:testplay`→`wrangler deploy`→smoke。smokeは`/api/health`の`scenario`が`dummy`でなく、overlayしたidと一致することも確かめる。

overlayで上書きするのは`packages/content/src/*.ts`（`index.ts`・`schemas.ts`を除く。public側の同名ファイルをすべて置き換える）と、`packages/content/test/scenario/`・`packages/domain/test/scenario/`（ディレクトリごと入れ替え）だけである。シナリオにそれ以外のパス（`packages/domain/src`など）や`index.ts`・`schemas.ts`があるとき、public側の`content/src`を1つでも置き換えないとき、`scenarioId`が`dummy`のときは止まる（`scripts/lib/scenario-overlay.sh`）。overlayした中身は一時worktreeの中にだけあり、手元の作業ツリーには書かない。

**シナリオの repo を更新したときや、public側の`content`の形を変えたときは、先に`bash scripts/scenario-check.sh <hell-ict-scenario> [--ref <ref>]`で確かめる。** 今のブランチのHEAD（コミット済みの内容）を一時worktreeへ取り出してoverlayし、`pnpm install`・`typecheck`・`test:content`・`test:domain`・`test:worker`を流して片付ける。

**手元で本物のシナリオを動かすときは、専用のworktreeでoverlayする。** ふだんの作業ツリーでoverlayすると、本物の内容をpublic側へコミットしかねない。

```sh
git worktree add ../hell-ict-real origin/main --detach
cd ../hell-ict-real && pnpm install
bash scripts/scenario-overlay.sh apply /path/to/hell-ict-scenario   # 既定は origin/main。--ref で変えられる
bash scripts/scenario-overlay.sh status
bash scripts/scenario-overlay.sh restore                            # 戻す。git status が空になる
```

`apply`は、追跡ファイルに未コミットの変更がある・overlay先に未追跡のファイルがある・すでにoverlayしてある作業ツリーでは止まる。overlay中は作業ツリーの直下に`.scenario-overlay`（commit・id・入れ替えたファイルの一覧。`.gitignore`で除外）が置かれる。

**誤コミット防止のpre-commitフックを入れておく。** `scripts/hooks/pre-commit`は、コミットしようとしている作業ツリーの直下に`.scenario-overlay`があるときと、ステージした追加行がネタバレ語に当たるときに、コミットを拒否する。その端末で1回、リポジトリ（main checkout）の直下で次を実行する。worktreeはこのフックを共有し、フックはworktreeごとにマーカーを見る。

```sh
ln -s ../../scripts/hooks/pre-commit .git/hooks/pre-commit
```

グローバルの`core.hooksPath`（例 `~/.config/git/hooks`）を使っている場合、`.git/hooks/pre-commit`は直接は呼ばれない。グローバルのpre-commitから`$(git rev-parse --git-common-dir)/hooks/pre-commit`を連鎖で呼ぶようにしておく。

Workerの運用値（`EVENT_NO`、`TEAM_MAX`、`ADMIN_TOKEN`など）はCloudflare側のsecretである。デプロイで消えないので、登録は前節の`wrangler secret put`のまま1回でよい。

- **効果音（mp3）はデプロイに含まれない**: 音源は効果音ラボで再配布が規約で禁じられており、`.gitignore`で`assets/sounds/`ごと除外してあるため、リポジトリの中身を組み立てるデプロイには入りようがない。**配信元はR2バケット`hell-ict-sounds`で、投入は手元から1回だけ**——`assets/sounds/`へ7点を置いて`bash scripts/upload-sounds.sh`を実行する（バケットが無ければ作るところからやる）。**その端末で初めてwranglerを使うときは、先に`cd apps/worker && pnpm exec wrangler login`で認証しておく**——未認証だとバケットの一覧取得の時点で失敗し、作成も投入もできない。Workerは`GET /sounds/<name>.mp3`をこの7点に限ってR2から返す（`apps/worker/src/sounds.ts`）。**音源を差し替えたときとバケットを作り直したときだけ再実行すればよく、通常のデプロイでは何もしなくてよい。** 投入していなくても本番は落ちず、音が鳴らないだけで進行は変わらない。
- **D1のスキーマ（テーブルとインデックス）に手作業の適用は要らない**: このリポジトリは`wrangler d1 migrations`を使わず、Workerが最初のリクエストで`ensureSchema`（`apps/worker/src/progress.ts`の`progressSchemaSql`）を1回流す。`CREATE ... IF NOT EXISTS`なので、既存のD1にも不足分（2026-09-06に足したreset用の部分インデックス`idx_progress_reset`など）だけが作られる。デプロイ後に`GET /api/progress/summary`を1回叩けば適用され、確認は次のとおり。

  ```sh
  cd apps/worker
  pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'progress_events'"
  ```

- **失敗したとき**: `pnpm deploy:prod`の出力で、どこ（デプロイ前の確かめ / `pnpm build:testplay` / `wrangler deploy` / smoke）で止まったかを見る。デプロイ前の確かめで止まったときは、表示された理由（CIが検証中・失敗、CIを通っていない変更）を片付けて再実行する。CIを通っていない変更が残っているときは、`gh workflow run verify.yml --ref main`で`main`を検証してから出す。「デプロイの仕組みが origin/main と違う」で止まったときは、手元の`scripts/deploy-prod.sh`・`scripts/lib/deploy-checks.sh`・`scripts/lib/scenario-overlay.sh`・`scripts/smoke-prod.sh`のどれかが`origin/main`と食い違っている（古いブランチにいる、手で書き換えた）ので、`git switch main && git pull`してから再実行する。smokeは`set -a; . ./.deploy.env; set +a; bash scripts/smoke-prod.sh`（リポジトリ直下で実行。`HELL_ICT_EXPECTED_SCENARIO=<id>`を足すとシナリオのidも照合する）だけでも再実行できる。smokeの`/api/health`の確認は`GET /api/health`が`status: "ok"`かつ`guards.eventNo: true`かつ`guards.teamMax`が数値で、`scenario`が`dummy`以外の文字列であることを求めるので、overlayし損ねたダミーのシナリオに加え、`EVENT_NO`の設定漏れや書き損じに加え、`TEAM_MAX`の書き損じ（`"invalid"`＝全チームが404）もここで失敗する。デプロイ自体は成功しているので、secretを直してsmokeを再実行する。

### ゲームマスターのリセット（`ADMIN_TOKEN`）

チェックポイントは後退を拒否するため、同じコードでテストプレイをやり直せない。また当日、2チームが同じコードへ入ってしまったといった事故から復旧する手段が要る。そのための経路が`POST /api/gm/teams/:code/reset`と`POST /api/gm/teams/by-public-id/:publicId/reset`である。**リハーサルのやり直しと事故の復旧のためのものであり、本番当日は原則として使わない。**

資格情報は`ADMIN_TOKEN`（secret）1つで、`Authorization: Bearer <token>`で渡す。**未設定ならGM系ルートは常に404を返す**（設定漏れのまま誰でも押せる状態にはならない）。トークンは推測できない長さにする——32文字以上を推奨し、`openssl rand -base64 32`などで作る。

```sh
cd apps/worker
pnpm exec wrangler secret put ADMIN_TOKEN
```

判定の順番は、Origin検証（`/api/*`共通の入口ガード）→ トークン → 対象の特定 → チームコードの規則判定 → 実行。**トークン不一致・未設定・規則外のコード・未知のpublicId・GM配下の未知のパスは、すべて同じ404（本文は`Not found`）に揃える**——「トークンが違う」と「そのチームは居ない」を返し分けると、外から存在を確かめられてしまう。ダッシュボードは404を「トークンを確認してください」と表示する。

#### GMモードの開き方

会場ディスプレイ用のダッシュボード（`/dashboard.html`）を、**URLの末尾に`#gm`を付けて開く**（`https://<worker>/dashboard.html#gm`）。トークン欄が出るので`ADMIN_TOKEN`を入れて「保存」を押すと、そのブラウザの`localStorage`に残り、次回からは入力不要になる。各チームの行に「リセット」ボタンが出て、押すと確認ダイアログの後に実行され、結果がその行に表示される。

**ハッシュを付けずに開いた通常表示では、トークン欄もボタンも描画しない。** 会場前面へ映すのはこちらである。`#gm`を消してリロードすれば通常表示へ戻る。

ダッシュボードはチームコードを表示しない設計（見えた時点でそのチームへ入室できてしまう）なので、リセット対象は`publicId`（サマリーが返すハッシュの先頭8桁）で指す。サーバ側は`progress_events`から逆引きする——ダッシュボードの行はその集計なので、画面に出ているチームは必ず引ける。チームコードが分かっているときは`:code`版を直接叩いてもよい。

#### 消えるものと残るもの

| | 対象 |
|---|---|
| 消える | Durable Object（`TeamRoom`）のチーム状態・チェックポイント・会話履歴・罠の使用済みフラグ・冪等台帳（`processed_*` / `pending_message_commands`）・レート制限のカウンタ。リーダーボード（`RaceLeaderboard`）のその行 |
| 残る | D1の活動ログ（`activity_events`）と進捗イベント（`progress_events`）の過去行。表示名は次の入室で上書きされるまで残る |

リセットすると、D1へ`progress_events`の`kind: "reset"`（`pos: 0`、`view: "welcome"`）と`activity_events`の`kind: "gm.reset"`（`meta`は`{"by":"gm"}`）が1行ずつ積まれる。ダッシュボードの位置は前者で初期へ戻る——サマリーの集計は**最後の`reset`より後のイベントだけ**を位置として数える。`reset`はサーバ側でしか書かない（`POST /api/progress`が受け付ける`kind`には含めない。参加者の端末から自分の位置を戻せてしまうため）。

分析クエリで`kind`を列挙するときは、`progress_events`に`reset`が、`activity_events`に`gm.reset`が増えたことに注意する（ログ分析手順（`hell-ict-scenario`の`docs/testplay/ログ分析手順.md`））。位置の集計（手順1）は`jump` / `resume`と同じく`reset`を除外する。

#### 事故が起きたときの手順

1. `/dashboard.html#gm`を開き、トークンを入れる（初回だけ）。
2. 対象チームの行の「リセット」を押し、確認する。行に「リセットしました」と出れば完了。
3. **そのチームの端末をリロードさせる。** 開いたままのWebSocket接続とタブ内の状態はリセットの対象外なので、リロードしないと古い画面が残る。リロード後は同じチームコードで入り直せて、Prologue（welcome）から始まる。**リロードしていない端末は、進捗記録もチェックポイント保存も409（`stale-generation`）で拒否され、画面に「この端末の状態は古くなっています。ページを再読み込みしてください。」が出る**——リセット世代（下記）で持ち主を見分けているので、古いタブの遅れた書き込みが初期化した状態を巻き戻すことはない。
4. ダッシュボードの帯がそのチームだけ初期位置へ戻っていることを確認する。

#### リセット世代

リセットしただけでは、リロードしていない古いタブの書き込みで状態が戻りうる。遅れて届いた`POST /api/progress`は帯の位置を復活させ、離脱時flushのチェックポイント保存は「初回保存」として古い状態を再生してしまう（CASも単調マージも、状態が空になった後は何も止められない）。

そこでTeamRoomが**リセット世代**（整数、初期0）を持ち、リセットのたびに1つ進める。世代は入室（`POST /api/session`）の応答に載り、**進捗・チェックポイント・会話・コマンドのすべての書き込みに世代が付く。**

| 書き込み | 世代を添える場所 | 拒否したときの状態 |
|---|---|---|
| `POST /api/progress` | 本文の`generation` | D1に1行も書かない |
| `POST /api/teams/:code/checkpoint`（通常・flush とも） | 本文の`generation` | Durable Objectに1行も書かない（冪等台帳にも触れない） |
| `POST /api/teams/:code/chat/threads` | 本文の`generation` | `chat_state`も台帳も変わらない |
| `POST /api/teams/:code/chat/messages` | 本文の`generation` | 台帳もレート制限の枠も動かない |
| `POST /api/teams/:code/commands` | 本文の`generation` | チーム状態も台帳も変わらない |

一致しない書き込みはすべて409 `{"code":"stale-generation"}`で拒否する。世代を省いた要求は0として扱うので、一度もリセットしていないチームは今までどおり動く（後方互換）。照合はどの経路でも**冪等台帳を引くより前**に置く——後に置くと、リセット前のcommandIdが「処理済み」として古い結果を返しうる。

リーダーボード（`RaceLeaderboard`）は世代の**フェンス**を持つ。リセットで行を消すだけでは、リセット直前にsnapshotを読んだ入室の遅れた`upsert`が古い段階の行を作り直せてしまう（行が消えている以上、revisionの比較では守れない）。`resetTeam`がチームごとに下限世代を記録し、それより古い`upsert`は無視する。フェンスは単調に上がるので、古いリセットの再送で下がることもない。

`/api/session`はsnapshotと世代を1回のRPCで返す。2回に分けると、その間にリセットが入ったときに「リセット前のsnapshotとリセット後の世代」という食い違う組をクライアントへ渡すことになる。

進捗記録だけは、DOへの事前照合とD1へのINSERTが別の操作になる。その隙にリセットが入ると古い行が`reset`行より後のidで積まれるため、**`progress_events`に`generation`列を持たせ、集計はそのチームの`reset`行の最大世代以上の行だけを数える**。事前照合は早期拒否であって、正しさは列が担保する。既存のD1には`ALTER TABLE ... ADD COLUMN`で足し（2度目以降の失敗は握りつぶす）、既存行は既定の0＝リセット前の行として扱われる。

リセット世代は`RESET_TABLES`に含めない——リセットのたびに消すと、何回リセットしたかが失われて古い端末を見分けられなくなる。

リセットは何度実行しても同じ結果になる（冪等）ので、うまくいかなければそのまま押し直してよい。「リセットは実行しましたが、記録に失敗しました」と出たときは、Durable Objectは初期化済みでD1への記録だけが落ちている——盤面の位置を戻すためにもう一度押す。

### 保存済みチームを忘れさせる（`/?reset`）

Vueアプリ（`/`）は入室したチームコードをそのブラウザの`localStorage`（`hellTeamCode`）に残し、次に開くと入室画面を飛ばして自動で入り直す。同じブラウザで別のチームに入り直したいとき——リハーサルと本番でPCを使い回すとき、ファシリテーターが複数チームの画面を確かめるとき——は、**URLに`?reset`を付けて開く**（`https://<worker>/?reset`。値は問わないので`?reset=1`でもよい）。入室画面が出るので、別のコードで入る。

- **消える**: 保存済みのチームコード（`hellTeamCode`）だけ。サーバ側のチーム状態には一切触れない——チームの進行をやり直すのはGMリセット（上記）である。
- **残る**: チーム名（`hellTeamName:<コード>`。入室欄で同じコードを打つと名前が戻る）、ミュートと文字サイズの設定。
- 開いた直後にURLから`reset`だけを外す（他のクエリとハッシュは残る）。再読み込みで何度も忘れることはなく、入り直した後の再読み込みは通常どおりそのチームへ戻る。

参加者の画面にはこの操作のボタンを置かない（誤操作を避けるため）。会場準備・ファシリテーター用のブックマークとして使う。**配ったPCへ参加者が入室した後に開くと、そのPCはチームを忘れる**——チームはコードを打ち直せば同じ状態へ戻れるが、進行中の端末では開かない。

### デブリーフィングの集計（着順・監査賞・申し送り）

デブリーフィングの結果発表で使う3つの集計は、SQLとして`apps/worker/aggregation/`に置いてある。**このファイルが正本**で、本番Workerはこれをそのままバンドルし（wranglerの`.sql`の既定の取り込み規則。`apps/worker/src/debrief.ts`）、下の「番付と申し送りの画面」のAPIで流す。手元のwranglerで流す下の手順と、手元の予備の番付サーバ（`scripts/ranking-board/`）も同じファイルを読む。どれも新アプリ（Vue＋Durable Object）がD1へ書く行を前提にしており、旧モック（9/26本番）の行には効かない。

| ファイル | 出すもの | 元にする行 |
|---|---|---|
| `winner.sql` | 着順: Stage 6のクリアが早い順 | `progress_events`の`pos = 7`の`clear` |
| `audit-award.sql` | 監査賞: Stage 3の罠を一度も踏まずにStage 3をクリアしたチームを、所要が短い順に | `progress_events`の`pos = 3`の`entry`（Stage 3に入った）と`pos = 4`の`clear`、活動ログの`game.trap`（`meta.stage`が`s3`） |
| `handover.sql` | 申し送り: Finalで各チームが記した「次のチームに伝えたい一言」 | 活動ログの`submit.final` |

- **開催回**: SQL中の`{{EVENT_NO}}`を当日の`EVENT_NO`（2桁）へ置き換えてから流す。Workerの集計APIは、Workerに設定された`EVENT_NO`で置き換える（未設定・2桁数字でないときは集計せずエラーを返す）。置き換えずに流すと1行も返らない（別の回の行を黙って出さないため）。
- **GMリセット**: リセットしたチームはリセット後の行だけを数える。進捗は`generation`（そのチームの`reset`行の最大世代以上）、活動ログは`gm.reset`より後の`id`で絞る——絞らないと、ゴール後にリセットしたチームが古いゴール時刻のまま着順に混ざる。
- **時刻**: 着順と監査賞は`client_at`（サーバがステージを進めた時刻）で比べる。`created_at`はD1へ積めた時刻で、D1が落ちていた間の遷移は後で送り直されるので遅れて刻まれる。SQLは`YYYY-MM-DD HH:MM:SS.SSS`（UTC、ミリ秒まで）で返す。日本時間は9時間足す。
- **チーム名**: 入室時に画面が送る進捗の行に載る、そのチームの最新のチーム名。無ければ空になる。

画面で映すなら次の手動の手順は要らない。中身を手元で確かめたいとき、画面が使えないときは、`apps/worker`で次のように流す。`--file`で渡すと取り込み（import）として実行され、SELECTの結果の行が返らないうえ、実行中はD1がクエリに応答しなくなるので、`--command "$(...)"`で中身を渡す。例は開催回`99`。

```bash
cd apps/worker
pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "$(sed 's/{{EVENT_NO}}/99/g' aggregation/winner.sql)"
pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "$(sed 's/{{EVENT_NO}}/99/g' aggregation/audit-award.sql)"
pnpm exec wrangler d1 execute hell-ict-testplay --remote --command "$(sed 's/{{EVENT_NO}}/99/g' aggregation/handover.sql)"
```

`--remote`を`--local`に替えると、`wrangler dev --local`が使う手元のD1（`apps/worker/.wrangler/state`）を読む。リハーサルの前にローカルで通しておける。**ローカルでは、Workerを起動するときに`EVENT_NO`を渡す**——未設定のままだと活動ログの`event_id`が空文字で保存され、SQLは`'99'`で絞るので、監査賞の罠の除外と申し送りが黙って効かなくなる（着順は進捗だけを読むので出てしまい、気付きにくい）。例は開催回`99`。

Workerは起動したまま端末を占有するので、1つ目の端末で起動する。

```bash
# 端末1（起動したままにする）
cd apps/worker
pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787 --var EVENT_NO:99
```

`http://127.0.0.1:8787/`で開催回のコード（`990001`など。`99`で始まるコードしか入室できない）で入室し、Prologueのメールに1通返信する（活動ログに`game.submit`が1行積まれる）。そのうえで**別の端末で**、そのチームの新しい行の`event_id`を確かめる。チームコードで絞るのは、過去に流した別の回の行（空文字を含む）と取り違えないためである。

```bash
# 端末2
cd apps/worker
pnpm exec wrangler d1 execute hell-ict-testplay --local --command "SELECT id, event_id, kind, created_at FROM activity_events WHERE team_code = '990001' ORDER BY id DESC LIMIT 3"
```

`event_id`が`99`なら正しい。空文字なら`EVENT_NO`が渡っていないので、Workerを止めて起動し直す。本番でも同じクエリを`--remote`で、当日のコードで流せば確かめられる。3本のSQLが新アプリの行から期待どおりの結果を出すこと、集計APIがそれを鍵つきで返すことは`apps/worker/test/aggregation.test.ts`が確かめている（`pnpm test:worker`）。

#### 着順

Stage 6のクリアが早い順に、1チーム1行で出る。未ゴールのチームは出てこない。ゲーム画面の帯（`RaceLeaderboard`）はFinalへ入った時刻をゴールとするので、番付の時刻は帯より数秒早い（クリア後の余韻の分）。

#### 監査賞

先頭の行が監査賞である（`s3_min`は分。表示だけ0.1分に丸め、並びは丸める前の時刻で決まる。所要がミリ秒まで同じチームは同着として扱う）。罠を踏んだチームと Stage 3 を未クリアのチームは出てこない。Stage 3 の罠は確実に発動する設計なので、罠を踏まずに通過したチームがおらず結果が0行になることもありうる。そのときは「該当なし」と発表するなど、扱いはファシリテーターが決める。

- 本番は未使用の`EVENT_NO`で行えば（「本番デプロイ前の手順」の手順5）、リハーサルの行は混ざらない。
- 罠は活動ログ（`activity_events`）にしか残らない。活動ログは進捗と別の送信待ちから積まれ、D1が落ちていた間の行は後から届く。デブリーフィングの直前に流せば、遅れた行も入っている。

#### 申し送り

チームコード順に、1チーム1行で出る。同じチームが何度か記した場合は最後の1件、GMリセットしたチームはリセット後に記したものだけが出る。一言を記していないチームは出てこない。

- PIIゲートは活動ログの本文にも掛かる。`submit.final`も例外ではなく、個人情報と判定された一言は伏せ字ではなく**本文ごと保存されない**（`text`が空、`pii_redacted`が1）。そのチームは「記録なし」として飛ばすか、口頭で本人に尋ねる。
- 自由記述なので、読み上げる前に全件へ目を通す（誤検知で空になった行、人に向けた悪口や読み上げにふさわしくない内容がないか）。

### 番付と申し送りの画面（会場へ映す）

着順・監査賞と申し送りは、本番Workerが集計して`https://<worker>/ranking.html`で映す（進捗ボード`/dashboard.html`とは別の画面）。申し送りは番付のフッターの「申し送りへ」を押すか、`https://<worker>/ranking.html#handover`を開く。

- **鍵**: 画面が叩く`GET /api/gm/debrief/results`（着順・監査賞）と`GET /api/gm/debrief/handover`（申し送り）は、GMのリセットと同じ`ADMIN_TOKEN`で守る（参加者が先に開くと監査賞のネタバレになる）。通らなければGM系と同じ404。鍵の渡し方は進捗ボードの`#gm`と同じで、トークン欄に`ADMIN_TOKEN`を入れて「保存」を押すとそのブラウザの`localStorage`に残る（進捗ボードと同じ場所なので、同じブラウザで`/dashboard.html#gm`に保存済みなら入力は要らない）。鍵が無いか違うときだけトークン欄が出て、404なら「トークンを確認してください」と出る。
- **取り直し**: **開いたときに1回だけ**集計を取る（自動更新しない）。デブリーフィングの直前に開くか、出し直すときは再読み込みする。番付と申し送りの切り替えは表示だけで、取り直さない。フッターに開催回と集計した時刻が出る。
- **開催回**: Workerの`EVENT_NO`で絞るので、画面に開催回を渡す必要は無い。`EVENT_NO`が未設定ならフッターにその旨のエラーが出る。
- 表示の決まりは手元の予備と同じ。チームコードは画面に出さない（見えた時点でそのチームへ入室できてしまう）。監査賞が0行なら「該当なし」と出る。所要が同じチームは同着として全チーム出る。申し送りはチームごとのカードにチーム名と一言が出て、本文が空の行は「（記録なし）」になる。映す前に一度、別のタブで中身を確かめる。

リハーサルの前に手元で通すときは、「デブリーフィングの集計」の端末1のように`EVENT_NO`を渡して`ADMIN_TOKEN`も渡したWorkerを起動し（`--var EVENT_NO:99 --var ADMIN_TOKEN:<任意の文字列>`。`pnpm build:testplay`で`public/`を作っておく）、`http://127.0.0.1:8787/ranking.html`を開く。

#### 予備: 手元の番付サーバ

本番Workerの画面が使えないとき（デプロイが間に合わない、Workerの集計APIが失敗する）は、手元のブラウザから映す。リポジトリ直下で次を実行し、`http://127.0.0.1:8790/`（番付）を開く。番付から「申し送りへ」を押すか`http://127.0.0.1:8790/handover`を開くと申し送りが出る。開くたび・30秒ごとに、手元のwranglerで上の`aggregation/`のSQLを`{{EVENT_NO}}`を置き換えて流し、描画する（申し送りのSQLはそのページを開いている間だけ流れる）。鍵は要らない（手元のwranglerのCloudflareログインで読む）。

```bash
node scripts/ranking-board/server.mjs 99           # 開催回99、本番のD1
node scripts/ranking-board/server.mjs 99 --local   # 手元のD1（上の端末1のWorkerで進めたリハーサル。3つ目の端末で起動する）
```

開催回は必ず指定する（既定値は無い）。表示の決まりは本番Workerの画面と同じで、監査賞の同着処理は本番Workerと同じ`apps/worker/src/audit-winners.ts`を読む（Nodeが型を取り除いて読むので、ルートの`package.json`の`engines`どおり、型除去が既定で有効なNode（22系は22.18.0以降、23系以降は23.6.0以降）で起動する）。更新に失敗しても直前の表示は残り、フッターにだけ失敗が出る。

### 当日準備（新アプリの配信）

リハーサル（2026-10-24〜25）と本番（10-31）に向けて、上の各節の手順を**どの順で行い、何を確かめるか**をまとめる。個々の手順の中身は各節を正とし、ここには順番と新アプリ特有の確認だけを書く。

#### 配信の流れ

- **ステージング環境は無い。** Workerは本番の`hell-ict`1つだけで（URLはリポジトリに書かず、手元の`.deploy.env`に置く。「デプロイの流れ」）、リハーサルもこのWorkerで行う。マージ前の確認は手元の`wrangler dev --local`で行う。
- **`main`へマージしたあと、手元で`pnpm deploy:prod`を実行して配信する**（「デプロイの流れ」）。マージしただけでは本番に出ない。`wrangler deploy`を直接打たない。参加者が入室してから終わるまではデプロイしない。
- 配信後に確かめること（上から順に）:
  1. `pnpm deploy:prod`の最後のsmokeが通ったこと。`/api/health`（`guards.eventNo`が`true`、`guards.teamMax`が数値）、`/`がVueアプリで`/app/`のJS・CSSが取れること、`/sounds/decision1.mp3`を自動で確かめている。失敗したら「デプロイの流れ」の「失敗したとき」へ。
  2. **会場のPCで`https://<worker>/?reset`を開き、確認用のコードで入室して、ウェルカム画面（「聖クロノス総合病院 感染制御チーム（ICT）へようこそ」）が出ること。** smokeが見るのは配信物の中身までで、画面が動くかは実物でしか分からない。確認に使ったコードは「本番デプロイ前の手順」手順5の注記のとおり扱う（本番で配らないか、GMリセットしてから配る）。
  3. 会場のスピーカーで効果音が鳴ること。smokeは1点が200で返ることしか見ない。
  4. 配信前から開いていたタブは、すべて再読み込みする。

#### 開催回（`EVENT_NO`）の切り替え

- **本番Workerの`EVENT_NO`は、今はテスト用の`00`である。** リハーサルの前にリハーサル用の未使用の開催回へ、本番の前に本番用の別の未使用の開催回へ切り替える。同じ回を使い回すと、リハーサルのチームの状態（Durable Object）に本番で当たる（「本番デプロイ前の手順」手順5）。
- 切り替えは`cd apps/worker && pnpm exec wrangler secret put EVENT_NO`で行い、あわせて`TEAM_MAX`を配布数＋予備へ下げる（同手順2）。**secretの変更はマージもデプロイも経ずに、その場で本番へ反映される**ので、参加者の進行中には行わない。チームコードは`[開催回2桁][チーム番号4桁]`で刷り直す。
- 確かめ方:
  1. `curl -fsS https://<worker>/api/health`の`guards.eventNo`が`true`、`guards.teamMax`が数値であること（同手順4）。開催回の値そのものは出ない。
  2. 新しい開催回のコードで`/`から入室できること、前の回のコード（`00`なら`000001`）では入室できないこと（同手順6）。
  3. 入室したチームでPrologueのメールに1通返信し、活動ログの`event_id`が新しい開催回になっていること。「デブリーフィングの集計」の端末2のクエリを、`--local`を`--remote`に、`'990001'`を当日の確認用コードに替えて流す。
- 番付の画面（`/ranking.html`）はWorkerの`EVENT_NO`で絞るので、切り替えればそのまま新しい開催回を集計する。手で流すSQLの`{{EVENT_NO}}`と予備の`server.mjs`の引数にだけ、同じ開催回を渡す。

#### 参加者に配るURL

- 配るのは**`https://<worker>/`とチームコードだけ**。`/dashboard.html`、`/ranking.html`、`?reset`はファシリテーター用で、参加者には配らない（`/ranking.html`は鍵が無ければ何も出さない）。
- 困ったときの対処:
  - PCが前のチームのまま開く、入室画面を出し直したい → `https://<worker>/?reset`（「保存済みチームを忘れさせる」）。サーバ側のチームの状態は消えない。
  - 「この端末の状態は古くなっています」と出る → そのPCを再読み込みする。
  - 同じコードに2チームが入ったなど、進行そのものが壊れた → GMリセット（「事故が起きたときの手順」）。

