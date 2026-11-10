-- Supplement observations never replace or rewrite the primary provider evidence.
CREATE TABLE sports.appearance_enrichments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appearance_id uuid NOT NULL REFERENCES sports.appearances(id),
  fixture_id uuid NOT NULL REFERENCES sports.fixtures(id),
  primary_revision_id uuid NOT NULL REFERENCES sports.normalized_revisions(id),
  fixture_revision_id uuid NOT NULL REFERENCES sports.normalized_revisions(id),
  source_revision_id uuid NOT NULL REFERENCES sports.source_revisions(id),
  normalized_revision_id uuid NOT NULL UNIQUE REFERENCES sports.normalized_revisions(id),
  external_fixture_id text NOT NULL CHECK (external_fixture_id ~ '^[1-9][0-9]{0,17}$'),
  external_player_id text NOT NULL CHECK (external_player_id ~ '^[1-9][0-9]{0,17}$'),
  retrieved_at timestamptz NOT NULL CHECK (isfinite(retrieved_at)),
  rating numeric(4,2) CHECK (rating BETWEEN 0 AND 10),
  key_passes integer CHECK (key_passes >= 0),
  tackles integer CHECK (tackles >= 0),
  interceptions integer CHECK (interceptions >= 0),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
  UNIQUE (id, appearance_id),
  UNIQUE (source_revision_id, appearance_id)
);
CREATE INDEX appearance_enrichment_history_idx
  ON sports.appearance_enrichments(appearance_id, retrieved_at DESC, id);
CREATE INDEX appearance_enrichment_fixture_idx ON sports.appearance_enrichments(fixture_id, external_fixture_id);

CREATE TABLE sports.appearance_enrichment_heads (
  appearance_id uuid PRIMARY KEY REFERENCES sports.appearances(id),
  enrichment_id uuid NOT NULL,
  conflicted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (enrichment_id, appearance_id)
    REFERENCES sports.appearance_enrichments(id, appearance_id)
);

CREATE FUNCTION sports.validate_appearance_enrichment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sports.appearances a
    JOIN sports.fixtures f ON f.id = a.fixture_id
    JOIN sports.competition_seasons cs ON cs.id = f.season_id
    JOIN sports.competitions c ON c.id = cs.competition_id
    JOIN sports.source_revisions s ON s.id = NEW.source_revision_id
    JOIN sports.normalized_revisions n ON n.id = NEW.normalized_revision_id
    WHERE a.id = NEW.appearance_id AND a.fixture_id = NEW.fixture_id
      AND a.normalized_revision_id = NEW.primary_revision_id
      AND f.normalized_revision_id = NEW.fixture_revision_id
      AND f.provider = 'sorare' AND f.status = 'final'
      AND a.participation = 'played' AND a.minutes > 0
      AND a.club_id IN (f.home_club_id, f.away_club_id)
      AND c.provider = 'sorare' AND c.enabled AND cs.enabled
      AND c.coefficient = 2 AND cs.expected_clubs = 20 AND cs.label = '2026/27'
      AND cs.starts_on = DATE '2026-07-01' AND cs.ends_on = DATE '2027-06-30'
      AND ((c.provider_id = 'premier-league-gb-eng' AND c.timezone = 'Europe/London')
        OR (c.provider_id = 'laliga-es' AND c.timezone = 'Europe/Madrid'))
      AND s.provider = 'highlightly' AND s.action = 'get_statistics'
      AND s.retrieved_at = NEW.retrieved_at AND NEW.retrieved_at <= clock_timestamp()
      AND n.source_revision_id = s.id AND n.entity_type = 'appearance_enrichment'
      AND n.entity_key = NEW.appearance_id::text
  ) THEN
    RAISE EXCEPTION 'Supplement lacks matching current primary evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appearance_enrichment_context_check BEFORE INSERT ON sports.appearance_enrichments
  FOR EACH ROW EXECUTE FUNCTION sports.validate_appearance_enrichment();

CREATE FUNCTION sports.validate_appearance_enrichment_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE previous_time timestamptz; next_time timestamptz; conflict_time timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT retrieved_at INTO previous_time FROM sports.appearance_enrichments WHERE id = OLD.enrichment_id;
    SELECT retrieved_at INTO next_time FROM sports.appearance_enrichments WHERE id = NEW.enrichment_id;
    IF next_time < previous_time THEN
      RAISE EXCEPTION 'Supplement head cannot move to an older observation' USING ERRCODE = '23514';
    END IF;
    IF next_time = previous_time AND OLD.conflicted THEN NEW.conflicted := true; END IF;
    SELECT max(s.retrieved_at) INTO conflict_time FROM sports.normalized_revisions n
      JOIN sports.source_revisions s ON s.id=n.source_revision_id
      WHERE n.entity_type='appearance_enrichment_conflict' AND n.entity_key=NEW.appearance_id::text
        AND s.provider='highlightly' AND s.action='get_events';
    IF conflict_time IS NOT NULL AND next_time<=conflict_time THEN NEW.conflicted := true; END IF;
    IF next_time = previous_time AND NEW.enrichment_id <> OLD.enrichment_id AND EXISTS (
      SELECT 1 FROM sports.appearance_enrichments old_e, sports.appearance_enrichments new_e,
        sports.normalized_revisions old_n, sports.normalized_revisions new_n
      WHERE old_e.id = OLD.enrichment_id AND new_e.id = NEW.enrichment_id
        AND old_n.id = old_e.normalized_revision_id AND new_n.id = new_e.normalized_revision_id
        AND old_n.content_sha256 <> new_n.content_sha256
    ) THEN NEW.conflicted := true; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appearance_enrichment_head_check BEFORE UPDATE ON sports.appearance_enrichment_heads
  FOR EACH ROW EXECUTE FUNCTION sports.validate_appearance_enrichment_head();

CREATE TABLE sports.enrichment_request_quota (
  provider text PRIMARY KEY CHECK (provider = 'highlightly'),
  utc_day date NOT NULL,
  remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND 100)
);

CREATE VIEW sports.effective_appearances AS
SELECT a.id, a.fixture_id, a.player_id, a.season_id, a.club_id, a.membership_id,
  a.participation, a.minutes, coalesce(a.rating, e.rating) AS rating,
  a.goals, a.assists, a.shots_on_target, coalesce(a.key_passes, e.key_passes) AS key_passes,
  coalesce(a.tackles, e.tackles) AS tackles, coalesce(a.interceptions, e.interceptions) AS interceptions,
  a.saves, a.goals_conceded, a.normalized_revision_id,
  jsonb_strip_nulls(jsonb_build_object(
    'rating', CASE WHEN a.rating IS NULL AND e.rating IS NOT NULL THEN meta.value END,
    'keyPasses', CASE WHEN a.key_passes IS NULL AND e.key_passes IS NOT NULL THEN meta.value END,
    'tackles', CASE WHEN a.tackles IS NULL AND e.tackles IS NOT NULL THEN meta.value END,
    'interceptions', CASE WHEN a.interceptions IS NULL AND e.interceptions IS NOT NULL THEN meta.value END
  )) AS enrichment_provenance
FROM sports.appearances a
JOIN sports.fixtures f ON f.id = a.fixture_id
LEFT JOIN sports.appearance_enrichment_heads h ON h.appearance_id = a.id AND NOT h.conflicted
LEFT JOIN sports.appearance_enrichments e ON e.id = h.enrichment_id
  AND e.primary_revision_id = a.normalized_revision_id AND e.fixture_revision_id = f.normalized_revision_id
  AND f.status = 'final' AND a.participation = 'played' AND a.minutes > 0
LEFT JOIN sports.source_revisions s ON s.id = e.source_revision_id
LEFT JOIN LATERAL (
  SELECT jsonb_build_object('provider', 'highlightly', 'revisionId', e.normalized_revision_id,
    'sourceRevisionId', e.source_revision_id, 'observedAt', s.retrieved_at) AS value
) meta ON e.id IS NOT NULL;

REVOKE ALL ON sports.appearance_enrichments, sports.appearance_enrichment_heads,
  sports.enrichment_request_quota, sports.effective_appearances FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sports.validate_appearance_enrichment(),
  sports.validate_appearance_enrichment_head() FROM PUBLIC;
GRANT SELECT ON sports.effective_appearances TO lsp_reader, lsp_writer;
GRANT SELECT, INSERT ON sports.appearance_enrichments TO lsp_writer;
GRANT SELECT, INSERT, UPDATE ON sports.appearance_enrichment_heads, sports.enrichment_request_quota TO lsp_writer;

-- The existing source-aware reporting contract reads the same effective fields
-- as the application; retired-provider reporting keeps its original path.
CREATE OR REPLACE FUNCTION sports.player_qualifying_history(source_provider text, player_provider_id text, requested_cutoff timestamptz)
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
  IF source_provider = 'apifootball' THEN
    RETURN QUERY SELECT * FROM sports.player_qualifying_history(player_provider_id, requested_cutoff);
    RETURN;
  END IF;
  IF source_provider IS DISTINCT FROM 'sorare' THEN
    RAISE EXCEPTION 'Unsupported source provider' USING ERRCODE = '22023';
  END IF;
  IF requested_cutoff IS NULL OR NOT pg_catalog.isfinite(requested_cutoff) THEN
    RAISE EXCEPTION 'History cutoff must be a finite timestamp' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH latest AS (
      SELECT f.provider_id AS fixture_id, c.provider_id AS league_id,
        club.provider_id AS club_id, f.kickoff_at, a.minutes, a.rating,
        a.goals, a.assists, a.shots_on_target, a.key_passes, a.tackles,
        a.interceptions, a.saves, a.goals_conceded, a.normalized_revision_id
      FROM sports.effective_appearances a
      JOIN sports.players p ON p.id = a.player_id
      JOIN sports.fixtures f ON f.id = a.fixture_id
      JOIN sports.competition_seasons cs ON cs.id = f.season_id
      JOIN sports.competitions c ON c.id = cs.competition_id
      JOIN sports.clubs club ON club.id = a.club_id
      JOIN sports.player_memberships m ON m.id = a.membership_id
        AND m.player_id = a.player_id AND m.club_id = a.club_id AND m.season_id = a.season_id
      WHERE p.provider = source_provider AND p.provider_id = player_provider_id
        AND f.provider = source_provider AND club.provider = source_provider
        AND c.provider = source_provider AND c.enabled AND cs.enabled
        AND c.provider_id IN ('premier-league-gb-eng', 'laliga-es') AND cs.label = '2026/27'
        AND cs.starts_on = DATE '2026-07-01' AND cs.ends_on = DATE '2027-06-30'
        AND c.coefficient = 2 AND cs.expected_clubs = 20
        AND ((c.provider_id = 'premier-league-gb-eng' AND c.timezone = 'Europe/London')
          OR (c.provider_id = 'laliga-es' AND c.timezone = 'Europe/Madrid'))
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
