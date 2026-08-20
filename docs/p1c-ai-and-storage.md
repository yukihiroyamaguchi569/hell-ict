# P1C AI・保存基盤

P1Cは、アプリ内AIチャットをWorkers経由でOpenAIへ中継し、チームごとに複数スレッドの会話を保存する。本ドキュメントは実装が進むごとに更新する。現在の内容はチャット骨格（スレッド・メッセージ・OpenAI adapter）までを反映する。PII検知・送信前ゲート、利用制限、D1ログ、障害耐性の分類は後続のPRで追記する。

## チャットの状態とWebSocket配信

`TeamRoom` DOは`team_state`に加えて`chat_state`を1行だけ持ち、チーム全体のチャットスナップショット（`ChatSnapshot`）をJSONで保存する。初期状態は`メイン`という1本のスレッドだけを持つ。`/api/teams/:teamCode/sync`は接続直後に`{kind:"team", snapshot}`と`{kind:"chat", snapshot}`の2つのenvelopeを順に配信する——チーム状態とチャットログの両方を同じソケットで、再接続のたびに完全復元できるようにするため。リーダーボード配信は変えていない（チームコードを送らず匿名markerだけを送る、というP1Bの契約のまま）。

## コマンドと冪等性

- `POST /api/teams/:teamCode/chat/threads` `{type:"create-thread", commandId, title}` — 新しいスレッドを作成する。スレッドIDはサーバー側で生成する（企画書§7「タスクごとに文脈を分離」を可能にする器）。
- `POST /api/teams/:teamCode/chat/messages` `{type:"send-message", commandId, threadId, text}` — 既存スレッドへメッセージを送り、AIの応答を1往復させる。

いずれもUUIDの`commandId`で冪等。`send-message`は2段階で処理する。

1. ユーザーのメッセージを即座に保存し、進行中commandとして記録する（AI呼び出しが失敗しても消えない）。
2. AI応答が得られたら保存し、進行中commandを完了させる。

AI呼び出し中にクライアントが同じcommandIdで再送すると、ユーザーメッセージを増やさずAI呼び出しだけを再試行する。AIが失敗し続けた場合、ユーザーメッセージだけが残り、assistantメッセージは増えない。

## OpenAI adapter

`apps/worker/src/openai-gateway.ts`の`OpenAiGateway`が`AiGateway`を実装する。APIキーは`env.OPENAI_API_KEY`からのみ読み、Authorizationヘッダーにだけ乗せる——応答payloadにもWebSocket配信にも出さない。応答は`packages/domain/src/schemas/openai-response.ts`のschemaで検証してから使う。OpenAIがポリシー拒否で`content: null`かつ`refusal`を返した場合は、原因不明の汎用エラーではなく`refusal`の内容を含むエラーとして区別する。

`OPENAI_API_KEY`は`wrangler.jsonc`の`vars`に置かない（`vars`はCloudflareダッシュボードに平文表示される）。型は`apps/worker/src/env.d.ts`が手書きでグローバルな`Env`型へ追加し、値はローカルでは`apps/worker/.dev.vars`（`.gitignore`済み）、本番では`wrangler secret put OPENAI_API_KEY`で供給する。`OPENAI_BASE_URL`・`OPENAI_MODEL`は秘匿情報ではないため`vars`のままでよい。

AiGatewayの呼び出しは`TeamRoom` DOの外、Workerの`fetch`ハンドラ（`handleChatMessage`）で行う。DOはCloudflare RuntimeのRPCでのみ呼び出され、テストからFakeへ直接差し替えられないため、AI呼び出しをDOの外に出すことで`FakeAiGateway`を注入できる境界を保っている。

## 検証

Worker統合テストは`FakeAiGateway`を直接注入し、複数スレッドの独立性・commandId冪等性・AI失敗時の状態・未知スレッドの拒否を確認する。OpenAiGateway自体のテストは、APIキーがAuthorizationヘッダーにのみ乗りbodyへ出ないことを確認する。E2Eは実キーを使わず、`e2e/openai-stub.mjs`が返す固定応答を`OPENAI_BASE_URL`の差し替え（`wrangler dev --var`）で参照させる。本番コードに分岐は追加しない。

## 含まないもの

PII検知・送信前ゲート、レート制限・トークン予算、D1へのAIログ保存、障害の分類とフォールバック、KV・R2は後続PRで追加する。
