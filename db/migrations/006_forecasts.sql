-- Immutable explanations and a separately mutable pointer to each current result.
CREATE TABLE sports.forecast_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  player_id uuid NOT NULL REFERENCES sports.players(id),
  parent_id uuid,
  model_version text NOT NULL CHECK (btrim(model_version) <> ''),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  source_ordinal bigint NOT NULL CHECK (source_ordinal >= 0),
  cutoff_at timestamptz NOT NULL,
  input_json jsonb NOT NULL CHECK (jsonb_typeof(input_json) = 'object'),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, player_id),
  FOREIGN KEY (parent_id, player_id) REFERENCES sports.forecast_revisions(id, player_id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX forecast_player_history_idx ON sports.forecast_revisions(player_id, ordinal DESC);
CREATE INDEX forecast_parent_idx ON sports.forecast_revisions(parent_id);

CREATE TABLE sports.forecast_heads (
  player_id uuid PRIMARY KEY REFERENCES sports.players(id),
  revision_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id, player_id) REFERENCES sports.forecast_revisions(id, player_id)
);

CREATE FUNCTION sports.validate_forecast_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, sports AS $$
DECLARE parent_ordinal bigint;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT ordinal INTO parent_ordinal FROM sports.forecast_revisions WHERE id=NEW.parent_id;
    IF parent_ordinal IS NULL OR parent_ordinal >= NEW.ordinal THEN
      RAISE EXCEPTION 'Forecast parent must precede its child' USING ERRCODE='23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM sports.forecast_revisions WHERE parent_id=NEW.id AND ordinal <= NEW.ordinal) THEN
    RAISE EXCEPTION 'Forecast order would invalidate a child' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER forecast_revision_chain_check
BEFORE INSERT OR UPDATE ON sports.forecast_revisions
FOR EACH ROW EXECUTE FUNCTION sports.validate_forecast_chain();

REVOKE ALL ON sports.forecast_revisions, sports.forecast_heads FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sports.validate_forecast_chain() FROM PUBLIC;
GRANT SELECT ON sports.forecast_revisions, sports.forecast_heads TO lsp_reader, lsp_writer;
GRANT INSERT ON sports.forecast_revisions TO lsp_writer;
GRANT INSERT (player_id,revision_id,updated_at), UPDATE (revision_id,updated_at)
  ON sports.forecast_heads TO lsp_writer;
