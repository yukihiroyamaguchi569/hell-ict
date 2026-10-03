/*
  監査賞: Stage 3 の罠（活動ログの game.trap で meta.stage が s3）を一度も踏まずに Stage 3 をクリアしたチームを、
  Stage 3 に入ってから（pos 3 の entry）クリアするまで（pos 4 の clear）が短い順に並べる。先頭が受賞。
  GMリセットしたチームはリセット後の行だけを数える（進捗は世代、活動ログは gm.reset より後の id）。
  時刻は client_at（サーバが遷移させた時刻）。EVENT_NO の置き場所は開催回の2桁に置き換えてから流す。
  先頭を -- の行コメントにしない: wrangler の --command へ渡すと、値がオプションと解釈されて失敗する。
*/
WITH
gen AS (SELECT team_code, MAX(generation) AS g FROM progress_events WHERE kind = 'reset' GROUP BY team_code),
prog AS (SELECT p.* FROM progress_events p LEFT JOIN gen ON gen.team_code = p.team_code
         WHERE substr(p.team_code, 1, 2) = '{{EVENT_NO}}' AND p.generation >= COALESCE(gen.g, 0) AND p.client_at <> ''),
rst AS (SELECT team_code, MAX(id) AS rid FROM activity_events WHERE event_id = '{{EVENT_NO}}' AND kind = 'gm.reset' GROUP BY team_code),
trap AS (SELECT DISTINCT a.team_code FROM activity_events a LEFT JOIN rst ON rst.team_code = a.team_code
         WHERE a.event_id = '{{EVENT_NO}}' AND a.kind = 'game.trap' AND json_extract(a.meta, '$.stage') = 's3'
           AND a.id > COALESCE(rst.rid, 0)),
s3 AS (SELECT team_code,
         MIN(CASE WHEN pos = 3 AND kind = 'entry' THEN client_at END) AS s3_start,
         MIN(CASE WHEN pos = 4 AND kind = 'clear' THEN client_at END) AS s3_clear
       FROM prog GROUP BY team_code),
nm AS (SELECT team_code, MAX(id) AS id FROM progress_events WHERE team_name <> '' GROUP BY team_code)
SELECT s3.team_code, COALESCE(n.team_name, '') AS team_name,
  ROUND((julianday(s3_clear) - julianday(s3_start)) * 1440, 1) AS s3_min,
  strftime('%Y-%m-%d %H:%M:%f', s3_start) AS s3_start, strftime('%Y-%m-%d %H:%M:%f', s3_clear) AS s3_clear
FROM s3
LEFT JOIN nm ON nm.team_code = s3.team_code
LEFT JOIN progress_events n ON n.id = nm.id
WHERE s3_start IS NOT NULL AND s3_clear IS NOT NULL
  AND s3.team_code NOT IN (SELECT team_code FROM trap)
ORDER BY julianday(s3_clear) - julianday(s3_start), s3.team_code
