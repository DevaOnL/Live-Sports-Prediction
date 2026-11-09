-- Synthetic dataset only. Procedure, trigger and constraint effects roll back.
BEGIN;

-- The useful history function retains exactly the five >=60-minute appearances.
SELECT * FROM sports.player_qualifying_history('8001',TIMESTAMPTZ '2026-08-10T12:00:00Z');

-- The reusable recursive function exposes immutable A -> B -> A lineage.
SELECT depth,revision_id,parent_id,ordinal,left(input_hash,12) AS input_hash_prefix,status
FROM sports.forecast_lineage('8001',50) ORDER BY depth;

-- A manual request enters the existing durable refresh queue. Reusing its UUID
-- demonstrates idempotency: one outbox event and one request audit entry.
CALL sports.request_forecast_refresh('10000000-0000-4000-8000-000000000001'::uuid);
CALL sports.request_forecast_refresh('10000000-0000-4000-8000-000000000001'::uuid);
SELECT 'request_outbox_events' AS evidence,count(*) AS rows
FROM sports.outbox WHERE deduplication_key='forecast.manual:10000000-0000-4000-8000-000000000001'
UNION ALL
SELECT 'request_audit_entries',count(*) FROM sports.audit_log
WHERE action='forecast.request' AND entity_key='10000000-0000-4000-8000-000000000001';

-- The seed's effective forecast head changes invoked database triggers.
-- Re-evaluating an unchanged hash did not create extra audit/outbox rows.
SELECT p.provider_id AS player_id,
  (SELECT count(*) FROM sports.audit_log a WHERE a.action='forecast.refresh' AND a.entity_key=p.provider_id) AS refresh_audits,
  (SELECT count(*) FROM sports.outbox o WHERE o.event_type='forecast.updated' AND o.aggregate_id=p.id) AS forecast_update_events
FROM sports.players p WHERE p.provider='apifootball' ORDER BY p.provider_id;

-- Change an existing head to its parent once, then repeat the same pointer.
-- The trigger must add exactly one audit and notification; rollback restores all.
DO $$
DECLARE
  target uuid;
  parent uuid;
  audits_before bigint;
  events_before bigint;
BEGIN
  SELECT h.player_id,r.parent_id INTO STRICT target,parent
  FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id
  JOIN sports.players p ON p.id=h.player_id WHERE p.provider='apifootball' AND p.provider_id='8001';
  IF parent IS NULL THEN RAISE EXCEPTION 'Synthetic lineage parent is required'; END IF;
  SELECT count(*) INTO audits_before FROM sports.audit_log WHERE action='forecast.refresh';
  SELECT count(*) INTO events_before FROM sports.outbox WHERE event_type='forecast.updated';
  UPDATE sports.forecast_heads SET revision_id=parent WHERE player_id=target;
  UPDATE sports.forecast_heads SET revision_id=parent WHERE player_id=target;
  IF (SELECT count(*) FROM sports.audit_log WHERE action='forecast.refresh') <> audits_before+1
    OR (SELECT count(*) FROM sports.outbox WHERE event_type='forecast.updated') <> events_before+1 THEN
    RAISE EXCEPTION 'Expected one trigger effect and no duplicate for an unchanged pointer';
  END IF;
END;
$$;
SELECT true AS trigger_transition_verified, true AS unchanged_pointer_skipped;

-- A roster cannot refer to a missing player. Catch only the expected FK error;
-- a missing constraint makes this demonstration fail rather than claim success.
DO $$
BEGIN
  BEGIN
    INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT r.snapshot_id,r.season_id,'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid,r.club_id
    FROM sports.roster_entries r ORDER BY r.snapshot_id,r.player_id LIMIT 1;
    RAISE EXCEPTION 'Expected the roster player foreign key to reject this row';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'Verified: foreign key rejected a roster entry for an unknown player';
  END;
END;
$$;

SELECT true AS foreign_key_rejection_verified;

ROLLBACK;
