-- Current evaluations retain freshness independently of immutable model changes.
ALTER TABLE sports.forecast_heads
  ADD COLUMN evaluation_cutoff_at timestamptz,
  ADD COLUMN evaluation_source_ordinal bigint CHECK (evaluation_source_ordinal >= 0),
  ADD COLUMN evaluation_provenance_json jsonb CHECK (jsonb_typeof(evaluation_provenance_json) = 'object'),
  ADD COLUMN checked_at timestamptz;

UPDATE sports.forecast_heads h SET
  evaluation_cutoff_at=r.cutoff_at,
  evaluation_source_ordinal=r.source_ordinal,
  evaluation_provenance_json=r.provenance_json,
  checked_at=r.created_at
FROM sports.forecast_revisions r WHERE r.id=h.revision_id;

ALTER TABLE sports.forecast_heads
  ALTER COLUMN evaluation_cutoff_at SET NOT NULL,
  ALTER COLUMN evaluation_source_ordinal SET NOT NULL,
  ALTER COLUMN evaluation_provenance_json SET NOT NULL,
  ALTER COLUMN checked_at SET NOT NULL;

GRANT INSERT (evaluation_cutoff_at,evaluation_source_ordinal,evaluation_provenance_json,checked_at),
  UPDATE (evaluation_cutoff_at,evaluation_source_ordinal,evaluation_provenance_json,checked_at)
  ON sports.forecast_heads TO lsp_writer;
