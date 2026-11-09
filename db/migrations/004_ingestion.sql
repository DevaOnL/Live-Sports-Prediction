-- Durable cross-store reconciliation and the shared provider request budget.
DO $$
DECLARE previous_name text;
BEGIN
  SELECT conname INTO STRICT previous_name FROM pg_catalog.pg_constraint
    WHERE conrelid = 'sports.source_revisions'::regclass AND contype = 'u'
      AND pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (provider, action, resource_key, content_sha256)';
  EXECUTE pg_catalog.format('ALTER TABLE sports.source_revisions DROP CONSTRAINT %I', previous_name);
END;
$$;
ALTER TABLE sports.source_revisions ADD CONSTRAINT source_revisions_observation_unique
  UNIQUE (provider, action, resource_key, content_sha256, retrieved_at);

CREATE TABLE sports.ingestion_batches (
  archive_id text PRIMARY KEY CHECK (archive_id ~ '^[0-9a-f]{64}$'),
  source_revision_id uuid NOT NULL REFERENCES sports.source_revisions(id),
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  fixture_count integer NOT NULL CHECK (fixture_count >= 0),
  appearance_count integer NOT NULL CHECK (appearance_count >= 0),
  issues_json jsonb NOT NULL CHECK (jsonb_typeof(issues_json) = 'array'),
  committed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sports.provider_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('get_teams', 'get_events', 'get_statistics', 'get_standings')),
  resource_key text NOT NULL CHECK (btrim(resource_key) <> ''),
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_request_time_idx ON sports.provider_requests(attempted_at);

REVOKE ALL ON sports.ingestion_batches, sports.provider_requests FROM PUBLIC;
GRANT SELECT, INSERT ON sports.ingestion_batches, sports.provider_requests TO lsp_writer;
