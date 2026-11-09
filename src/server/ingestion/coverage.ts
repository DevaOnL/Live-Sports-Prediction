import type { Coverage } from "./types";

// Permanent free-plan coverage verified for this project. Expansion is explicit.
export const COVERAGE: readonly Readonly<Coverage>[] = Object.freeze([
  Object.freeze({
    id: "153", name: "Championship", country: "England", timezone: "Europe/London",
    season: "2026/27", startsOn: "2026-07-01", endsOn: "2027-06-30", expectedClubs: 24,
  }),
  Object.freeze({
    id: "164", name: "Ligue 2", country: "France", timezone: "Europe/Paris",
    season: "2026/27", startsOn: "2026-07-01", endsOn: "2027-06-30", expectedClubs: 18,
  }),
]);

export function coverageFor(id: string): Readonly<Coverage> {
  const coverage = COVERAGE.find((candidate) => candidate.id === id);
  if (!coverage) throw new Error("Unsupported competition");
  return coverage;
}
