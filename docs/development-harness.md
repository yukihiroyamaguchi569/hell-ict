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
| `EVENT_NO` | 6桁なら任意のコードで入室できる（ローカル開発とE2Eを壊さないための意図的なfail-open） | 本番。**開催回を2桁数字（`02`のように0埋め）で設定する。** チームコードは`[開催回2桁][チーム番号4桁]`で、上2桁が`EVENT_NO`と一致し、下4桁が1〜`TEAM_MAX`のコードだけを通す。規則から外れたコードは入室・チーム操作・リーダーボード購読・進捗記録のすべてで404になり、Durable ObjectもD1の行も作らない。**2桁数字でない値（空文字・1桁・3桁・非数）はfail-closedで全コードを拒否する**（`guards.eventNo`が`"invalid"`）。開催回だけで入室できるわけではない（入室資格はコード全体）が、知られると通るコードの範囲が狭まるので、`wrangler secret put EVENT_NO`で与え、`/api/health`にも値そのものは出さない |
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

1. 開催回を決め、チームコードを`[開催回2桁][チーム番号4桁]`で配る（第2回のチーム1なら`020001`）。**予備コードは登録不要で、次の番号（`020007`、`020008`…）をそのまま配ればよい。** 開催回を切り替えれば、前回開催やリハーサルのチームは入室も配信もできなくなる。
2. `wrangler secret put EVENT_NO` で開催回を設定する（`apps/worker`で実行）。**あわせて`wrangler deploy --var TEAM_MAX:10`のように、配布数＋予備まで上限を下げる**（100を超えるチーム数のときだけ上げる）。Cloudflareダッシュボードの Workers &gt; 対象Worker &gt; Settings &gt; Variables から入れてもよい。
3. 配信版はモックHTMLをWorkerのAssetsから同一オリジンで配るため、`ALLOWED_ORIGINS`は未設定のままでよい。別オリジン配信へ切り替えたときだけ設定する。
4. デプロイ後、`GET /api/health`の`guards`で設定が効いているか確認する。`{"status":"ok","guards":{"eventNo":true,"teamMax":100,"allowedOrigins":false,"chatRateLimitPerMinute":20}}`のように返るので、次の2つを必ず見る。**開催回そのものと許可オリジンの値は伏せてある**——healthはOrigin不問で誰でも読めるため、開催回が見えると通るコードの範囲が6桁全体から1万通りへ狭まる。
   - **`eventNo`が`true`であること。** `false`なら`EVENT_NO`の設定漏れで、6桁なら誰でも入れる状態のまま本番を迎えることになる。`"invalid"`なら値が壊れている（2桁数字でない）状態で、**全チームが404で入室できない**——書き損じをここで捕まえる。値そのものは出ないので、**設定した開催回が合っているかは次の手順（実際に入室してみる）で確かめる**。前回の開催回のままだと、当日配ったコードが全部404になる。
   - **`teamMax`が配布したチーム番号の最大以上であること。** `"invalid"`なら`TEAM_MAX`の書き損じで全チームが入室できない。既定のまま運用するなら`100`と出る。
5. **`EVENT_NO`と一致するコード（当日の開催回が第2回なら`020001`）で実際に入室できることを確認する。** healthは開催回の値を出さないので、設定した値が合っているかはこれでしか分からない。あわせて、別の開催回のコード（`010001`など）や上限を超えるチーム番号が404で弾かれることも確認する。素の`curl -X POST https://<worker>/api/session -d '{"teamCode":"100001"}'`はOriginが無いので403になるが、これはガードが配線されている確認であって防御の強さの確認ではない（`-H "Origin: https://<worker>"`を付ければ通る。上の注記を参照）。

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

分析クエリで`kind`を列挙するときは、`progress_events`に`reset`が、`activity_events`に`gm.reset`が増えたことに注意する（[ログ分析手順](testplay/ログ分析手順.md)）。位置の集計（手順1）は`jump` / `resume`と同じく`reset`を除外する。

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
