-- Read reports describe canonical evidence without replacing forecast gap checks.
CREATE FUNCTION sports.player_qualifying_history(player_provider_id text, requested_cutoff timestamptz)
RETURNS TABLE (
  fixture_id text, league_id text, club_id text, kickoff_at timestamptz,
  minutes integer, rating numeric, goals integer, assists integer,
  shots_on_target integer, key_passes integer, tackles integer,
  interceptions integer, saves integer, goals_conceded integer,
  normalized_revision_id uuid
)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, sports AS $$
BEGIN
  IF requested_cutoff IS NULL OR NOT pg_catalog.isfinite(requested_cutoff) THEN
    RAISE EXCEPTION 'History cutoff must be a finite timestamp' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH latest AS (
      SELECT f.provider_id AS fixture_id, c.provider_id AS league_id,
        club.provider_id AS club_id, f.kickoff_at, a.minutes, a.rating,
        a.goals, a.assists, a.shots_on_target, a.key_passes, a.tackles,
        a.interceptions, a.saves, a.goals_conceded, a.normalized_revision_id
      FROM sports.appearances a
      JOIN sports.players p ON p.id = a.player_id
      JOIN sports.fixtures f ON f.id = a.fixture_id
      JOIN sports.competition_seasons cs ON cs.id = f.season_id
      JOIN sports.competitions c ON c.id = cs.competition_id
      JOIN sports.clubs club ON club.id = a.club_id
      JOIN sports.player_memberships m ON m.id = a.membership_id
        AND m.player_id = a.player_id AND m.club_id = a.club_id AND m.season_id = a.season_id
      WHERE p.provider = 'apifootball' AND p.provider_id = player_provider_id
        AND f.provider = 'apifootball' AND club.provider = 'apifootball'
        AND c.provider = 'apifootball' AND c.enabled AND cs.enabled
        AND c.provider_id IN ('153', '164') AND cs.label = '2026/27'
        AND cs.starts_on = DATE '2026-07-01' AND cs.ends_on = DATE '2027-06-30'
        AND c.coefficient = 1.5
        AND ((c.provider_id = '153' AND cs.expected_clubs = 24 AND c.timezone = 'Europe/London')
          OR (c.provider_id = '164' AND cs.expected_clubs = 18 AND c.timezone = 'Europe/Paris'))
        AND f.status = 'final' AND a.participation = 'played' AND a.minutes >= 60
        AND f.kickoff_at < requested_cutoff AND pg_catalog.isfinite(f.kickoff_at)
        AND a.club_id IN (f.home_club_id, f.away_club_id)
        AND f.kickoff_at >= m.valid_from AND (m.valid_until IS NULL OR f.kickoff_at < m.valid_until)
      ORDER BY f.kickoff_at DESC, f.provider_id COLLATE "C" DESC
      LIMIT 5
    )
    SELECT latest.* FROM latest ORDER BY latest.kickoff_at, latest.fixture_id COLLATE "C";
END;
$$;
COMMENT ON FUNCTION sports.player_qualifying_history(text, timestamptz) IS
  'Latest five eligible candidate appearances, in chronological order. Missing metrics remain null. This report does not prove complete history: unresolved appearance and whole-match gaps are checked separately by the forecast engine.';

CREATE FUNCTION sports.forecast_lineage(player_provider_id text, max_rows integer DEFAULT 50)
RETURNS TABLE (
  revision_id uuid, parent_id uuid, ordinal bigint, depth integer,
  model_version text, input_hash text, source_ordinal bigint, cutoff_at timestamptz, status text
)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, sports AS $$
BEGIN
  IF max_rows IS NULL OR max_rows < 1 OR max_rows > 1000 THEN
    RAISE EXCEPTION 'Lineage row limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH RECURSIVE lineage AS (
      SELECT r.id, r.parent_id, r.player_id, r.ordinal, 0 AS depth,
        r.model_version, r.input_hash, r.source_ordinal, r.cutoff_at, r.result_json
      FROM sports.forecast_heads h
      JOIN sports.forecast_revisions r ON r.id = h.revision_id
      JOIN sports.players p ON p.id = h.player_id
      WHERE p.provider = 'apifootball' AND p.provider_id = player_provider_id
      UNION ALL
      SELECT r.id, r.parent_id, r.player_id, r.ordinal, child.depth + 1,
        r.model_version, r.input_hash, r.source_ordinal, r.cutoff_at, r.result_json
      FROM lineage child
      JOIN sports.forecast_revisions r ON r.id = child.parent_id AND r.player_id = child.player_id
      WHERE child.depth + 1 < max_rows AND r.ordinal < child.ordinal
    )
    SELECT chain.id, chain.parent_id, chain.ordinal, chain.depth,
      chain.model_version, chain.input_hash, chain.source_ordinal, chain.cutoff_at, chain.result_json ->> 'status'
    FROM lineage chain ORDER BY chain.depth;
END;
$$;
COMMENT ON FUNCTION sports.forecast_lineage(text, integer) IS
  'Current forecast revision and its ancestors, head first at depth zero. The row limit defaults to 50 and must be between 1 and 1000.';

CREATE PROCEDURE sports.request_forecast_refresh(request_id uuid DEFAULT gen_random_uuid())
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, sports AS $$
DECLARE
  competition_id uuid;
  event_id uuid;
BEGIN
  IF request_id IS NULL THEN
    RAISE EXCEPTION 'Refresh request identifier is required' USING ERRCODE = '22023';
  END IF;
  SELECT c.id INTO competition_id
  FROM sports.competitions c JOIN sports.competition_seasons cs ON cs.competition_id = c.id
  WHERE c.provider = 'apifootball' AND c.enabled AND cs.enabled
    AND c.provider_id IN ('153', '164') AND cs.label = '2026/27'
    AND cs.starts_on = DATE '2026-07-01' AND cs.ends_on = DATE '2027-06-30'
    AND c.coefficient = 1.5
    AND ((c.provider_id = '153' AND cs.expected_clubs = 24 AND c.timezone = 'Europe/London')
      OR (c.provider_id = '164' AND cs.expected_clubs = 18 AND c.timezone = 'Europe/Paris'))
  ORDER BY c.provider_id, c.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No enabled approved competition season is available' USING ERRCODE = '22023';
  END IF;
  INSERT INTO sports.outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    VALUES ('forecast.requested', 'competition', competition_id, 'forecast.manual:' || request_id::text, '{}')
    ON CONFLICT (deduplication_key) DO NOTHING RETURNING id INTO event_id;
  IF event_id IS NOT NULL THEN
    INSERT INTO sports.audit_log(actor_type, actor_id, action, entity_type, entity_key, detail)
      VALUES ('system', session_user, 'forecast.request', 'forecast', request_id::text,
        pg_catalog.jsonb_build_object('requestId', request_id, 'scope', 'all'));
  END IF;
END;
$$;
COMMENT ON PROCEDURE sports.request_forecast_refresh(uuid) IS
  'Queue one local all-player refresh per request UUID. Reusing the UUID is idempotent. This procedure performs no provider or MongoDB operations.';

CREATE FUNCTION sports.record_forecast_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, sports AS $$
DECLARE
  revision record;
  detail jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.revision_id IS NOT DISTINCT FROM OLD.revision_id THEN
    RETURN NULL;
  END IF;
  SELECT r.id, r.parent_id, r.model_version, r.input_hash, r.source_ordinal, p.provider_id
    INTO revision
  FROM sports.forecast_revisions r JOIN sports.players p ON p.id = r.player_id
  WHERE r.id = NEW.revision_id AND r.player_id = NEW.player_id;
  -- Leave invalid references to the existing composite foreign key so its
  -- integrity error is preserved regardless of AFTER-trigger execution order.
  IF NOT FOUND THEN RETURN NULL; END IF;
  detail := pg_catalog.jsonb_build_object('forecastRevisionId', revision.id, 'parentId', revision.parent_id,
    'inputHash', revision.input_hash, 'sourceOrdinal', revision.source_ordinal::text);
  INSERT INTO sports.audit_log(actor_type, actor_id, action, entity_type, entity_key, detail)
    VALUES ('worker', session_user, 'forecast.refresh', 'forecast', revision.provider_id, detail);
  -- Each effective pointer transition is observable, including a return to an
  -- existing revision. The refresh consumer deliberately ignores this event.
  INSERT INTO sports.outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    VALUES ('forecast.updated', 'forecast', NEW.player_id, 'forecast.updated:' || gen_random_uuid()::text,
      detail || pg_catalog.jsonb_build_object('playerId', revision.provider_id, 'modelVersion', revision.model_version));
  RETURN NULL;
END;
$$;
CREATE TRIGGER forecast_head_update_record
AFTER INSERT OR UPDATE OF revision_id ON sports.forecast_heads
FOR EACH ROW EXECUTE FUNCTION sports.record_forecast_update();

REVOKE EXECUTE ON FUNCTION sports.player_qualifying_history(text, timestamptz),
  sports.forecast_lineage(text, integer), sports.record_forecast_update() FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE sports.request_forecast_refresh(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sports.player_qualifying_history(text, timestamptz),
  sports.forecast_lineage(text, integer) TO lsp_reader, lsp_writer;
GRANT EXECUTE ON PROCEDURE sports.request_forecast_refresh(uuid) TO lsp_writer;
