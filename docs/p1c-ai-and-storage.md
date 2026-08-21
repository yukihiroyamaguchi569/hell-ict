# P1C AI・保存基盤

P1Cは、アプリ内AIチャットをWorkers経由でOpenAIへ中継し、チームごとに複数スレッドの会話を保存する。本ドキュメントは実装が進むごとに更新する。現在の内容はチャット骨格（スレッド・メッセージ・OpenAI adapter）と送信前PIIゲートまでを反映する。利用制限、D1ログ、障害耐性の分類は後続のPRで追記する。

## チャットの状態とWebSocket配信

`TeamRoom` DOは`team_state`に加えて`chat_state`を1行だけ持ち、チーム全体のチャットスナップショット（`ChatSnapshot`）をJSONで保存する。初期状態は`メイン`という1本のスレッドだけを持つ。`/api/teams/:teamCode/sync`は接続直後に`{kind:"team", snapshot}`と`{kind:"chat", snapshot}`の2つのenvelopeを順に配信する——チーム状態とチャットログの両方を同じソケットで、再接続のたびに完全復元できるようにするため。リーダーボード配信は変えていない（チームコードを送らず匿名markerだけを送る、というP1Bの契約のまま）。

## コマンドと冪等性

- `POST /api/teams/:teamCode/chat/threads` `{type:"create-thread", commandId, title}` — 新しいスレッドを作成する。スレッドIDはサーバー側で生成する（企画書§7「タスクごとに文脈を分離」を可能にする器）。
- `POST /api/teams/:teamCode/chat/messages` `{type:"send-message", commandId, threadId, text}` — 既存スレッドへメッセージを送り、AIの応答を1往復させる。

いずれもUUIDの`commandId`で冪等。`send-message`は2段階で処理する。

1. ユーザーのメッセージを即座に保存し、進行中commandとして記録する（AI呼び出しが失敗しても消えない）。
2. AI応答が得られたら保存し、進行中commandを完了させる。

AI呼び出し中にクライアントが同じcommandIdで再送すると、ユーザーメッセージを増やさずAI呼び出しだけを再試行する。AIが失敗し続けた場合、ユーザーメッセージだけが残り、assistantメッセージは増えない。

同じcommandIdの送信は、`pending_message_commands`の`claimed_at`でクレームする。既にクレーム済み（＝別のHTTPリクエストが処理中）なら`409`を返しAIを一切呼ばない——ネットワーク再送や複数タブから同じcommandIdが同時に届いても、OpenAI呼び出しは1回だけになる。クレームはAI呼び出しの完了・失敗のどちらでも解放され、失敗後の正当な再送は改めてクレームを取り直す。クレームしたままWorker/DOが応答を返せず終わった場合に備え、45秒（AiGatewayの20秒タイムアウトより十分長い）を超えたクレームは古いものとみなして取り直せるようにしている。

OpenAIのポリシー拒否（`content: null` + `refusal`）は、汎用の失敗（タイムアウト・レート制限など）と区別して`422`を返す——再試行しても無意味なので、汎用の「再試行してください」とは違う応答にする。DO側の状態（pending行の扱い）は通常の失敗と同じ。

## OpenAI adapter

`apps/worker/src/openai-gateway.ts`の`OpenAiGateway`が`AiGateway`を実装する。APIキーは`env.OPENAI_API_KEY`からのみ読み、Authorizationヘッダーにだけ乗せる——応答payloadにもWebSocket配信にも出さない。応答は`packages/domain/src/schemas/openai-response.ts`のschemaで検証してから使う。OpenAIがポリシー拒否で`content: null`かつ`refusal`を返した場合は、原因不明の汎用エラーではなく`refusal`の内容を含むエラーとして区別する。

`OPENAI_API_KEY`は`wrangler.jsonc`の`vars`に置かない（`vars`はCloudflareダッシュボードに平文表示される）。型は`apps/worker/src/env.d.ts`が手書きでグローバルな`Env`型へ追加し、値はローカルでは`apps/worker/.dev.vars`（`.gitignore`済み）、本番では`wrangler secret put OPENAI_API_KEY`で供給する。`OPENAI_BASE_URL`・`OPENAI_MODEL`は秘匿情報ではないため`vars`のままでよい。

AiGatewayの呼び出しは`TeamRoom` DOの外、Workerの`fetch`ハンドラ（`handleChatMessage`）で行う。DOはCloudflare RuntimeのRPCでのみ呼び出され、テストからFakeへ直接差し替えられないため、AI呼び出しをDOの外に出すことで`FakeAiGateway`を注入できる境界を保っている。

## 送信前PIIゲート

`handleChatMessage`（`apps/worker/src/index.ts`）は、`sendMessageCommandSchema`の検証直後・`TeamRoom`にもAiGatewayにも触れる前に、`packages/domain/src/pii.ts`の`detectPii`でユーザー本文を検査する。検知したら`beginChatMessage`を呼ばず、`422`（「個人情報を検知したため、送信をブロックしました。」）を返す——ユーザーメッセージはDOへ保存されず、AI呼び出しも一度も発生しない。

検知パターンの唯一の情報源は`stage4Patient`（`docs/materials/stage4_chart.md`の患者005＝渡辺 三郎の固有情報）。教材との一致は`test/materials/materials.test.ts`で固定する。生年月日・電話番号は固有値ではなく汎用の書式でも拾う——参加者が値を手で書き写した場合も検知するため。「5A病棟の70代男性のご家族へ」のような正しく匿名化した依頼は素通りする。

ゲートは常に全送信へ適用する（ステージによる分岐を持たない）。Stage 4のインシデント発火・黒塗り罰ゲーム・AI使用ロック・回答期限は`teamState`にインシデント/罰の状態が無いため未実装で、Stage 4本体の実装PRへ送る。

## 検証

Worker統合テストは`FakeAiGateway`を直接注入し、複数スレッドの独立性・commandId冪等性・AI失敗時の状態・未知スレッドの拒否・PIIゲート（ブロック時に`FakeAiGateway.requests`が0件のまま・処理済み/進行中commandIdへのPII本文再送も拒否されること）を確認する。OpenAiGateway自体のテストは、APIキーがAuthorizationヘッダーにのみ乗りbodyへ出ないことを確認する。E2Eは実キーを使わず、`e2e/openai-stub.mjs`が返す固定応答を`OPENAI_BASE_URL`の差し替え（`wrangler dev --var`）で参照させる。本番コードに分岐は追加しない。

## 含まないもの

利用制限・トークン予算、D1へのAIログ保存、障害の分類とフォールバック、KV・R2、Stage 4のインシデント状態機械（黒塗り罰ゲーム・AI使用ロック・回答期限）は後続PRで追加する。
