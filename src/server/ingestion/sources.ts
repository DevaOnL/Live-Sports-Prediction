import type { CompetitionCode } from "../forecast/types";
import { COVERAGE } from "./coverage";
import type { Coverage } from "./types";

export type SourceProfile = {
  provider: "apifootball" | "sorare";
  coverage: readonly Readonly<Coverage>[];
  coefficient: 1.5 | 2;
  competitionCodes: Readonly<Record<string, CompetitionCode>>;
};

/** Retained for reproducible archived imports, demonstrations and evaluations. */
export const LEGACY_SOURCE: Readonly<SourceProfile> = Object.freeze({
  provider: "apifootball", coverage: COVERAGE, coefficient: 1.5,
  competitionCodes: Object.freeze({ "153": "championship", "164": "ligue_2" }),
});

export const CURRENT_SOURCE: Readonly<SourceProfile> = Object.freeze({
  provider: "sorare", coefficient: 2,
  coverage: Object.freeze([
    Object.freeze({ id: "premier-league-gb-eng", name: "Premier League", country: "England", timezone: "Europe/London",
      season: "2026/27", startsOn: "2026-07-01", endsOn: "2027-06-30", expectedClubs: 20 }),
    Object.freeze({ id: "laliga-es", name: "La Liga", country: "Spain", timezone: "Europe/Madrid",
      season: "2026/27", startsOn: "2026-07-01", endsOn: "2027-06-30", expectedClubs: 20 }),
  ]),
  competitionCodes: Object.freeze({ "premier-league-gb-eng": "premier_league", "laliga-es": "la_liga" }),
});

export function sourceCoverage(profile: SourceProfile, id: string): Readonly<Coverage> {
  const coverage = profile.coverage.find((candidate) => candidate.id === id);
  if (!coverage) throw new Error("Unsupported competition");
  return coverage;
}

/** Native identifiers remain unmodified; JSON tuple boundaries prevent collisions. */
export function sourceEntityKey(profile: SourceProfile, entityType: string, ...parts: string[]): string {
  return profile.provider === "apifootball" ? parts.join(":") : `sorare:${entityType}:${JSON.stringify(parts)}`;
}

/** An internal SQL predicate; request values never become table aliases. */
export function sourceSeasonGuard(profile: SourceProfile, seasonAlias = "cs", competitionAlias = "c"): string {
  if (![seasonAlias, competitionAlias].every((alias) => /^[a-z_][a-z0-9_]*$/i.test(alias))) {
    throw new Error("Invalid internal SQL alias");
  }
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const seasons = profile.coverage.map((coverage) => `(${competitionAlias}.provider_id=${literal(coverage.id)}
    AND ${seasonAlias}.label=${literal(coverage.season)}
    AND ${seasonAlias}.starts_on=DATE ${literal(coverage.startsOn)} AND ${seasonAlias}.ends_on=DATE ${literal(coverage.endsOn)}
    AND ${seasonAlias}.expected_clubs=${coverage.expectedClubs} AND ${competitionAlias}.timezone=${literal(coverage.timezone)})`);
  return `(${competitionAlias}.provider=${literal(profile.provider)} AND ${competitionAlias}.enabled AND ${seasonAlias}.enabled
    AND ${competitionAlias}.coefficient=${profile.coefficient} AND (${seasons.join(" OR ") || "FALSE"}))`;
}

/** Test fixtures may select archived coverage only inside an explicitly named test database. */
export function runtimeSource(): Readonly<SourceProfile> {
  return process.env.LSP_TEST_SOURCE === "legacy" && /^[a-z][a-z0-9_]{0,57}_test$/.test(process.env.POSTGRES_DB ?? "")
    ? LEGACY_SOURCE : CURRENT_SOURCE;
}
