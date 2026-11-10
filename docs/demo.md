# Database demonstrations

Use Node.js 24, npm 11 and a Linux Docker engine compatible with PostgreSQL 17
and MongoDB 8. The image tags are `postgres:17-alpine` and `mongo:8`; pulling them
needs network access when absent locally. No provider account, API key, running
Compose stack or `.env` file is required.

```bash
npm ci
npm run demo
```

The command creates two fresh containers with temporary in-memory filesystems,
automatically assigned loopback ports and independent random credentials. It
verifies container ownership, server versions and database identities before
provisioning or migrating. It prints a JSON report labeled `synthetic` and exits
nonzero if an assertion fails. The report contains query results, not credentials
or archived source payloads. On completion or a handled interrupt it closes its
connections and removes only its own identified containers. No named volume or
existing application database is used. An uncatchable process/host failure may
leave containers named `lsp-demo-pg-*` or `lsp-demo-mongo-*`; inspect their
`live-sports-demonstration` labels and creation times before removing those exact
containers. Never delete application volumes as demonstration cleanup.

Each run seeds a new empty database through the same archive-first ingestion and
forecast code used by the worker, using source-shaped synthetic responses and no
provider requests. The data contains 24 clubs, 552 fixtures, four positional
players, five qualifying appearances each, one 59-minute appearance, and one DNP.
The fixed cutoff is `2026-08-10T12:00:00Z`. Valid zero and missing metrics remain
distinct; minutes include 60 and 97. A goalkeeper correction from A to B and back
to A produces three distinct revisions, for six revisions across four players.
The synthetic complete schedule and roster evidence make model prerequisites
explicit. These results demonstrate database behavior, not predictive accuracy
or live provider coverage.

## Executable examples

The runner executes these files automatically and checks their outcomes:

| Source | Operation and expected result |
| --- | --- |
| [`dml.sql`](../db/demo/sql/dml.sql) | INSERT, UPDATE and DELETE of one separate synthetic player, each with one RETURNING row; the transaction rolls back |
| [`queries.sql`](../db/demo/sql/queries.sql) | Club/player JOIN, nested query, correlated appearance count, CTE/window selection of five qualifying matches, explicit recursive revision ancestry; each returns rows |
| [`advanced.sql`](../db/demo/sql/advanced.sql) | History and lineage functions, duplicate refresh request, audit/outbox evidence, rejected foreign-key write; all transactional changes roll back |
| [`operations.ts`](../db/demo/mongo/operations.ts) | Validated indexed document read/projection, update with tag deduplication, scoped deletion and tag aggregation on separate synthetic annotations |
| [`seed.ts`](../db/demo/seed.ts) | Offline ingestion, historical standings and forecast prerequisites |
| [`demo.ts`](../scripts/demo.ts) | Isolation guards, orchestration and assertions |

SQL queries run through the restricted reader; DML/procedure examples use the
writer. The runner fingerprints all sports tables to verify rollback, checks
one manual request for a repeated UUID, denies reader refresh requests, consumes
a local refresh, and proves output notifications do not enqueue another refresh.
It verifies six audit/notification pairs and zero provider request reservations.

MongoDB examples create a random owned `demo_annotations_*` collection. Validation
rejects nonsynthetic records; the update affects one document and repeating its
tag does not modify it. Deleting one disposable annotation leaves three records
(two reviewed and one draft). Aggregation returns five tags with seven total
assignments. Cleanup verifies the ownership marker and collection UUID before
dropping that collection. Authoritative archive documents remain unchanged, with
the runner checking their full-content fingerprint before and after. This mutable
annotation collection is demonstration data, separate from the immutable archives.

The SQL files expect this seeded dataset and fixed cutoff. They are not setup or
reset scripts for application databases. Rerun `npm run demo` for a fresh safe
execution; the command manages the seed and cleanup itself.

## Reusable database routines

Apply pending migrations with `npm run db:migrate` before using these routines in
the local application database. They use invoker permissions and fixed search
paths; execution is revoked from PUBLIC.

| Routine | Behavior | Role |
| --- | --- | --- |
| `sports.player_qualifying_history(player_id text, cutoff timestamptz)` | Latest five finalized, known-member appearances with at least 60 minutes before a finite cutoff, returned chronologically with nullable metrics and normalized revision IDs; exact enabled coverage guards apply | reader, writer |
| `sports.forecast_lineage(player_id text, max_rows integer DEFAULT 50)` | Current head followed recursively through same-player parents; accepts 1–1000 rows and returns depth and immutable evidence metadata | reader, writer |
| `CALL sports.request_forecast_refresh(request_id uuid DEFAULT gen_random_uuid())` | Idempotent all-player local refresh request and audit entry; requires enabled approved coverage | writer |

Player IDs are provider IDs. An empty history or lineage returns no rows. Candidate
history does not prove complete source history: use the forecast's availability
and gap reasons before interpreting a model result. The refresh procedure queues
work transactionally and needs an enabled worker to process it; it does not fetch
provider data or calculate a forecast within the call. Reuse the request UUID for
retries and supply a new UUID for a new request.

The forecast-head trigger records each effective revision-pointer transition in
`forecast.refresh` audit and `forecast.updated` outbox rows in the same transaction.
It preserves A-to-B-to-A transitions, ignores unchanged pointers and rolls back
with the originating write. Latest-evaluation updates alone produce no event.
The queue excludes `forecast.updated` from refresh input. Audit actor IDs record
the SQL session identity; this does not establish end-user authentication.

The [forecast CLI](forecasting.md) exposes `history`, `lineage` and `request` without
requiring MongoDB or provider credentials. `npm run test:reporting` separately
checks selection, limits, idempotence, transactional effects and role permissions
against the guarded disposable PostgreSQL cluster described in the
[database guide](database.md#isolated-integration-tests). CI runs those tests and
this complete isolated demonstration.

## Real historical appearance replay

The separate [`npm run replay --silent`](replay.md) command uses an existing
imported source through its restricted reader and creates its own disposable
PostgreSQL clone. It verifies a real sixth eligible appearance entering the
selected five, its prior oldest leaving, honest incomplete history while that
row is withheld, and an immutable queued refresh after the exact row is restored.
Its present-cutoff data-arrival demonstration preserves genuine observation
times and does not measure historical forecast accuracy. The synthetic SQL/NoSQL
examples above remain self-contained and require no imported source.
