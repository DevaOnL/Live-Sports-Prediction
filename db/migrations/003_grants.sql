-- No application login inherits the migration owner's privileges.
REVOKE ALL ON SCHEMA sports, auth, infra FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sports, auth, infra FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA sports, auth, infra FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE lsp_migrator IN SCHEMA sports, auth, infra
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE lsp_migrator IN SCHEMA sports, auth, infra
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA sports TO lsp_reader, lsp_writer;
GRANT SELECT ON sports.competitions, sports.competition_seasons, sports.clubs,
    sports.season_clubs, sports.players, sports.player_memberships,
    sports.fixtures, sports.appearances, sports.standings_snapshots,
    sports.standings_rows, sports.points_adjustments,
    sports.source_revisions, sports.normalized_revisions TO lsp_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA sports TO lsp_writer;
GRANT INSERT, UPDATE, DELETE ON sports.competitions, sports.competition_seasons,
    sports.clubs, sports.season_clubs, sports.players, sports.player_memberships,
    sports.fixtures, sports.appearances TO lsp_writer;
-- Corrections append provenance and snapshots; the runtime cannot rewrite them.
GRANT INSERT ON sports.source_revisions, sports.normalized_revisions,
    sports.standings_snapshots, sports.standings_rows, sports.points_adjustments,
    sports.audit_log TO lsp_writer;
GRANT INSERT ON sports.outbox, sports.jobs TO lsp_writer;
GRANT UPDATE (published_at) ON sports.outbox TO lsp_writer;
GRANT UPDATE (status, attempts, max_attempts, run_after, locked_by, locked_until,
    last_error, completed_at) ON sports.jobs TO lsp_writer;
GRANT EXECUTE ON FUNCTION sports.assert_standings_snapshot(uuid) TO lsp_writer;

GRANT USAGE ON SCHEMA auth TO lsp_auth;
GRANT SELECT ON auth."user" TO lsp_auth;
-- Role is server-managed: ordinary auth storage cannot insert/update role values.
GRANT INSERT (id, name, email, "emailVerified", image, "createdAt", "updatedAt"),
    UPDATE (name, email, "emailVerified", image, "updatedAt") ON auth."user" TO lsp_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session, auth.account,
    auth.verification TO lsp_auth;
