-- Read-only examples over the synthetic fixture dataset produced by seedDemo.

-- JOIN: source-backed observations distinguish the five eligible matches,
-- the short appearance and the confirmed DNP. Null goals remain null.
SELECT p.provider_id AS player_id,p.position,f.provider_id AS fixture_id,
  c.name AS club,f.kickoff_at,a.participation,a.minutes,a.rating,a.goals,a.assists
FROM sports.appearances a
JOIN sports.players p ON p.id=a.player_id
JOIN sports.fixtures f ON f.id=a.fixture_id
LEFT JOIN sports.clubs c ON c.id=a.club_id
WHERE p.provider='apifootball' AND f.status='final'
ORDER BY p.provider_id,f.kickoff_at,f.provider_id;

-- Nested subquery: players with at least five eligible covered observations.
SELECT p.provider_id AS player_id,p.name,p.position
FROM sports.players p
WHERE p.provider='apifootball' AND p.id IN (
  SELECT a.player_id FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id
  WHERE f.status='final' AND f.kickoff_at<TIMESTAMPTZ '2026-08-10T12:00:00Z'
    AND a.participation='played' AND a.membership_id IS NOT NULL AND a.minutes>=60
  GROUP BY a.player_id HAVING count(*)>=5
)
ORDER BY p.provider_id;

-- Correlated subqueries: each player's eligibility, short-match and DNP counts.
SELECT p.provider_id AS player_id,p.position,
  (SELECT count(*) FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id
   WHERE a.player_id=p.id AND f.status='final' AND f.kickoff_at<TIMESTAMPTZ '2026-08-10T12:00:00Z'
     AND a.participation='played' AND a.membership_id IS NOT NULL AND a.minutes>=60) AS eligible_appearances,
  (SELECT count(*) FROM sports.appearances a WHERE a.player_id=p.id AND a.participation='played' AND a.minutes<60) AS short_appearances,
  (SELECT count(*) FROM sports.appearances a WHERE a.player_id=p.id AND a.participation='dnp') AS confirmed_dnps
FROM sports.players p
WHERE EXISTS (SELECT 1 FROM sports.forecast_heads h WHERE h.player_id=p.id)
ORDER BY p.provider_id;

-- Ordinary CTE and window: select the latest five once, before checking metrics.
WITH eligible AS (
  SELECT p.provider_id AS player_id,f.provider_id AS fixture_id,f.kickoff_at,a.minutes,a.rating,a.goals
  FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id JOIN sports.fixtures f ON f.id=a.fixture_id
  WHERE p.provider='apifootball' AND f.status='final' AND f.kickoff_at<TIMESTAMPTZ '2026-08-10T12:00:00Z'
    AND a.participation='played' AND a.membership_id IS NOT NULL AND a.minutes>=60
), numbered AS (
  SELECT *,row_number() OVER (PARTITION BY player_id ORDER BY kickoff_at DESC,fixture_id DESC) AS recency
  FROM eligible
)
SELECT player_id,fixture_id,kickoff_at,minutes,rating,goals,recency
FROM numbered WHERE recency<=5 ORDER BY player_id,kickoff_at,fixture_id;

-- Explicit recursive CTE follows the current goalkeeper revision through A -> B -> A.
WITH RECURSIVE lineage AS (
  SELECT r.id,r.parent_id,r.ordinal,r.input_hash,r.result_json,0 AS depth
  FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id
  JOIN sports.players p ON p.id=h.player_id WHERE p.provider='apifootball' AND p.provider_id='8001'
  UNION ALL
  SELECT parent.id,parent.parent_id,parent.ordinal,parent.input_hash,parent.result_json,child.depth+1
  FROM lineage child JOIN sports.forecast_revisions parent ON parent.id=child.parent_id
  WHERE child.depth<49
)
SELECT depth,id AS revision_id,parent_id,ordinal,left(input_hash,12) AS input_hash_prefix,
  result_json#>>'{forecastRating,value}' AS forecast_rating_0_to_10
FROM lineage ORDER BY depth;
