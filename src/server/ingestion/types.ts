export type ProviderAction = "get_teams" | "get_events" | "get_statistics" | "get_standings";
export type Coverage = {
  id: string; name: string; country: string; timezone: string; season: string;
  startsOn: string; endsOn: string; expectedClubs: number;
};
export type Issue = { code: string; resource: string; field?: string };
export type Club = { id: string; name: string };
export type Player = { id: string; name: string; position: "GK" | "DEF" | "MID" | "FWD" | "UNKNOWN"; clubId?: string };
export type Appearance = {
  player: Player; clubId: string; participation: "unknown" | "played" | "dnp";
  minutes: number | null; rating: number | null; goals: number | null;
  assists: number | null; shotsOnTarget: number | null; keyPasses: number | null;
  tackles: number | null; interceptions: number | null; saves: number | null;
  goalsConceded: number | null;
};
export type Fixture = {
  id: string; leagueId: string; season: string; home: Club; away: Club;
  kickoffAt: string | null; status: "unknown" | "scheduled" | "live" | "final" | "postponed" | "cancelled";
  statisticsStatus: "unknown" | "missing" | "partial" | "complete";
  homeScore: number | null; awayScore: number | null;
  detailed: boolean; appearances: Appearance[];
};
export type ProviderStanding = {
  clubId: string; played: number; wins: number; draws: number; losses: number;
  goalsFor: number; goalsAgainst: number; points: number;
};
export type Batch = {
  coverage: Coverage; clubs: Club[]; players: Player[]; fixtures: Fixture[];
  standings: ProviderStanding[]; issues: Issue[];
  roster?: { complete: boolean; entries: { playerId: string; clubId: string }[] };
};
export type ProviderResponse = {
  action: ProviderAction; resourceKey: string; params: Record<string, string>;
  retrievedAt: string; text: string; contentSha256: string;
};
export type ArchivedResponse = ProviderResponse & { id: string };
export type ImportResult = {
  archiveId: string; duplicate: boolean; fixtures: number; appearances: number; issues: number;
};
