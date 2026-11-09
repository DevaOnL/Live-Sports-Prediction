-- Roster observations retain current-club evidence without inventing transfer dates.
CREATE TABLE sports.roster_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES sports.competition_seasons(id),
  source_revision_id uuid NOT NULL UNIQUE REFERENCES sports.source_revisions(id),
  observed_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  normalized_revision_id uuid REFERENCES sports.normalized_revisions(id),
  UNIQUE (id, season_id)
);

CREATE TABLE sports.roster_entries (
  snapshot_id uuid NOT NULL,
  season_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES sports.players(id),
  club_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, player_id, club_id),
  FOREIGN KEY (snapshot_id, season_id) REFERENCES sports.roster_snapshots(id, season_id),
  FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id)
);

CREATE INDEX roster_season_observed_idx
  ON sports.roster_snapshots(season_id, observed_at DESC, id DESC);
CREATE INDEX roster_player_snapshot_idx ON sports.roster_entries(player_id, snapshot_id);
CREATE INDEX roster_season_club_idx ON sports.roster_entries(season_id, club_id);

REVOKE ALL ON sports.roster_snapshots, sports.roster_entries FROM PUBLIC;
GRANT SELECT ON sports.roster_snapshots, sports.roster_entries TO lsp_reader;
-- Runtime corrections append a new observation and never rewrite an old roster.
GRANT SELECT, INSERT ON sports.roster_snapshots, sports.roster_entries TO lsp_writer;
