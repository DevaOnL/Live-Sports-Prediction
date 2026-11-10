import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { LEGACY_SOURCE, type SourceProfile } from "./sources";
import type { ArchivedResponse, ImportResult, Issue, ProviderResponse } from "./types";

type RawArchive = ProviderResponse & { _id: string };
type ImportMetadata = {
  _id: string;
  state: "pending" | "imported" | "invalid" | "failed";
  issues: Issue[];
  result?: ImportResult;
  updatedAt: Date;
};

export function archiveId(response: ProviderResponse): string {
  return createHash("sha256")
    .update(JSON.stringify([response.action, response.resourceKey, response.contentSha256, response.retrievedAt]))
    .digest("hex");
}

export function validateArchive(response: ProviderResponse): void {
  const digest = createHash("sha256").update(response.text, "utf8").digest("hex");
  if (digest !== response.contentSha256) throw new Error("Archive content hash mismatch");
  if (!Number.isFinite(Date.parse(response.retrievedAt))) throw new Error("Invalid archive retrieval time");
  if (!response.resourceKey.trim()) throw new Error("Missing archive resource key");
  if (Object.keys(response.params).some((key) => /key|token|secret|password|authorization/i.test(key))) {
    throw new Error("Secret parameters cannot be archived");
  }
}

function archived(document: RawArchive): ArchivedResponse {
  const { _id, ...response } = document;
  return { ...response, id: _id };
}

export class ArchiveStore {
  private readonly raw: Collection<RawArchive>;
  private readonly metadata: Collection<ImportMetadata>;

  constructor(db: Db) {
    this.raw = db.collection<RawArchive>("raw_archives");
    this.metadata = db.collection<ImportMetadata>("import_metadata");
  }

  async save(response: ProviderResponse): Promise<ArchivedResponse> {
    validateArchive(response);
    const id = archiveId(response);
    try {
      // Insert only: the runtime identity cannot rewrite or delete authoritative bytes.
      await this.raw.insertOne({ _id: id, ...response });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) {
        throw error;
      }
    }
    const document = await this.get(id);
    if (!document || document.text !== response.text) throw new Error("Archive integrity check failed");
    await this.metadata.updateOne({ _id: id }, {
      $setOnInsert: { state: "pending", issues: [], updatedAt: new Date() },
    }, { upsert: true });
    return document;
  }

  async get(id: string): Promise<ArchivedResponse | null> {
    const document = await this.raw.findOne({ _id: id });
    if (!document) return null;
    validateArchive(document);
    if (archiveId(document) !== id) throw new Error("Archive identity mismatch");
    return archived(document);
  }

  async pending(limit = 50, provider?: "sorare" | "apifootball"): Promise<ArchivedResponse[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid archive batch limit");
    const documents = await this.raw.aggregate<RawArchive>([
      ...(provider === "sorare" ? [{ $match: { "params.provider": "sorare" } }]
        : provider === "apifootball" ? [{ $match: { $or: [{ "params.provider": "apifootball" }, { "params.provider": { $exists: false } }] } }] : []),
      { $sort: { retrievedAt: 1, _id: 1 } },
      { $lookup: { from: "import_metadata", localField: "_id", foreignField: "_id", as: "metadata" } },
      { $match: { "metadata.state": { $nin: ["imported", "invalid"] } } },
      { $limit: limit },
      { $unset: "metadata" },
    ]).toArray();
    const result: ArchivedResponse[] = [];
    for (const document of documents) {
      validateArchive(document);
      if (archiveId(document) !== document._id) throw new Error("Archive identity mismatch");
      // Recover a crash between the immutable insert and initial metadata insert.
      await this.metadata.updateOne({ _id: document._id }, {
        $setOnInsert: { state: "pending", issues: [], updatedAt: new Date() },
      }, { upsert: true });
      result.push(archived(document));
    }
    return result;
  }

  /** Retain every latest-time observation so offline upgrades preserve ambiguity. */
  async latestRosters(profile: SourceProfile = LEGACY_SOURCE): Promise<ArchivedResponse[]> {
    const documents = await this.raw.aggregate<RawArchive>([
      { $match: { action: "get_teams", "params.league_id": { $in: profile.coverage.map((coverage) => coverage.id) },
        ...(profile.provider === "sorare" ? { "params.provider": "sorare" } : { $or: [{ "params.provider": "apifootball" }, { "params.provider": { $exists: false } }] }) } },
      { $lookup: { from: "import_metadata", localField: "_id", foreignField: "_id", as: "metadata" } },
      { $match: { "metadata.state": "imported" } },
      { $setWindowFields: {
        partitionBy: "$params.league_id", sortBy: { retrievedAt: -1 },
        output: { observationRank: { $denseRank: {} } },
      } },
      { $match: { observationRank: 1 } },
      { $unset: ["metadata", "observationRank"] },
      { $sort: { "params.league_id": 1, _id: 1 } },
    ]).toArray();
    return documents.map((document) => {
      validateArchive(document);
      if (archiveId(document) !== document._id) throw new Error("Archive identity mismatch");
      return archived(document);
    });
  }

  async mark(id: string, state: "imported" | "invalid" | "failed", issues: Issue[], result?: ImportResult): Promise<void> {
    if (!(await this.raw.findOne({ _id: id }, { projection: { _id: 1 } }))) throw new Error("Archive does not exist");
    if (state === "imported" && (!result || result.archiveId !== id)) throw new Error("Missing committed import result");
    await this.metadata.updateOne({ _id: id }, {
      $set: { state, issues, updatedAt: new Date(), ...(result ? { result } : {}) },
      ...(!result ? { $unset: { result: "" } } : {}),
    }, { upsert: true });
  }
}
