# P1B 最小状態管理

P1Bは、ASCII数字6桁のチームコードをDurable Object名として使い、チーム状態を1チーム1 SQLite-backed Durable Objectへ集約する。`POST /api/session` は初回にPrologue状態を作成し、再入室では同じ状態とrevisionを返す。

状態は共有domain schemaから推論する。初期値は `mode: peace`、`stage: prologue`、在院398/400・空床2・原因不明の発熱3、revision 0である。P1Bの遷移は `enter-stage1` による `prologue -> stage1` だけで、成功時だけrevisionを1増やす。

コマンドは `POST /api/teams/:teamCode/commands` にUUIDの`commandId`と`expectedRevision`を含める。TeamRoomは状態更新と処理済みcommand ledgerをSQLiteへ保存してからリーダーボードを更新する。同一IDは保存済み結果を返し、リーダーボード更新が一時失敗した場合は同じIDの再送で修復する。revision競合・禁止遷移は409で、状態を変えない。

`TeamRoom` と `RaceLeaderboard` はHibernatable WebSocketを使用する。`/api/teams/:teamCode/sync` と `/api/leaderboard/sync?teamCode=...` は接続直後と更新後に完全snapshotを配信し、コマンドを受け付けない。attachmentと全HTTP/WebSocket payloadはdomain schemaで検証する。リーダーボードはチームコードを送らず、匿名markerと`isSelf`だけを送る。

P1BはOpenAI、PII検知、D1/KV/R2、本番deploy、ゲーム時計、Stage 1の課題・提出を含まない。
