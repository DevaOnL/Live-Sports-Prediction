import { mongoConnection, mongoDatabase, required } from "../src/server/ingestion/connections";

async function provision() {
  const password = required("MONGO_WORKER_PASSWORD");
  if (password.length < 16 || password === required("MONGO_BOOTSTRAP_PASSWORD")) throw new Error("Use independent MongoDB passwords of at least 16 characters");
  const username = process.env.MONGO_WORKER_USER ?? "lsp_ingestion";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(username)) throw new Error("Invalid MONGO_WORKER_USER");
  const client = mongoConnection(true);
  try {
    await client.connect();
    const db = client.db(mongoDatabase());
    const validators = {
      raw_archives: { $jsonSchema: {
        bsonType: "object", required: ["_id", "action", "resourceKey", "params", "retrievedAt", "text", "contentSha256"], additionalProperties: false,
        properties: {
          _id: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
          action: { enum: ["get_teams", "get_events", "get_statistics", "get_standings"] },
          resourceKey: { bsonType: "string", minLength: 1 }, params: { bsonType: "object" },
          retrievedAt: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" }, text: { bsonType: "string" },
          contentSha256: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
        },
      } },
      import_metadata: { $jsonSchema: {
        bsonType: "object", required: ["_id", "state", "issues", "updatedAt"], additionalProperties: false,
        properties: {
          _id: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
          state: { enum: ["pending", "imported", "invalid", "failed"] },
          issues: { bsonType: "array", items: { bsonType: "object" } }, updatedAt: { bsonType: "date" }, result: { bsonType: "object" },
        },
      } },
    };
    for (const [name, validator] of Object.entries(validators)) {
      if ((await db.listCollections({ name }).toArray()).length) await db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
      else await db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
    }
    await db.collection("raw_archives").createIndex({ action: 1, resourceKey: 1, retrievedAt: 1 });
    await db.collection("raw_archives").createIndex({ retrievedAt: 1, _id: 1 });
    await db.collection("raw_archives").createIndex({ "params.match_id": 1, retrievedAt: -1 });
    await db.collection("import_metadata").createIndex({ state: 1, updatedAt: 1 });
    const role = "ingestion_archive";
    const privileges = [
      { resource: { db: db.databaseName, collection: "raw_archives" }, actions: ["find", "insert"] },
      { resource: { db: db.databaseName, collection: "import_metadata" }, actions: ["find", "insert", "update"] },
    ];
    if ((await db.command({ rolesInfo: role })).roles.length) await db.command({ updateRole: role, privileges, roles: [] });
    else await db.command({ createRole: role, privileges, roles: [] });
    const roles = [{ role, db: db.databaseName }];
    if ((await db.command({ usersInfo: username })).users.length) await db.command({ updateUser: username, pwd: password, roles });
    else await db.command({ createUser: username, pwd: password, roles });
    console.info("MongoDB archive collections, indexes, validators, and restricted worker login are ready.");
  } finally { await client.close(); }
}

provision().catch(() => { console.error("MongoDB provisioning failed; check local configuration and administrator access."); process.exitCode = 1; });
