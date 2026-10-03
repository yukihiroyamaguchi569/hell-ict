# 教訓（hell-ict）

このリポジトリ固有の、繰り返さないための教訓を置く。セッション開始時に見直す。

## OpenAIの残高は Limits ではなく Billing で見る（2回ミス）

- **何が起きたか**: 2026-09-26 本番中、OpenAIのAPIクレジット（前払い残高）が尽きてAIが約11分止まった。Limits（レート制限・予算）の画面だけを見て「残っている」と判断し、Billing の残高を見ていなかった。クレジット切れでの停止はこれが2回目。
- **どうするか**:
  - 開催前（前日と当日の開始前）に、Billing（https://platform.openai.com/settings/organization/billing ）でクレジット残高を確かめ、十分に積む。自動チャージは安全のため使わない（2026-10-03 決定）。
  - 「AIが応答しない」で、送信から1秒以内に失敗していて、OpenAIのステータスページが正常なら、まず Billing の残高を疑う（429 `insufficient_quota`）。Limits と Billing は別の画面なので、両方を見る。
  - 残高を尋ねるときは「Billing の Credit balance」と画面名まで指定する。「残高」「上限」とだけ聞くと、Limits を見て答えが返ってくる。
