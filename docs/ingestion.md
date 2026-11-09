# Football data ingestion

The worker imports observed football data from APIFootball.com's permanent free
plan at `https://apiv3.apifootball.com/`. Free access is a dated observation, not a
promise of continued availability. Paid trials and additional competitions are
outside the configured coverage.

| Competition | Provider ID | Season | Clubs | Local standings timezone |
| --- | --- | --- | --- | --- |
| Championship | 153 | 2026/27 | 24 | Europe/London |
| Ligue 2 | 164 | 2026/27 | 18 | Europe/Paris |

Only the regular season is accepted, with season bounds 2026-07-01 through
2027-06-30. Both competition coefficients are 1.5. Fixture requests specify UTC;
provider `match_date` and `match_time` are combined as UTC without applying the
competition's local offset again. Playoffs, other seasons, and unapproved leagues
are rejected. Missing kickoff times and unfamiliar statuses remain uncertain.

## Configure and start

Install using `npm ci` and copy `.env.example` to the ignored local `.env`.
Replace every password placeholder with an independent random value of at least
16 characters. Keep the provider-issued key in `APIFOOTBALL_API_KEY`; never put it
in a browser bundle, command argument, committed file, or provider response dump.
The preview and idle worker need no API key.

Start the databases, provision their roles, and explicitly apply migrations:

```bash
docker compose up -d --wait postgres mongo
npm run db:provision
npm run db:migrate
npm run mongo:provision
```

`db:migrate` includes ingestion, roster and forecast storage. It checks all
previously applied checksums before applying new files. Preserve existing volumes during upgrades.
MongoDB provisioning creates or updates collection validators/indexes and the
restricted `MONGO_WORKER_USER`, whose default is `lsp_ingestion`, in `MONGO_DB`.
The administrative commands use local bootstrap/migration credentials.

Set `INGESTION_ENABLED=true` in `.env`. The worker connects as PostgreSQL
`lsp_writer` with `POSTGRES_WRITER_PASSWORD` and as the restricted MongoDB user
with `MONGO_WORKER_PASSWORD`. It receives no bootstrap or migrator credentials.
The app has no database connections or credentials.

For host-side commands, use the loopback database hosts/ports in `.env`. Compose
uses the internal service hostnames for its worker. To start the enabled worker:

```bash
docker compose up -d --build worker
```

For a host-side worker, stop the container worker first and run `npm run worker`.
Leave `INGESTION_ENABLED=false` to keep its process health listener available
without database connections, imports, or queue processing. Health reports
liveness; it does not certify complete football history.

## Commands and polling

The CLI uses the same restricted identities and shared provider budget:

| Command | Operation |
| --- | --- |
| `npm run ingest -- sync` | Import teams, the full covered-season event schedule in UTC, and provider standings for both competitions; enqueue required detailed statistics and standings work |
| `npm run ingest -- once` | Process a bounded batch of queued ingestion work |
| `npm run ingest -- reconcile` | Recover SQL/import metadata and hydrate the latest previously committed roster observations offline |
| `npm run ingest -- status` | Show fixture/archive states, shared budget use, standings reconciliation, queue counts, and failed job identifiers with safe failure codes |
| `npm run ingest -- retry JOB_UUID` | Requeue a failed ingestion job after correcting its cause; replace `JOB_UUID` with its identifier from status |

The enabled worker synchronizes every 15 minutes and processes durable jobs
between polls. Each scheduled sync uses six provider calls: teams, events, and
standings for each of two competitions. Four syncs per hour use 24 requests,
leaving up to 96 detailed-statistics requests within the shared cap of 120.
Manual commands and failed HTTP attempts consume the same budget. The provider
client makes one network attempt per reservation; job retries reserve again.

The initial full-season backfill is queued once. Live fixture detail can refresh
every 15 minutes. Missing/partial detail and recently completed fixtures refresh
at most daily; complete final detail is refreshed daily only while its fixture is
within the recent seven-day correction window. Repeated scheduled polls do not
refetch every old completed fixture. Initial detail backfill can span several
request windows; an early import can have complete results and incomplete player
statistics.

The endpoint is fixed, redirects are rejected, requests time out after 30 seconds,
and streamed response bodies are limited to 8 MiB. HTTP/provider errors are
classified with safe codes. The key is excluded from archived request parameters
and resource keys; a response echoing the actual key is rejected before archival.
Malformed successful football responses are retained for validation/quarantine.

## Storage and recovery

Each successfully received observation follows this sequence:

1. Insert the exact response text and SHA-256 into MongoDB `raw_archives`, with
   source action, credential-free canonical parameters/resource key, and retrieval
   time. Archive identity includes action, resource key, content hash, and retrieval
   time, so a later observation of identical bytes retains its own provenance.
2. Normalize approved football records and record fixed validation issue codes.
3. Commit PostgreSQL canonical changes, source/normalized revisions, audit/outbox
   work, and the `sports.ingestion_batches` marker in one transaction.
4. Update MongoDB `import_metadata` with the committed result.

There is no distributed transaction. A crash after raw insertion is recovered by
scanning raw archives, including records with no initial metadata. A crash after
SQL commit is recovered from the SQL marker; replay does not duplicate canonical
rows or effective jobs. The MongoDB import marker is never written before SQL
commit. Observations rejected by relational integrity constraints are quarantined as
`invalid`, preserving their raw bytes while allowing newer corrections to proceed.
Service and connection failures remain retryable.
Repeated content can produce new observations without unnecessary
canonical changes; genuine corrections append revisions.

The MongoDB runtime role can read/insert raw archives but cannot update/delete
them. Validation/import state is separately mutable in `import_metadata`, with
`pending`, `imported`, `invalid`, and `failed` states and associated issues. Strict
collection validators and indexes are provisioned administratively. Do not repair
an import by editing authoritative raw bytes or resetting database volumes.

Outbox dispatch creates supported `fixture.statistics` and `standings.rebuild`
jobs idempotently. Claims use database locking and a 120-second lease renewed
every 30 seconds. Expired leases return to the queue while attempts remain.
Transient failures use exponential backoff; permanent provider errors and invalid
job payloads stop immediately. The default maximum is five attempts. Shared-budget exhaustion
defers a job without spending its processing attempt. Provider retry dates are
bounded to one second through one hour. Persisted errors contain safe codes.
Canonical, standings and roster changes are coalesced into local `forecast.refresh`
jobs. Changes arriving during a running refresh remain pending for a follow-up.
An automatic minute check handles target expiry even without new provider data.
Forecast work takes priority over source-detail jobs and uses no provider budget.
The worker performs a local refresh pass before reconciliation and source polling.
Unrelated outbox event types remain available to their consumers. See
[forecasting](forecasting.md) for model behavior and persistence.

Use `status` to identify the affected job and code, fix configuration or service
availability, then use `reconcile` for cross-store recovery or `retry JOB_UUID` for
a failed job. A denied provider request does not create a source archive or erase
previous observations. A successful but broken statistics response records a gap
and replaces stale metrics with unknown values for known participants.

Roster observations preserve validated player/club pairs separately from
fixture-instant memberships. Memberships established by appearances cover only
that fixture instant; they do not imply continuous transfer tenure. A complete
newer roster can remove an old current-club association, and conflicting or
incomplete newest observations remain uncertain. Unknown positions and missing
match metrics do not by themselves invalidate roster membership coverage.
After an upgrade, `reconcile` projects the latest already committed `get_teams`
archives using their original observation times, without spending API requests.

## Missing data and historical standings

Event listings commonly include lineups without player statistics. Known starters
and substitutes are retained as unknown participants until detailed evidence is
available. Coaches are excluded; a lineup's numeric formation slot is not treated
as a position group. Detailed statistics support keyed fixture responses, flat
`player_statistics`, and event `player_stats.home`/`away` collections.

Blank/null metrics remain missing; valid numeric zero remains zero. Explicit
zero-minute evidence can confirm DNP when it does not conflict with positive
statistics. Absence from a detailed response cannot confirm DNP: prior known
participants are retained with unknown participation and null metrics. Minutes
above 90 are preserved. Malformed identifiers, dates, ratings outside 0–10, and
negative/noninteger count metrics are rejected or flagged. Missing whole-match or
player detail remains visible through fixture statistics status and validation
issues; it must not be skipped to obtain a convenient five-match window.

Historical standings use corrected results from strictly earlier competition-local
dates, with a cutoff at local midnight. This is retrospective reconstruction, not
a replay of tables as originally published. Missing schedule/result context marks
a snapshot incomplete. Southampton's 2026/27 four-point deduction is explicit
provenance-backed context. Championship and Ligue 2 use separate tie rules;
Ligue 2 head-to-head comparison waits for both meetings. Unsupported disciplinary
separation leaves unresolved ties flagged. Future forecasts must treat a tie
crossing a strength-tier boundary as uncertain with neutral strength.

Real provider-total reconciliation is an operational verification step. Do not
infer that it passed from a successful HTTP response or a healthy worker. Inspect
`status` reconciliation entries: `complete` must be true and `mismatches` empty
for the imported reference totals to agree. The comparison covers played, wins,
draws, losses, goals for/against, and points. Inspect player-statistics gaps
separately; continued free access and complete player detail remain source limitations.

## Isolated integration tests

`npm run test:unit` requires no services or provider key. The PostgreSQL/MongoDB
suite uses synthetic provider responses and `npm run test:ingestion`; it must run
against disposable PostgreSQL 17 and MongoDB 8 instances, never the demo database
or a shared cluster. It provisions roles and clears the guarded test tables and
archive collections between cases.

The suite checks `NODE_ENV=test`, a PostgreSQL database ending `_test`, and
`POSTGRES_TEST_CLUSTER_ID` matching `pg_control_system()`. PostgreSQL must contain
no other non-template databases beyond `postgres` and the selected test database.
MongoDB additionally requires `MONGO_TEST_PORT`, a `MONGO_TEST_DATABASE` ending
`_test` equal to `MONGO_DB`, and `MONGO_TEST_HOST_ID` matching the authenticated
server's `hostInfo.system.hostname`. These identifiers select the isolated test
servers; they are not credentials. MongoDB must contain no databases besides its
system databases and the selected test database. Use the disposable-container recipe below
after `npm ci`.

```bash
(
  set -eu
  export NODE_ENV=test POSTGRES_DB=sports_ingestion_test
  export POSTGRES_USER=sports_test_bootstrap POSTGRES_HOST=127.0.0.1
  export MONGO_HOST=127.0.0.1 MONGO_DB=sports_ingestion_test
  export MONGO_TEST_DATABASE="$MONGO_DB"
  export MONGO_BOOTSTRAP_USER=ingestion_test_bootstrap MONGO_WORKER_USER=lsp_ingestion
  export APIFOOTBALL_API_KEY= INGESTION_ENABLED=false
  for ingestion_test_credential in BOOTSTRAP READER WRITER AUTH MIGRATOR; do
    export "POSTGRES_${ingestion_test_credential}_PASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  done
  export MONGO_BOOTSTRAP_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  export MONGO_WORKER_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  ingestion_test_pg=
  ingestion_test_mongo=
  trap 'docker rm -f ${ingestion_test_pg:+"$ingestion_test_pg"} ${ingestion_test_mongo:+"$ingestion_test_mongo"} >/dev/null 2>&1 || true' EXIT
  ingestion_test_pg=$(POSTGRES_PASSWORD="$POSTGRES_BOOTSTRAP_PASSWORD" docker run \
    --rm -d --tmpfs /var/lib/postgresql/data \
    --env POSTGRES_USER --env POSTGRES_DB --env POSTGRES_PASSWORD \
    --env POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
    -p 127.0.0.1::5432 postgres:17-alpine)
  ingestion_test_mongo=$(MONGO_INITDB_ROOT_USERNAME="$MONGO_BOOTSTRAP_USER" \
    MONGO_INITDB_ROOT_PASSWORD="$MONGO_BOOTSTRAP_PASSWORD" docker run \
    --rm -d --tmpfs /data/db --tmpfs /data/configdb \
    --env MONGO_INITDB_ROOT_USERNAME --env MONGO_INITDB_ROOT_PASSWORD \
    -p 127.0.0.1::27017 mongo:8)
  ingestion_test_pg_ready=0
  ingestion_test_mongo_ready=0
  for ingestion_test_attempt in {1..60}; do
    if docker exec "$ingestion_test_pg" sh -c \
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1"' \
      >/dev/null 2>&1; then
      ingestion_test_pg_ready=1
      break
    fi
    sleep 1
  done
  [ "$ingestion_test_pg_ready" = 1 ] || { echo 'Temporary PostgreSQL did not become ready.' >&2; exit 1; }
  for ingestion_test_attempt in {1..60}; do
    if docker exec "$ingestion_test_mongo" sh -c \
      'mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "if (db.adminCommand({ ping: 1 }).ok !== 1) quit(1)"' \
      >/dev/null 2>&1; then
      ingestion_test_mongo_ready=1
      break
    fi
    sleep 1
  done
  [ "$ingestion_test_mongo_ready" = 1 ] || { echo 'Temporary MongoDB did not become ready.' >&2; exit 1; }
  ingestion_test_pg_binding=$(docker port "$ingestion_test_pg" 5432/tcp)
  export POSTGRES_PORT="${ingestion_test_pg_binding##*:}"
  ingestion_test_mongo_binding=$(docker port "$ingestion_test_mongo" 27017/tcp)
  export MONGO_PORT="${ingestion_test_mongo_binding##*:}" MONGO_TEST_PORT="${ingestion_test_mongo_binding##*:}"
  export POSTGRES_TEST_CLUSTER_ID="$(docker exec "$ingestion_test_pg" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT system_identifier::text FROM pg_control_system()"')"
  export MONGO_TEST_HOST_ID="$(docker exec "$ingestion_test_mongo" sh -c \
    'mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "print(db.adminCommand({ hostInfo: 1 }).system.hostname)"')"
  npm run test:ingestion
)
```

The subshell removes only its two temporary containers on exit. It does not reset
project volumes. Test output describes the checks actually run; this setup recipe
does not establish live-provider availability or a successful real-data import.

Contradictory same-player lineup clubs preserve unknown participation and clear
stale membership and metrics. Detailed statistics in that contradictory response
do not silently choose a club; a later consistent statistics response can recover
known participation. The worker polls the local forecast queue independently of
source requests, so a slow provider does not block local refreshes.
