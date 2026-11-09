import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Collection, Db } from "mongodb";

type Annotation = {
  _id: string;
  runId: string;
  synthetic: boolean;
  playerId: string;
  playerName: string;
  club: string;
  position: "FWD" | "MID" | "DEF" | "GK";
  status: "draft" | "reviewed";
  tags: string[];
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

type TagCount = { tag: string; annotationCount: number; reviewedCount: number };

/** Demonstrate mutable annotations without changing authoritative source archives. */
export async function runMongoExamples(db: Db): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_]{0,57}_(?:demo|test)$/.test(db.databaseName)) {
    throw new Error("MongoDB examples require a database ending _demo or _test.");
  }

  const runId = randomBytes(16).toString("hex");
  const name = `demo_annotations_${runId}`;
  if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) {
    throw new Error("Generated demo collection already exists; refusing to reuse it.");
  }

  // Count only: source payloads and import metadata are never read or mutated.
  const rawCountBefore = await db.collection("raw_archives").countDocuments();
  const report: Record<string, unknown> = { database: db.databaseName, collection: name };
  let owned: Collection<Annotation> | undefined;
  let ownedUuid: string | undefined;
  try {
    owned = await db.createCollection<Annotation>(name, {
      validationLevel: "strict",
      validationAction: "error",
      validator: { $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "runId", "synthetic", "playerId", "playerName", "club", "position", "status", "tags", "note", "createdAt", "updatedAt"],
        properties: {
          _id: { bsonType: "string", pattern: "^annotation-[a-z]+$" },
          runId: { enum: [runId] },
          synthetic: { enum: [true] },
          playerId: { bsonType: "string", pattern: "^demo-player-[a-z]+$" },
          playerName: { bsonType: "string", minLength: 1, maxLength: 80 },
          club: { bsonType: "string", minLength: 1, maxLength: 80 },
          position: { enum: ["FWD", "MID", "DEF", "GK"] },
          status: { enum: ["draft", "reviewed"] },
          tags: {
            bsonType: "array", minItems: 1, uniqueItems: true,
            items: { enum: ["watchlist", "form", "set-pieces", "minutes", "discard", "reviewed"] },
          },
          note: { bsonType: "string", minLength: 1, maxLength: 240 },
          createdAt: { bsonType: "date" },
          updatedAt: { bsonType: "date" },
        },
      } },
    });
    const metadata = await db.listCollections({ name }, { nameOnly: false }).next();
    assert(metadata?.info?.uuid, "A newly created collection must have a UUID");
    ownedUuid = metadata.info.uuid.toString("hex");
    assert.equal(metadata.options?.validationLevel, "strict");
    assert.equal(metadata.options?.validationAction, "error");

    const filterIndex = "demo_status_position";
    await owned.createIndex({ runId: 1, playerId: 1 }, { name: "demo_player_unique", unique: true });
    await owned.createIndex({ runId: 1, status: 1, position: 1, playerId: 1 }, { name: filterIndex });
    const indexes = await owned.listIndexes().toArray();
    const uniqueIndex = indexes.find((index) => index.name === "demo_player_unique");
    assert(uniqueIndex);
    assert.equal(uniqueIndex.unique, true);
    assert.deepEqual(uniqueIndex.key, { runId: 1, playerId: 1 });
    assert.deepEqual(indexes.find((index) => index.name === filterIndex)?.key,
      { runId: 1, status: 1, position: 1, playerId: 1 });
    report.indexes = indexes.map((index) => ({ name: index.name, key: index.key, unique: index.name === "_id_" || index.unique === true }));

    const createdAt = new Date("2026-11-01T12:00:00Z");
    const seeds: Annotation[] = [
      { _id: "annotation-ada", runId, synthetic: true, playerId: "demo-player-ada", playerName: "Demo Ada", club: "Synthetic Athletic", position: "FWD", status: "draft", tags: ["watchlist", "form"], note: "Review the synthetic forward's form.", createdAt, updatedAt: createdAt },
      { _id: "annotation-bo", runId, synthetic: true, playerId: "demo-player-bo", playerName: "Demo Bo", club: "Synthetic United", position: "FWD", status: "reviewed", tags: ["watchlist", "set-pieces"], note: "Synthetic set-piece annotation checked.", createdAt, updatedAt: createdAt },
      { _id: "annotation-cy", runId, synthetic: true, playerId: "demo-player-cy", playerName: "Demo Cy", club: "Synthetic Athletic", position: "MID", status: "draft", tags: ["minutes", "form"], note: "Review synthetic playing-time context.", createdAt, updatedAt: createdAt },
      { _id: "annotation-discard", runId, synthetic: true, playerId: "demo-player-discard", playerName: "Demo Discard", club: "Synthetic United", position: "DEF", status: "draft", tags: ["discard"], note: "Disposable synthetic annotation.", createdAt, updatedAt: createdAt },
    ];
    const inserted = await owned.insertMany(seeds);
    assert.equal(inserted.insertedCount, 4);
    const seededCount = await owned.countDocuments({ runId, synthetic: true });
    assert.equal(seededCount, 4);

    let validationCode: number | undefined;
    try {
      await owned.insertOne({ ...seeds[0], _id: "annotation-invalid", playerId: "demo-player-invalid", synthetic: false });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 121)) throw error;
      validationCode = 121;
    }
    assert.equal(validationCode, 121, "Strict validation must reject a nonsynthetic annotation");
    const countAfterRejection = await owned.countDocuments();
    assert.equal(countAfterRejection, 4, "Rejected inserts must not change the collection");
    report.validation = { level: "strict", action: "error", rejectedCode: validationCode, countAfterRejection };

    const filter = { runId, synthetic: true, status: "draft" as const, position: "FWD" as const };
    const projection = { _id: 0, playerId: 1, playerName: 1, status: 1, tags: 1 };
    const read = await owned.find(filter, { projection, hint: filterIndex }).sort({ playerId: 1 }).toArray();
    assert.deepEqual(read, [{ playerId: "demo-player-ada", playerName: "Demo Ada", status: "draft", tags: ["watchlist", "form"] }]);
    report.read = { filter: { synthetic: true, status: "draft", position: "FWD" }, projection, indexHint: filterIndex, rows: read };

    const updatedAt = new Date("2026-11-02T12:00:00Z");
    const target = { _id: "annotation-ada", playerId: "demo-player-ada", runId, synthetic: true };
    const update = await owned.updateOne(target, {
      $set: { status: "reviewed", note: "Reviewed synthetic form annotation.", updatedAt },
      $addToSet: { tags: "reviewed" },
    });
    assert.equal(update.matchedCount, 1);
    assert.equal(update.modifiedCount, 1);
    const updated = await owned.findOne(target, { projection: { _id: 0, playerId: 1, status: 1, note: 1, tags: 1, updatedAt: 1 } });
    assert.deepEqual(updated, {
      playerId: "demo-player-ada", status: "reviewed", note: "Reviewed synthetic form annotation.",
      tags: ["watchlist", "form", "reviewed"], updatedAt,
    });
    const repeatedTag = await owned.updateOne(target, { $addToSet: { tags: "reviewed" } });
    assert.equal(repeatedTag.matchedCount, 1);
    assert.equal(repeatedTag.modifiedCount, 0, "$addToSet must not duplicate a tag");
    report.update = { matchedCount: update.matchedCount, modifiedCount: update.modifiedCount, repeatedTagModifiedCount: repeatedTag.modifiedCount, row: updated };

    const discarded = { _id: "annotation-discard", playerId: "demo-player-discard", runId, synthetic: true };
    const deletion = await owned.deleteOne(discarded);
    assert.equal(deletion.deletedCount, 1);
    assert.equal(await owned.findOne(discarded), null);
    const remainingCount = await owned.countDocuments({ runId, synthetic: true });
    const reviewedCount = await owned.countDocuments({ runId, synthetic: true, status: "reviewed" });
    const draftCount = await owned.countDocuments({ runId, synthetic: true, status: "draft" });
    assert.equal(remainingCount, 3);
    assert.equal(reviewedCount, 2);
    assert.equal(draftCount, 1);
    report.delete = { playerId: "demo-player-discard", deletedCount: deletion.deletedCount };
    report.counts = { seeded: seededCount, remaining: remainingCount, reviewed: reviewedCount, draft: draftCount };

    const pipeline = [
      { $match: { runId, synthetic: true } },
      { $unwind: "$tags" },
      { $group: {
        _id: "$tags", annotationCount: { $sum: 1 },
        reviewedCount: { $sum: { $cond: [{ $eq: ["$status", "reviewed"] }, 1, 0] } },
      } },
      { $project: { _id: 0, tag: "$_id", annotationCount: 1, reviewedCount: 1 } },
      { $sort: { annotationCount: -1, tag: 1 } },
    ];
    const tags = await owned.aggregate<TagCount>(pipeline).toArray();
    assert.deepEqual(tags, [
      { tag: "form", annotationCount: 2, reviewedCount: 1 },
      { tag: "watchlist", annotationCount: 2, reviewedCount: 2 },
      { tag: "minutes", annotationCount: 1, reviewedCount: 0 },
      { tag: "reviewed", annotationCount: 1, reviewedCount: 1 },
      { tag: "set-pieces", annotationCount: 1, reviewedCount: 1 },
    ]);
    const totalTagAssignments = tags.reduce((total, row) => total + row.annotationCount, 0);
    assert.equal(totalTagAssignments, 7);
    report.aggregation = { stages: ["$match", "$unwind", "$group", "$project", "$sort"], rows: tags, totalTagAssignments };
  } finally {
    if (owned) {
      const metadata = await db.listCollections({ name }, { nameOnly: false }).next();
      // A changed namespace is not ours to drop, even if its name matches.
      assert.equal(metadata?.options?.validator?.$jsonSchema?.properties?.runId?.enum?.[0], runId,
        "Refusing to drop a collection without the demo ownership marker");
      if (ownedUuid) assert.equal(metadata?.info?.uuid?.toString("hex"), ownedUuid,
        "Refusing to drop a replaced demo collection");
      assert.equal(await owned.drop(), true);
      assert.equal(await db.listCollections({ name }, { nameOnly: true }).hasNext(), false);
      report.cleanup = { collectionDropped: true };
    }
    const rawCountAfter = await db.collection("raw_archives").countDocuments();
    assert.equal(rawCountAfter, rawCountBefore, "Source archive count must remain unchanged");
    report.sourceArchives = { countBefore: rawCountBefore, countAfter: rawCountAfter, countUnchanged: true, access: "countDocuments only" };
  }
  return report;
}
