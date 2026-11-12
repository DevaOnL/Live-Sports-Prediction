# Football data ingestion

The current worker uses Sorare's registered developer API at
`https://api.sorare.com/graphql`. Free access to both configured leagues and
player statistics was verified on **2026-11-10**. Access and provider limits can
change; this is a dated observation. Registration and the provider's API terms
apply; see the [official API documentation](https://github.com/sorare/api).
This project uses no paid
trial, purchasing flow or account rotation to evade quotas.

| Competition | API competition slug | Season | Clubs | Local standings timezone |
| --- | --- | --- | --- | --- |
| Premier League | `premier-league-gb-eng` | 2026/27 | 20 | Europe/London |
| La Liga | `laliga-es` | 2026/27 | 20 | Europe/Madrid |

Only regular-season fixtures within 2026-07-01 through 2027-06-30 are accepted.
Both model coefficients are 2. Sorare returns UTC kickoff instants; local
standings cutoffs use the timezone above. Other leagues and seasons are rejected.
[`sources.ts`](../src/server/ingestion/sources.ts) defines the current allowlist.

Migration `010_current_coverage.sql` disables former Championship/Ligue 2 product
coverage without deleting its canonical rows, archives or revisions. The old
APIFootball adapter remains for reproducible archived demonstrations and frozen
[evaluation](evaluation.md)/[replay](replay.md) protocols. It does not extend the
current product's league coverage.

## Configure and start

Install with `npm ci` and copy `.env.example` to the ignored `.env`. Use independent
random database passwords of at least 16 characters. Create a registered Sorare
API key through its developer settings and store it as `SORARE_API_KEY` locally.
The client sends it only in the `APIKEY` HTTP header. Never put the key in a
browser bundle, command argument, committed file or response dump. Login and
stored-data reads need no provider key; an enabled source worker does.

```bash
docker compose up -d --wait postgres mongo
npm run db:provision
npm run db:migrate
npm run mongo:provision
```

`db:migrate` checks applied checksums and applies pending files through
`012_appearance_enrichment.sql`. Preserve existing volumes. MongoDB provisioning
configures validators, indexes and the restricted archive identity. These
administrative commands use local bootstrap/migrator credentials.

Set `INGESTION_ENABLED=true`, then run:

```bash
docker compose up -d --build worker
```

The worker receives its PostgreSQL writer, restricted MongoDB identity and Sorare
key. It has no auth, bootstrap or migrator credentials. The web app receives only
its reader/writer/auth SQL credentials and authentication secret; it has no
provider key or MongoDB access. Host CLI commands load ignored local dotenv
settings and use loopback database hosts/ports. Compose uses internal hostnames.
Stop the Compose worker before running a host worker with `npm run worker`.

`INGESTION_ENABLED=false` leaves process health available without database or
queue activity. Enabled `/health` checks authenticated database access and the
source/local-forecast loops. Health does not certify complete or fresh football
data. The web `/api/health` separately reports process/configuration liveness.

## Commands and polling

| Command | Operation |
| --- | --- |
| `npm run ingest -- sync` | Capture current teams/rosters, season fixtures and standings for both configured leagues; enqueue required detail/standings work |
| `npm run ingest -- once` | Reconcile archives and process at most ten queued jobs |
| `npm run ingest -- reconcile` | Recover current-source archives and project already committed roster evidence offline |
| `npm run ingest -- status` | Inspect current-source fixtures, archives, request budget, jobs and standings reconciliation |
| `npm run ingest -- retry JOB_UUID` | Requeue an eligible failed current-source job after resolving its cause |

Explicit `sync`/`once` commands can call the provider even when the long-running
worker flag is false. `status`, `reconcile` and `retry` require the restricted
SQL/MongoDB runtime connections but no provider key. A retry queues work; it does
not execute it. Administrator [API commands](api.md#administrator-operations)
also queue work with an idempotent request UUID and atomic actor audit. A 202
response confirms acceptance; inspect jobs for completion.

The worker polls every 15 minutes. Teams/rosters, events and standings are six
logical imports across two leagues, with a variable number of HTTP requests:
each cursor page and each fixture-statistics request spends a separate attempt.
A complete roster needs every page for all 20 clubs. Fixture pagination spans
both past and future games and stops only after the configured season boundary
or exhausted connection, with validated cursor/date ordering. A season schedule
must contain every **380 ordered home/away pairings** before it replaces the
canonical schedule. A shortened response cannot establish complete history.

The observed Sorare key allowance was 200 requests per minute. The application
uses a stricter shared **60 attempts per rolling minute**, with at least **one
second between actual requests**. Worker, CLI and administrator-triggered work
share SQL reservations; failed attempts count too. Provider 429/retry dates can
still defer work. No extra accounts or keys bypass that budget. Source backfill
and corrections can therefore remain pending while local forecast work proceeds.

Initial fixture details are queued once; live details may refresh every 15
minutes. Missing/partial or recent final details are retried under the job
scheduler's daily/correction-window rules. A newly imported fixture schedule does
not imply that player history is already complete. Use `status` to inspect the
actual backlog and validation issues.

The endpoint is fixed, redirects are rejected, and each HTTP request times out
after 30 seconds with an 8 MiB streamed-body limit. Capture bundles are also
bounded. Safe error codes omit provider messages and credentials. A response
containing the API key is rejected before archival.

## Storage and recovery

Sorare imports use versioned `sorare-capture-v1` bundles. Each page retains its
exact GraphQL query, credential-free variables, exact HTTP response text and
actual retrieval timestamp. The bundle records whether the full logical capture
completed. Partial captures remain archived as invalid evidence; they cannot be
normalized as a complete roster or schedule. Retrieval times are never backdated.

1. Archive the bundle and SHA-256 in MongoDB `raw_archives`, with action,
   credential-free resource/parameters and observation time.
2. Validate its scope, cursor chain and football evidence; retain fixed issue codes.
3. Commit canonical changes, source/normalized revisions, audit/outbox work and
   the `sports.ingestion_batches` marker together in PostgreSQL.
4. Mark separate MongoDB `import_metadata` after SQL commit.

There is no cross-store transaction. Recovery finds archives with missing,
pending or failed metadata; the SQL import marker prevents duplicate effective
imports after a crash between SQL commit and MongoDB marking. Invalid captures
stay immutable and quarantined. Transient persistence failures remain retryable.
`reconcile` handles up to 1,000 current-source pending/unmarked archives per call
and reprojects latest committed roster bundles at their original times. It does
not import unrelated archived APIFootball payloads into the current source.

This is interruption recovery, not a SQL rebuild from raw archives. Back up both
stores together; do not delete markers or reset volumes to force replay. The
MongoDB runtime can read/insert authoritative archives but cannot update/delete
them. Import metadata is separately mutable. Provider-qualified keys distinguish
source observations and native-ID entity tuples without relabeling their origin.

Player and club `provider_id` values retain returned `Player:UUID` and `Club:UUID`
node IDs; fixtures retain `Game:UUID`. Competition business IDs are the two
configured slugs. Club/player `provider_slug` is separate lookup/link metadata,
used for genuine Sorare attribution links. A game query uses its bare UUID
selector while stored identity retains the full native ID.

Roster snapshots establish current-club claims at observation time. Appearance
memberships cover the fixture instant and do not imply continuous transfer
history. Complete newer exclusions can retire an earlier current-club claim;
incomplete or conflicting newest relevant rosters remain uncertain. Missing
rosters in unrelated leagues cannot invalidate a confirmed club. Absence from a
formation or statistics list never creates a DNP appearance.

Manual metric corrections retain an explicit manual source, new normalized
revision and reason/before/after/actor audit. They cannot invent participation,
membership or finality. Provider observations retrieved at or before a retained
manual correction skip that entire fixture and record
`superseded_by_manual_correction`; newer provider evidence can supersede the
manual values while preserving their history. Older same-resource observations
may instead be rejected as `superseded_archive`. Raw archives remain unchanged.

Outbox jobs are provider-scoped: current payloads carry `provider:"sorare"`.
Supported kinds are `source.sync`, `fixture.statistics`, `standings.rebuild` and
local `forecast.refresh`. Claims use a 120-second lease renewed every 30 seconds;
expired leases and transient failures follow bounded retry/backoff rules. Budget
deferrals do not spend a processing attempt. Canonical, roster and standings
events coalesce forecast refreshes, including changes arriving during active
work. A minute check handles target expiry, and a separate five-second local loop
continues while provider requests are in flight. A saved evaluation can still be
stale; inspect its own cutoff/target/source warnings.

## Missing data and historical standings

[`sorare-normalize.ts`](../src/server/ingestion/sorare-normalize.ts) maps direct
nullable counts and exact matching `detailedScore[].statValue` evidence:

| Canonical field | Direct field | Matching detailed stat |
| --- | --- | --- |
| `minutes` | `minsPlayed` | `mins_played` |
| `goals` | `goals` | `goals` |
| `assists` | `goalAssist` | `goal_assist` |
| `shots_on_target` | `ontargetScoringAtt` | `ontarget_scoring_att` |
| `tackles` | `totalTackle` | `total_tackle` |
| `interceptions` | `interceptionWon` | `interception_won` |
| `saves` | `saves` | `saves` |
| `goals_conceded` | `goalsConceded` | `goals_conceded` |

A validated explicit zero in a matching detailed stat is observed zero. A null
with no such evidence stays missing; conflicting values also remain unknown and
raise an issue. `wonTackle`/`won_tackle` is a different statistic from total
tackles. Sorare's fantasy score does not supply a conventional 0–10 rating, and
key passes are unsupported. Those primary fields remain null. Counts and
minutes must be nonnegative integers; reported minutes above 90 are preserved.

Finality comes from `game.statusTyped=played`. Actual participation uses player
statistics (`playedInGame`, `fieldStatus`, minutes) and formation/team evidence.
`playedInLineup` is fantasy-manager alignment and is not real match participation.
An unresolved or absent row remains a gap. Final-game statistics still under
`REVIEWING`, unreviewed or live review retain their valid observed counts with an
explicit review issue and partial statistics status; they do not silently vanish
from the latest-five window. Missing ratings/key passes can block their dependent
outputs while other evidenced count projections and scouting strengths remain
possible. None of this establishes predictive accuracy.

## Optional match-stat supplementation

[Highlightly Football Basic](https://highlightly.net/football-api/) is an optional
registered free source for the same two leagues and season. Real Basic responses
on **2026-11-10** included match ratings, key passes and total tackles for both
leagues. This is a dated access observation. The service can omit fields or change
coverage. Configure `HIGHLIGHTLY_API_KEY` only in the worker/ignored local `.env`;
the app receives no provider keys. No payment or paid trial is required.

Apply all pending migrations through `013_session_persistence.sql` before deploying;
`012_appearance_enrichment.sql` supplies the supplement storage.
Run `npm run enrich -- 2` to process up to two match box scores, or enable the
normal worker to backfill in bounded batches. All pages of the external fixture
catalogue are cached for a UTC day and completed box scores for seven days.
The supplementary catalogue can contain fewer than 380 fixtures; missing fixtures
remain unmapped and never replace Sorare's complete schedule or establish DNP.
A changed primary
appearance or fixture revision immediately invalidates its prior supplements.
Fetching prioritizes completing player windows; it never changes eligibility.

`npm run enrich -- --cached-only` reprocesses the latest imported box scores
without provider requests. The versioned name-entity normalization pass can append
previously unmatched appearances using the original source revision and retrieval
time. It preserves existing observations, import receipts and newer heads; stale
primary fingerprints are skipped until fresh source evidence is available.

The Basic allowance is **100 requests/day**, resetting at midnight UTC. A shared
SQL-clock counter budgets actual attempts, spaces them by one second, honors the
provider's remaining-count header and keeps five requests spare. Errors consume
reservations. Other source requests use separate budgets. Existing final matches
require several daily budgets to backfill; account rotation is not used. If the
same key was used by local setup tools, record the last observed allowance with
`EnrichmentStore.observeQuota` before starting concurrent consumers. The provider
counter can only reduce the current day's remaining allowance.
For a deliberate one-off import, `npm run enrich -- 5 --use-reserve` can spend the
five reserved requests. It still enforces the actual remaining allowance, shared
SQL-clock pacing and 100-request daily cap. The normal worker keeps its five-call
reserve; neither flag resets counters or changes the provider plan. The two flags
cannot be combined.

Ingestion processes wait up to five seconds before trying the next resolved
address during dual-stack fallback. This accommodates slower IPv4 paths when IPv6 is unreachable;
DNS, certificate validation and the 30-second HTTP deadline remain enabled.
Provider errors are classified separately from internal processing errors. HTTP 200 error
objects are rejected, and observed `Retry-After` values take precedence over
rate-limit reset seconds, bounded to one second through 24 hours. A rate-limit
response without either header uses a one-hour fallback.

A narrowly identified missing or invalid box score is deferred for 15 minutes
using durable request/accepted-receipt timestamps, while the finite batch tries
other fixtures. Authentication, quota, transport and service failures stop the
batch. Transport failures back off from 15 minutes to one hour; an upstream retry
date can defer longer. Accepted captures and strict matching rules stay unchanged.
Worker `/health` reports `supplementState`, `supplementRetryAt` and a sanitized
`supplementError` with fixed code/reason and optional HTTP status. `busy`,
`waiting-for-data`, `budget-deferred` and provider/processing failures are distinct
from `synced`; the primary source and local forecast polling run independently.

Each box score must match the league, season, home/away clubs, exact kickoff and
final result. A player must match one unambiguous name or initial abbreviation
within that club, plus exact goals, assists and shots on target. Both sources must
report valid positive minutes for the known-played primary appearance. Differing
positive minutes do not reject an otherwise corroborated match: Sorare's minutes
always determine eligibility, the exact five and model rate denominators. Accepted
evidence records both reported minutes, the Sorare choice and their signed
difference (Highlightly minus Sorare), including large disagreements. No
edit-distance matching or name-only joins are used. Unsupported or ambiguous
identities remain unused. All accepted fields retain their separate source,
retrieval time and revision evidence; raw captures and matching evidence stay
private. Sorare's explicit values take precedence. A missing value never becomes
zero without explicit numeric evidence.

| Effective field | Highlightly box-score field |
| --- | --- |
| `rating` | `matchRating`, finite raw value in 0–10; no rescaling |
| `key_passes` | `statistics.passesKey` |
| `tackles` | `statistics.tacklesTotal` |
| `interceptions` | `statistics.interceptionsTotal` |

Actual responses use a `statistics` object; the documentation also declares an
array, so a single unambiguous statistics record is supported. Counts must be
nonnegative integers. Highlightly calls `matchRating` a match performance rating
but does not document its rating methodology or bounds. Only reported finite
values in the model's 0–10 range are accepted; this does not establish calibration
or equivalence with other rating vendors. All rating evidence for this source
comes from that reported field, never Sorare's fantasy score. Goalkeeper saves
and goals conceded are deliberately not supplemented: the real samples contained
inconsistent zero goals-conceded values despite scored goals.

Immutable MongoDB captures precede SQL supplement receipts, revisions and outbox
events. Recovery is source-scoped. Effective reads are shared by profiles,
forecast inputs, scouting and source-aware SQL reporting; the primary observation
time stays separate from supplementary freshness. Original observations and old
forecast revisions are preserved.
Cached reprocessing uses the versioned `primary-aliases-v4` mapping and appends
only newly resolved identities at their original source revision and observation
time. Existing captures, primary rows, earlier mapping receipts and accepted
supplements remain unchanged; repeating the same mapping is idempotent.
Name matching folds accents and explicit Latin letter equivalents, including
`ø/o` and `ß/ss`. Nicknames can also match explicit full or abbreviated names
from the latest complete, accepted Sorare roster capture for the same native
player ID. Each such match retains the name, archive hash and retrieval time;
slugs and guessed aliases are not used. Fixture, club, count, positive-minute
and unique-player checks still apply. Earlier roster query bytes remain valid
for replay. Cached mapping receipts also distinguish newly resolved alias
identities, allowing later name evidence to fill more records without changing
the original match observation time or previously accepted values.
Accepted schedule corrections withdraw contradicted supplements before further
provider requests, including during cached reprocessing. A failure fetching the
other league cannot postpone that withdrawal; absence from a partial catalogue
alone does not contradict an earlier verified match.

[Highlightly's terms](https://highlightly.net/terms/), section 6.1, allow storing
and displaying data in this application. They prohibit supplying it as a dataset,
feed, export, proxy or reusable API for third parties' own applications or
analysis. Application endpoints serve this product's authenticated interface;
do not redistribute captures or offer a downstream data service.

Standings reconstruct corrected results from strictly earlier competition-local
dates, at local midnight; future context can use observed same-day finals before
its cutoff. This is retrospective reconstruction. Missing pairings/results block
complete context. Premier League ranks use points, overall goal difference and
goals scored; remaining ties stay uncertain because final-season sporting stakes
and playoffs are not inferred. La Liga uses completed head-to-head evidence,
including a fresh mini-table for a remaining tied subset, then overall goal
difference/goals. Incomplete head-to-head or unavailable final fair-play/deciding
criteria preserve uncertain rank intervals. Ties crossing a strength-tier boundary
use neutral strength. Former-league deductions are not applied to these leagues.

Provider-total reconciliation is a separate operational check. In `status`,
`complete:true` and an empty `mismatches` list establish agreement of imported
played/wins/draws/losses/goals/points totals at that observation. Check player
metric, roster and review gaps separately; HTTP success or worker health does not
establish complete football coverage.

## Isolated integration tests

`npm run test:unit` requires no services or provider key. `npm run test:source`
checks current-source capture/normalization, read contracts and reporting upgrades;
`npm run test:ingestion` retains archived-adapter recovery checks. Both use synthetic
provider responses and must run
against disposable PostgreSQL 17 and MongoDB 8 instances, never the demo database
or a shared cluster. It provisions roles and clears the guarded test tables and
archive collections between cases.

Existing browser/worker fixtures explicitly select `LSP_TEST_SOURCE=legacy` only
inside the guarded `_test` database. Current-source tests construct their Sorare
profile explicitly. The selector cannot enable legacy coverage in a production
database and must not be used as a product source switch.

The suite checks `NODE_ENV=test`, a PostgreSQL database ending `_test`, and
`POSTGRES_TEST_CLUSTER_ID` matching `pg_control_system()`. PostgreSQL must contain
no other non-template databases beyond `postgres` and the selected test database.
MongoDB additionally requires `MONGO_TEST_PORT`, a `MONGO_TEST_DATABASE` ending
`_test` equal to `MONGO_DB`, and `MONGO_TEST_HOST_ID` matching the authenticated
server's `hostInfo.system.hostname`. These identifiers select the isolated test
servers; they are not credentials. MongoDB must contain no databases besides its
system databases and the selected test database. Use the disposable-container recipe below
after `npm ci`. For the browser suites, first install Chromium and its host
dependencies with `npx playwright install --with-deps chromium` as described in
the [README](../README.md). Run all suites sequentially inside the subshell so
its identity markers and temporary services remain available until they finish.

```bash
(
  set -eu
  export NODE_ENV=test POSTGRES_DB=sports_ingestion_test
  export POSTGRES_USER=sports_test_bootstrap POSTGRES_HOST=127.0.0.1
  export MONGO_HOST=127.0.0.1 MONGO_DB=sports_ingestion_test
  export MONGO_TEST_DATABASE="$MONGO_DB"
  export MONGO_BOOTSTRAP_USER=ingestion_test_bootstrap MONGO_WORKER_USER=lsp_ingestion
  export APIFOOTBALL_API_KEY= SORARE_API_KEY= INGESTION_ENABLED=false
  export LSP_TEST_SOURCE=legacy
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
  npm run test:db
  npm run test:ingestion
  npm run test:source
  npm run test:forecast
  npm run test:replay
  npm run test:evaluation
  npm run test:reporting
  npm run test:auth
  npm run build
  npm run test:api
  npm run test:ui
  npm run test:worker
  npm run test:accessibility
)
```

The subshell removes only its two temporary containers on exit. It does not reset
project volumes. Test output describes the checks actually run; this setup recipe
does not establish live-provider availability or a successful real-data import.
The auth suite uses SQL sessions, roles, CLI administration and shared login
limits. The API suite checks scoped reader snapshots, audited administrator
commands, manual-correction replay protection and real HTTP behavior against the
built app. HTTP tests seed synthetic archives and need both server identity
markers, even though the web process itself has no MongoDB connection. These
suites do not make provider requests.
The evaluation suite covers the frozen historical and separate forward protocols;
the worker suite exercises real process crashes, leases and recovery with a
synthetic provider preload. Browser suites use the built app and synthetic data,
blocking requests outside their isolated web origin. Run `npm run test:unit`
separately for service-free checks and `npm run demo` for its own independent
disposable demonstration.

Contradictory same-player lineup clubs preserve unknown participation and clear
stale membership and metrics. Detailed statistics in that contradictory response
do not silently choose a club; a later consistent statistics response can recover
known participation. The worker polls the local forecast queue independently of
source requests, so a slow provider does not block local refreshes.

Sorare's `suspended` state maps to the explicit canonical `suspended` status.
Scores from that unfinished fixture are excluded from standings and five-match
selection. A genuinely new schedule observation can update this state; imported
archives are never retimestamped or altered to force a replay.
