-- Canonical records and durable processing metadata; no data import or forecasts.
CREATE SCHEMA sports AUTHORIZATION lsp_migrator;

CREATE TABLE sports.source_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'apifootball' CHECK (btrim(provider) <> ''),
  action text NOT NULL CHECK (btrim(action) <> ''),
  resource_key text NOT NULL CHECK (btrim(resource_key) <> ''),
  archive_ref text NOT NULL UNIQUE CHECK (btrim(archive_ref) <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  retrieved_at timestamptz NOT NULL,
  UNIQUE (provider, action, resource_key, content_sha256)
);

CREATE TABLE sports.normalized_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_revision_id uuid NOT NULL REFERENCES sports.source_revisions(id),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_key text NOT NULL CHECK (btrim(entity_key) <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, entity_type, entity_key),
  UNIQUE (source_revision_id, entity_type, entity_key, content_sha256),
  FOREIGN KEY (parent_id, entity_type, entity_key)
    REFERENCES sports.normalized_revisions(id, entity_type, entity_key),
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE sports.competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'apifootball' CHECK (btrim(provider) <> ''),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  country_name text NOT NULL CHECK (btrim(country_name) <> ''),
  timezone text NOT NULL CHECK (btrim(timezone) <> ''),
  coefficient numeric(2,1) NOT NULL CHECK (coefficient IN (1.5, 2.0)),
  enabled boolean NOT NULL DEFAULT false,
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  UNIQUE (provider, provider_id)
);

CREATE TABLE sports.competition_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES sports.competitions(id),
  label text NOT NULL CHECK (btrim(label) <> ''),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  expected_clubs smallint NOT NULL CHECK (expected_clubs >= 2),
  enabled boolean NOT NULL DEFAULT false,
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  CHECK (ends_on >= starts_on),
  UNIQUE (competition_id, label)
);

CREATE TABLE sports.clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'apifootball' CHECK (btrim(provider) <> ''),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  UNIQUE (provider, provider_id)
);

CREATE TABLE sports.season_clubs (
  season_id uuid NOT NULL REFERENCES sports.competition_seasons(id),
  club_id uuid NOT NULL REFERENCES sports.clubs(id),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  PRIMARY KEY (season_id, club_id)
);

CREATE TABLE sports.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'apifootball' CHECK (btrim(provider) <> ''),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  position text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (position IN ('GK', 'DEF', 'MID', 'FWD', 'UNKNOWN')),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  UNIQUE (provider, provider_id)
);

CREATE TABLE sports.player_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES sports.players(id),
  club_id uuid NOT NULL,
  season_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  UNIQUE (id, player_id, club_id, season_id),
  UNIQUE (player_id, club_id, season_id, valid_from)
);

CREATE TABLE sports.fixtures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'apifootball' CHECK (btrim(provider) <> ''),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  season_id uuid NOT NULL REFERENCES sports.competition_seasons(id),
  home_club_id uuid NOT NULL,
  away_club_id uuid NOT NULL,
  kickoff_at timestamptz,
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'scheduled', 'live', 'final', 'postponed', 'cancelled')),
  statistics_status text NOT NULL DEFAULT 'unknown'
    CHECK (statistics_status IN ('unknown', 'missing', 'partial', 'complete')),
  home_score integer CHECK (home_score >= 0),
  away_score integer CHECK (away_score >= 0),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  FOREIGN KEY (season_id, home_club_id) REFERENCES sports.season_clubs(season_id, club_id),
  FOREIGN KEY (season_id, away_club_id) REFERENCES sports.season_clubs(season_id, club_id),
  CHECK (home_club_id <> away_club_id),
  UNIQUE (provider, provider_id),
  UNIQUE (id, season_id)
);

CREATE TABLE sports.appearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES sports.players(id),
  season_id uuid NOT NULL,
  club_id uuid REFERENCES sports.clubs(id),
  membership_id uuid REFERENCES sports.player_memberships(id),
  participation text NOT NULL DEFAULT 'unknown'
    CHECK (participation IN ('unknown', 'played', 'dnp')),
  minutes integer CHECK (minutes >= 0),
  rating numeric(4,2) CHECK (rating BETWEEN 0 AND 10),
  goals integer CHECK (goals >= 0),
  assists integer CHECK (assists >= 0),
  shots_on_target integer CHECK (shots_on_target >= 0),
  key_passes integer CHECK (key_passes >= 0),
  tackles integer CHECK (tackles >= 0),
  interceptions integer CHECK (interceptions >= 0),
  saves integer CHECK (saves >= 0),
  goals_conceded integer CHECK (goals_conceded >= 0),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  FOREIGN KEY (fixture_id, season_id) REFERENCES sports.fixtures(id, season_id),
  FOREIGN KEY (membership_id, player_id, club_id, season_id)
    REFERENCES sports.player_memberships(id, player_id, club_id, season_id),
  CHECK (participation = 'unknown' OR (club_id IS NOT NULL AND membership_id IS NOT NULL)),
  CHECK (membership_id IS NULL OR club_id IS NOT NULL),
  CHECK (participation <> 'dnp' OR (
    coalesce(minutes, 0) = 0 AND coalesce(rating, 0) = 0
    AND coalesce(goals, 0) = 0 AND coalesce(assists, 0) = 0
    AND coalesce(shots_on_target, 0) = 0 AND coalesce(key_passes, 0) = 0
    AND coalesce(tackles, 0) = 0 AND coalesce(interceptions, 0) = 0
    AND coalesce(saves, 0) = 0 AND coalesce(goals_conceded, 0) = 0
  )),
  UNIQUE (fixture_id, player_id)
);

CREATE TABLE sports.standings_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES sports.competition_seasons(id),
  cutoff_local_date date NOT NULL,
  cutoff_at timestamptz NOT NULL,
  normalized_revision_id uuid NOT NULL REFERENCES sports.normalized_revisions(id),
  complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, cutoff_local_date, normalized_revision_id),
  UNIQUE (id, season_id)
);

CREATE TABLE sports.standings_rows (
  snapshot_id uuid NOT NULL,
  season_id uuid NOT NULL,
  club_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position > 0),
  rank_uncertain boolean NOT NULL DEFAULT false,
  played smallint NOT NULL CHECK (played >= 0),
  wins smallint NOT NULL CHECK (wins >= 0),
  draws smallint NOT NULL CHECK (draws >= 0),
  losses smallint NOT NULL CHECK (losses >= 0),
  goals_for integer NOT NULL CHECK (goals_for >= 0),
  goals_against integer NOT NULL CHECK (goals_against >= 0),
  points integer NOT NULL,
  PRIMARY KEY (snapshot_id, club_id),
  FOREIGN KEY (snapshot_id, season_id) REFERENCES sports.standings_snapshots(id, season_id),
  FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id),
  CHECK (played = wins + draws + losses)
);

CREATE TABLE sports.points_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL,
  club_id uuid NOT NULL,
  points integer NOT NULL CHECK (points <> 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  effective_at timestamptz NOT NULL,
  provenance_url text NOT NULL CHECK (provenance_url ~ '^https://'),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id),
  UNIQUE (season_id, club_id, effective_at, provenance_url)
);

CREATE TABLE sports.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id uuid NOT NULL,
  deduplication_key text NOT NULL UNIQUE CHECK (btrim(deduplication_key) <> ''),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (published_at IS NULL OR published_at >= created_at)
);

CREATE TABLE sports.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES sports.outbox(id),
  kind text NOT NULL CHECK (btrim(kind) <> ''),
  deduplication_key text NOT NULL UNIQUE CHECK (btrim(deduplication_key) <> ''),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text CHECK (locked_by IS NULL OR btrim(locked_by) <> ''),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (attempts <= max_attempts),
  CHECK (status <> 'ready' OR attempts < max_attempts),
  CHECK ((status = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CHECK (status <> 'running' OR attempts > 0),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE sports.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'user', 'worker', 'migrator')),
  actor_id text,
  action text NOT NULL CHECK (btrim(action) <> ''),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_key text NOT NULL CHECK (btrim(entity_key) <> ''),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_type <> 'user' OR (actor_id IS NOT NULL AND btrim(actor_id) <> ''))
);

CREATE INDEX membership_player_time_idx ON sports.player_memberships(player_id, valid_from);
CREATE INDEX membership_season_club_idx ON sports.player_memberships(season_id, club_id);
CREATE INDEX fixture_season_time_idx ON sports.fixtures(season_id, kickoff_at, provider_id);
CREATE INDEX fixture_home_time_idx ON sports.fixtures(home_club_id, kickoff_at);
CREATE INDEX fixture_away_time_idx ON sports.fixtures(away_club_id, kickoff_at);
CREATE INDEX appearance_player_fixture_idx ON sports.appearances(player_id, fixture_id);
CREATE INDEX appearance_membership_idx ON sports.appearances(membership_id);
CREATE INDEX normalized_revision_parent_idx ON sports.normalized_revisions(parent_id);
CREATE INDEX normalized_revision_entity_idx ON sports.normalized_revisions(entity_type, entity_key, ordinal DESC);
CREATE INDEX source_revision_resource_idx ON sports.source_revisions(provider, resource_key, retrieved_at DESC);
CREATE INDEX standings_season_date_idx ON sports.standings_snapshots(season_id, cutoff_local_date DESC);
CREATE INDEX standings_row_club_idx ON sports.standings_rows(season_id, club_id);
CREATE INDEX adjustment_club_time_idx ON sports.points_adjustments(season_id, club_id, effective_at);
CREATE INDEX pending_outbox_idx ON sports.outbox(created_at, id) WHERE published_at IS NULL;
CREATE INDEX ready_job_idx ON sports.jobs(run_after, id) WHERE status = 'ready';
CREATE INDEX expired_job_idx ON sports.jobs(locked_until, id) WHERE status = 'running';
CREATE INDEX audit_entity_time_idx ON sports.audit_log(entity_type, entity_key, occurred_at DESC);

-- Integrity helpers are SECURITY INVOKER and contain no business processing.
CREATE FUNCTION sports.validate_revision_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE parent_ordinal bigint;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT ordinal INTO parent_ordinal FROM sports.normalized_revisions WHERE id = NEW.parent_id;
    IF parent_ordinal IS NULL OR parent_ordinal >= NEW.ordinal THEN
      RAISE EXCEPTION 'Revision parent must precede its child' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM sports.normalized_revisions WHERE parent_id = NEW.id AND ordinal <= NEW.ordinal) THEN
    RAISE EXCEPTION 'Revision order would invalidate a child' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER normalized_revision_chain_check
BEFORE INSERT OR UPDATE ON sports.normalized_revisions
FOR EACH ROW EXECUTE FUNCTION sports.validate_revision_chain();

CREATE FUNCTION sports.validate_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown competition timezone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER competition_timezone_check
BEFORE INSERT OR UPDATE OF timezone ON sports.competitions
FOR EACH ROW EXECUTE FUNCTION sports.validate_timezone();

CREATE FUNCTION sports.validate_appearance_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE
  item record;
  fixture_ids uuid[];
  membership_ids uuid[];
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Appearance context writes require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  -- Every branch locks both kinds of parent before reading final context. This
  -- prevents fixture/membership parent-parent write skew, as well as a concurrent
  -- child insertion. Order each parent set consistently; conflicting preexisting
  -- UPDATE locks may still cause a deadlock abort requiring a transaction retry.
  SELECT array_agg(DISTINCT a.fixture_id ORDER BY a.fixture_id),
    array_agg(DISTINCT a.membership_id ORDER BY a.membership_id)
  INTO fixture_ids, membership_ids
  FROM sports.appearances a
  WHERE (TG_TABLE_NAME = 'appearances' AND a.id = NEW.id)
     OR (TG_TABLE_NAME = 'fixtures' AND a.fixture_id = NEW.id)
     OR (TG_TABLE_NAME = 'player_memberships' AND a.membership_id = NEW.id);
  PERFORM 1 FROM sports.fixtures
    WHERE id = ANY(fixture_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM sports.player_memberships
    WHERE id = ANY(membership_ids) ORDER BY id FOR SHARE;
  FOR item IN
    SELECT a.id, a.club_id, f.home_club_id, f.away_club_id, f.kickoff_at,
      m.id AS membership_id, m.valid_from, m.valid_until
    FROM sports.appearances a
    JOIN sports.fixtures f ON f.id = a.fixture_id
    LEFT JOIN sports.player_memberships m ON m.id = a.membership_id
    WHERE (TG_TABLE_NAME = 'appearances' AND a.id = NEW.id)
       OR (TG_TABLE_NAME = 'fixtures' AND a.fixture_id = NEW.id)
       OR (TG_TABLE_NAME = 'player_memberships' AND a.membership_id = NEW.id)
  LOOP
    IF item.club_id IS NOT NULL AND item.club_id <> item.home_club_id AND item.club_id <> item.away_club_id THEN
      RAISE EXCEPTION 'Appearance club is not a fixture participant' USING ERRCODE = '23514';
    END IF;
    IF item.membership_id IS NOT NULL AND item.kickoff_at IS NOT NULL
      AND (item.kickoff_at < item.valid_from OR
        (item.valid_until IS NOT NULL AND item.kickoff_at >= item.valid_until)) THEN
      RAISE EXCEPTION 'Appearance falls outside player membership' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER appearance_context_check
AFTER INSERT OR UPDATE ON sports.appearances DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_appearance_context();
CREATE CONSTRAINT TRIGGER fixture_appearance_context_check
AFTER UPDATE ON sports.fixtures DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_appearance_context();
CREATE CONSTRAINT TRIGGER membership_appearance_context_check
AFTER UPDATE ON sports.player_memberships DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_appearance_context();

CREATE FUNCTION sports.assert_standings_snapshot(snapshot uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE item record;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Standings context writes require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  -- One transaction-scoped lock serializes this small project's standings
  -- context checks without granting UPDATE on immutable snapshots just to lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lsp:standings-context', 0));
  SELECT ss.*, cs.starts_on, cs.ends_on, cs.expected_clubs, c.timezone INTO item
  FROM sports.standings_snapshots ss
  JOIN sports.competition_seasons cs ON cs.id = ss.season_id
  JOIN sports.competitions c ON c.id = cs.competition_id
  WHERE ss.id = snapshot;
  IF NOT FOUND THEN RETURN; END IF;
  IF item.cutoff_at <> (item.cutoff_local_date::timestamp AT TIME ZONE item.timezone)
    OR item.cutoff_local_date NOT BETWEEN item.starts_on AND item.ends_on THEN
    RAISE EXCEPTION 'Standings cutoff must be competition-local day start within its season' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM sports.standings_rows WHERE snapshot_id = snapshot AND position > item.expected_clubs) THEN
    RAISE EXCEPTION 'Standing rank exceeds competition size' USING ERRCODE = '23514';
  END IF;
  IF item.complete AND (
    (SELECT count(*) FROM sports.standings_rows WHERE snapshot_id = snapshot) <> item.expected_clubs
    OR (SELECT count(*) FROM sports.season_clubs WHERE season_id = item.season_id) <> item.expected_clubs
  ) THEN
    RAISE EXCEPTION 'Complete standings require every expected club' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION sports.validate_standings_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE snapshot uuid;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Standings context writes require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lsp:standings-context', 0));
  IF TG_TABLE_NAME = 'standings_rows' THEN
    IF TG_OP <> 'DELETE' THEN PERFORM sports.assert_standings_snapshot(NEW.snapshot_id); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM sports.assert_standings_snapshot(OLD.snapshot_id); END IF;
  ELSIF TG_TABLE_NAME = 'standings_snapshots' THEN
    PERFORM sports.assert_standings_snapshot(NEW.id);
  ELSIF TG_TABLE_NAME = 'season_clubs' THEN
    FOR snapshot IN
      SELECT id FROM sports.standings_snapshots
      WHERE (TG_OP <> 'DELETE' AND season_id = NEW.season_id)
         OR (TG_OP <> 'INSERT' AND season_id = OLD.season_id)
    LOOP
      PERFORM sports.assert_standings_snapshot(snapshot);
    END LOOP;
  ELSE
    FOR snapshot IN
      SELECT ss.id FROM sports.standings_snapshots ss
      JOIN sports.competition_seasons cs ON cs.id = ss.season_id
      WHERE (TG_TABLE_NAME = 'competition_seasons' AND cs.id = NEW.id)
         OR (TG_TABLE_NAME = 'competitions' AND cs.competition_id = NEW.id)
    LOOP
      PERFORM sports.assert_standings_snapshot(snapshot);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER standings_snapshot_context_check
AFTER INSERT OR UPDATE ON sports.standings_snapshots DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_standings_context();
CREATE CONSTRAINT TRIGGER standings_row_context_check
AFTER INSERT OR UPDATE OR DELETE ON sports.standings_rows DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_standings_context();
CREATE CONSTRAINT TRIGGER season_standings_context_check
AFTER UPDATE ON sports.competition_seasons DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_standings_context();
CREATE CONSTRAINT TRIGGER competition_standings_context_check
AFTER UPDATE ON sports.competitions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_standings_context();

CREATE FUNCTION sports.lock_season_club_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Standings context writes require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  -- Take the same lock before a club-registration write, including when there
  -- are no snapshots yet, so a concurrent complete snapshot cannot miss it.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lsp:standings-context', 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER season_club_context_lock
BEFORE INSERT OR UPDATE OR DELETE ON sports.season_clubs
FOR EACH ROW EXECUTE FUNCTION sports.lock_season_club_context();
CREATE CONSTRAINT TRIGGER season_club_standings_context_check
AFTER INSERT OR UPDATE OR DELETE ON sports.season_clubs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sports.validate_standings_context();
