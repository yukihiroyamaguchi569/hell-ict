/*
  次のICTへの申し送り: Final の一言（活動ログの submit.final）を、チームごとに最後の1件だけ出す。
  GMリセットしたチームはリセット後に記したものだけ。PIIと判定された一言は text が空で pii_redacted が1。
  EVENT_NO の置き場所は開催回の2桁に置き換えてから流す（docs/development-harness.md）。
  先頭を -- の行コメントにしない: wrangler の --command へ渡すと、値がオプションと解釈されて失敗する。
*/
WITH
rst AS (SELECT team_code, MAX(id) AS rid FROM activity_events WHERE event_id = '{{EVENT_NO}}' AND kind = 'gm.reset' GROUP BY team_code),
last AS (SELECT a.team_code, MAX(a.id) AS id FROM activity_events a LEFT JOIN rst ON rst.team_code = a.team_code
         WHERE a.event_id = '{{EVENT_NO}}' AND a.kind = 'submit.final' AND a.id > COALESCE(rst.rid, 0) GROUP BY a.team_code),
nm AS (SELECT team_code, MAX(id) AS id FROM progress_events WHERE team_name <> '' GROUP BY team_code)
SELECT last.team_code, COALESCE(p.team_name, '') AS team_name, a.text,
  COALESCE(json_extract(a.meta, '$.piiRedacted'), 0) AS pii_redacted, a.created_at
FROM last
JOIN activity_events a ON a.id = last.id
LEFT JOIN nm ON nm.team_code = last.team_code
LEFT JOIN progress_events p ON p.id = nm.id
ORDER BY last.team_code
