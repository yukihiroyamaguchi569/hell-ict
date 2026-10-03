/*
  着順: Stage 6 のクリア（pos 7 の clear）が早い順。GMリセットしたチームはリセット後の世代の行だけを数える。
  時刻は client_at（サーバがステージをクリアさせた時刻）。created_at はD1へ積めた時刻で、D1が落ちていた間は遅れる。
  EVENT_NO の置き場所は開催回の2桁に置き換えてから流す（docs/development-harness.md）。
  先頭を -- の行コメントにしない: wrangler の --command へ渡すと、値がオプションと解釈されて失敗する。
*/
WITH
gen AS (SELECT team_code, MAX(generation) AS g FROM progress_events WHERE kind = 'reset' GROUP BY team_code),
nm AS (SELECT team_code, MAX(id) AS id FROM progress_events WHERE team_name <> '' GROUP BY team_code),
goal AS (SELECT p.team_code, MIN(p.client_at) AS at FROM progress_events p LEFT JOIN gen ON gen.team_code = p.team_code
         WHERE substr(p.team_code, 1, 2) = '{{EVENT_NO}}' AND p.generation >= COALESCE(gen.g, 0)
           AND p.pos = 7 AND p.kind = 'clear' AND p.client_at <> ''
         GROUP BY p.team_code)
SELECT goal.team_code, COALESCE(n.team_name, '') AS team_name,
  strftime('%Y-%m-%d %H:%M:%f', goal.at) AS goal_at_utc
FROM goal
LEFT JOIN nm ON nm.team_code = goal.team_code
LEFT JOIN progress_events n ON n.id = nm.id
ORDER BY julianday(goal.at), goal.team_code
