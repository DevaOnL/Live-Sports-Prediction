import type { Db } from "mongodb";
import { archiveId, validateArchive } from "./archive";
import { SORARE_QUERIES, type SorareBundle } from "./sorare-client";
import { normalizeSorareCapture } from "./sorare-normalize";
import { CURRENT_SOURCE } from "./sources";
import type { ArchivedResponse, Coverage } from "./types";

export type SorareNameAlias = { name: string; archiveId: string; contentSha256: string; retrievedAt: string };
type StoredArchive = Omit<ArchivedResponse, "id"> & { _id: string };
type LatestRoster = { _id: string; value: StoredArchive; count: number };
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

/** Read explicit source labels only after validating the entire captured roster. */
export function extractSorareNameAliases(archive: ArchivedResponse, coverage: Coverage): Map<string, SorareNameAlias[]> {
  validateArchive(archive);
  if (archiveId(archive) !== archive.id || archive.action !== "get_teams") throw new Error("Sorare alias archive identity mismatch");
  const batch = normalizeSorareCapture(archive, coverage);
  if (!batch.roster?.complete || batch.issues.length) throw new Error("Sorare alias roster is incomplete or invalid");
  const known = new Set(batch.roster.entries.map((entry) => entry.playerId));
  const aliases = new Map<string, SorareNameAlias[]>();
  const bundle: SorareBundle = JSON.parse(archive.text);
  for (const capture of bundle.captures) {
    // Old roster queries did not request these fields. Never reinterpret their
    // immutable responses or a player's slug as explicit alias observations.
    if (capture.query !== SORARE_QUERIES.players) continue;
    const payload: unknown = JSON.parse(capture.text);
    const football = object(payload) && object(payload.data) && object(payload.data.football) ? payload.data.football : null;
    const club = football && object(football.club) ? football.club : null;
    const connection = club && object(club.activePlayers) ? club.activePlayers : null;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error("Sorare alias roster evidence is invalid");
    for (const player of connection.nodes) {
      if (!object(player) || typeof player.id !== "string" || !known.has(player.id)) throw new Error("Sorare alias player identity mismatch");
      const labels = [player.matchName, player.abbreviatedName,
        name(player.firstName) && name(player.lastName) ? `${player.firstName.trim()} ${player.lastName.trim()}` : null];
      const entries = aliases.get(player.id) ?? [];
      for (const label of labels) if (name(label) && !entries.some((entry) => entry.name === label.trim())) {
        entries.push({ name: label.trim(), archiveId: archive.id, contentSha256: archive.contentSha256, retrievedAt: capture.retrievedAt });
      }
      if (entries.length) aliases.set(player.id, entries);
    }
  }
  return aliases;
}

/** At most one latest accepted roster per approved league; tied observations fail closed. */
export async function loadSorareNameAliases(db: Db): Promise<Map<string, SorareNameAlias[]>> {
  const latest = await db.collection<StoredArchive>("raw_archives").aggregate<LatestRoster>([
    { $match: { action: "get_teams", "params.provider": "sorare",
      "params.league_id": { $in: CURRENT_SOURCE.coverage.map((coverage) => coverage.id) } } },
    { $lookup: { from: "import_metadata", localField: "_id", foreignField: "_id", as: "metadata" } },
    { $match: { "metadata.state": "imported" } },
    { $setWindowFields: { partitionBy: "$params.league_id", sortBy: { retrievedAt: -1 },
      output: { observationRank: { $denseRank: {} } } } },
    { $match: { observationRank: 1 } },
    { $unset: ["metadata", "observationRank"] },
    { $group: { _id: "$params.league_id", value: { $first: "$$ROOT" }, count: { $sum: 1 } } },
    { $limit: CURRENT_SOURCE.coverage.length },
  ]).toArray();
  const aliases = new Map<string, SorareNameAlias[]>();
  const seenLeagues = new Set<string>();
  for (const candidate of latest) {
    const coverage = CURRENT_SOURCE.coverage.find((item) => item.id === candidate._id);
    if (!coverage || seenLeagues.has(candidate._id) || candidate.value.params.league_id !== coverage.id
      || !Number.isSafeInteger(candidate.count) || candidate.count < 1) throw new Error("Sorare alias roster scope is invalid");
    seenLeagues.add(candidate._id);
    if (candidate.count !== 1) continue;
    const { _id, ...value } = candidate.value;
    for (const [playerId, entries] of extractSorareNameAliases({ ...value, id: _id }, coverage)) {
      const previous = aliases.get(playerId) ?? [];
      aliases.set(playerId, [...previous, ...entries]);
    }
  }
  return aliases;
}
