# Requirement traceability

This guide maps the DBMS demonstration requirements and football behavior to
implemented artifacts and repeatable checks. Commands describe how to reproduce
evidence; a source link or screenshot alone does not demonstrate a database
operation. The [real-data sixth-appearance replay](replay.md) demonstrates window
replacement and queued refresh in an isolated clone at a present cutoff. Existing
window/recovery tests and the self-contained database demonstration use synthetic
data; the replay does not establish historical forecast issuance or accuracy.

## Reproduction prerequisites

Use Node.js 24, npm 11 and the committed lockfile. From the repository root,
these checks need no database or provider credentials:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

With a Linux Docker engine capable of running PostgreSQL 17 and MongoDB 8,
`npm run demo` creates and removes its own isolated containers. It uses fresh
random credentials, synthetic data and temporary storage; no `.env`, provider
key or existing application stack is required. See the
[demonstration guide](demo.md) for expected results and cleanup behavior.

`npm run replay --silent` separately reads genuine imported football records
through `lsp_reader` and performs a sixth-appearance arrival demonstration in its
own PostgreSQL 17 clone. It needs the source reader connection and suitable real
evidence, makes no provider calls and leaves source records unchanged. See the
[replay prerequisites and interpretation](replay.md).

All `test:db`, `test:ingestion`, `test:forecast`, `test:reporting`, `test:auth`,
`test:api`, `test:evaluation`, `test:worker`, `test:ui` and
`test:accessibility` commands below require the guarded disposable environments
in [database tests](database.md#isolated-integration-tests) or the combined
[PostgreSQL/MongoDB recipe](ingestion.md#isolated-integration-tests). API/browser
and actual-worker tests also require a preceding build. Browser checks need
`npx playwright install --with-deps chromium`. Never run these suites against
an application database or a shared cluster.

For interactive screens, follow [local setup](../README.md) and
[account creation](api.md#configure-local-access). Use the configured canonical
origin. A database with no imported evidence must display empty/unavailable
states; it does not contain an invented sample of live football. Administrator
source commands require the enabled worker and approved provider configuration.

## DBMS deliverables

| Requirement | Implemented artifact | Repeatable demonstration and expected evidence |
| --- | --- | --- |
| ER diagram | [Entity relationships](database.md#entity-relationships) | Open the Mermaid diagram beside [`001_football.sql`](../db/migrations/001_football.sql), roster and forecast migrations; trace a season/club/fixture/appearance and the forecast parent/head relationships |
| Relational schema with keys, relationships and constraints | [Tables, keys and integrity](database.md#tables-and-keys), [`db/migrations`](../db/migrations/) | `npm run test:db` verifies PK/unique/FK/check and deferred context rules; `npm run demo` shows an invalid roster-player FK being rejected |
| SQL implementation: DDL with constraints | [`scripts/db.ts`](../scripts/db.ts), migrations 001–009 | `npm run test:db` applies the schema fresh, reruns it, rejects altered migration history and invalid records, and verifies failed DDL rolls back; actual setup uses `npm run db:provision` then `npm run db:migrate` |
| NoSQL or vector database creation | [`scripts/mongo.ts`](../scripts/mongo.ts), [`archive.ts`](../src/server/ingestion/archive.ts) | `npm run test:ingestion` provisions MongoDB 8 validators/indexes and its restricted worker identity; `npm run demo` also verifies document collection creation/validation/indexes. This project implements MongoDB, not vector search |
| Technology justification | [Architecture and choices](architecture.md#why-these-technologies) | Explain each component's data/privilege boundary and tradeoff using the diagram, SQL grants, archive permissions and worker flow |
| DML: INSERT, UPDATE and DELETE | [`dml.sql`](../db/demo/sql/dml.sql) | `npm run demo` returns one row for each operation on a separate synthetic player, then verifies rollback restores the sports data |
| Nested, correlated, recursive and JOIN queries | [`queries.sql`](../db/demo/sql/queries.sql) | `npm run demo` checks a club/player JOIN, nested eligible-player selection, correlated counts, latest-five CTE/window query and recursive forecast ancestry; expected rows are documented in [demo](demo.md#executable-examples) |
| Functions/procedures, triggers and CTEs | [`008_reporting.sql`](../db/migrations/008_reporting.sql), [`advanced.sql`](../db/demo/sql/advanced.sql) | `npm run demo` runs history/lineage functions and an idempotent refresh procedure, then proves audit/outbox trigger effects and rollback; `npm run test:reporting` checks routine permissions, concurrency, recursive limits and unchanged-pointer behavior |
| NoSQL features and read/update/delete operations | [`operations.ts`](../db/demo/mongo/operations.ts) | `npm run demo` demonstrates indexed projected reads, `$set`, `$addToSet`, scoped deletion and `$match`/`$unwind`/`$group` aggregation; it leaves three synthetic annotations before dropping only the owned demo collection and verifies source archives are unchanged |
| Next.js interface | [`src/app`](../src/app/), [`src/components`](../src/components/) | Visit `/login`, `/overview`, `/players`, `/players/PLAYER_ID`, `/compare`, `/account` and admin-only `/admin`; `npm run test:ui` exercises actual browser journeys and responsive layouts |
| Backend/API and database integration | [`handler.ts`](../src/server/web/handler.ts), [`src/server/api`](../src/server/api/), [API contract](api.md) | `npm run test:api` exercises a built HTTP server with actual SQL reads, shared-snapshot comparison, audited/idempotent commands and correction conflict handling; `npm run test:worker` exercises the worker's cross-store/recovery path |
| Frontend authentication, at least two roles and database RBAC | [`src/server/auth`](../src/server/auth/), [`003_grants.sql`](../db/migrations/003_grants.sql), [`009_auth_rate_limit.sql`](../db/migrations/009_auth_rate_limit.sql), [`users.ts`](../scripts/users.ts) | Create viewer/admin accounts through the stdin-only CLI, sign in and inspect role-aware navigation; `npm run test:auth` checks sessions/revocation/throttling and SQL role boundaries, while `npm run test:api` denies unauthenticated requests, forged roles and viewer admin actions. Reader SQL writes are rejected |
| Documentation and Git/GitHub | [`README.md`](../README.md), technical [`docs`](./), [CI workflow](../.github/workflows/ci.yml), repository commit/PR history | Follow setup, synthetic demo and [real-data replay](replay.md) prerequisites from a clean checkout; inspect published commits/PR checks. CI runs the locked install, static/build checks and isolated integration/browser demonstrations; the real-data replay requires an already imported source snapshot |

Viewer/admin are application roles loaded from SQL on every protected request.
The reader/writer/auth/migrator database logins have separate grants; users do not
each receive a PostgreSQL login. Server authorization restricts access to the web
process's writer pool. The app receives no provider, MongoDB, bootstrap or
migrator credentials. See [privilege boundaries](architecture.md#authentication-and-privileges).

## Football behavior

| Requirement or resolved rule | Implementation and evidence | Reproduction/status |
| --- | --- | --- |
| Latest five eligible appearances, each at least 60 minutes | [`engine.ts`](../src/server/forecast/engine.ts), [`inputs.ts`](../src/server/forecast/inputs.ts), [history rules](forecasting.md#history-membership-and-availability) | `npm run test:unit` and `npm run test:forecast` check finality, membership, minutes, ordering and exact-five selection; player detail exposes the saved five separately from current observed history |
| Replace the oldest eligible appearance regardless of performance | [`forecast.test.ts`](../tests/forecast.test.ts), [`forecast.database.test.ts`](../tests/forecast.database.test.ts), [`replay.ts`](../scripts/replay.ts) | Synthetic tests cover replacement, short appearances, DNP and deterministic revisions. `npm run replay --silent` withholds one real latest eligible appearance in an owned clone, verifies the honest incomplete-history baseline, restores the exact row and checks queued refresh advances the five and appends a revision matching the untouched snapshot; [protocol and limits](replay.md) |
| Dynamic refresh after new source evidence or target expiry | [`jobs.ts`](../src/server/ingestion/jobs.ts), [`store.ts`](../src/server/forecast/store.ts), [`src/worker`](../src/worker/) | `npm run test:forecast` and `npm run test:worker` verify coalescing, retries, leases, restart recovery and local progress during source stalls; queue acceptance is distinct from completion |
| Upper/middle/lower opposition with asymmetric team context | [`standings.ts`](../src/server/ingestion/standings.ts), [`engine.ts`](../src/server/forecast/engine.ts), [formulas](forecasting.md#context-and-formulas) | `npm run test:unit` checks competition-local cutoffs, deductions/ties, scaled tier boundaries and difficulty from opponent strength minus own-team strength |
| Competition coefficient 2 or 1.5 | [`coverage.ts`](../src/server/ingestion/coverage.ts), model tests | Only the named top five **top divisions** use 2; both covered second divisions use 1.5. Formula tests do not enable additional data coverage |
| Position-specific decimal per-90 estimates | [`engine.ts`](../src/server/forecast/engine.ts), [metric table/formula](forecasting.md#context-and-formulas) | Unit tests cover GK/DEF/MID/FWD, reported minutes above 90, valid zero and dependent missing fields; detail/comparison show units and the 90-minute assumption |
| Separate observed statistics, adjusted form and forecast | [`forecast-view.tsx`](../src/components/forecast-view.tsx), [`player-detail.tsx`](../src/components/player-detail.tsx) | Player detail labels rating 0–10, adjusted form 0–100 and per-90 forecasts; disclosures retain exact inputs, provenance, warnings and output-specific reasons |
| Player-to-player comparison | [`read.ts`](../src/server/api/read.ts), [`comparison.tsx`](../src/components/comparison.tsx), [comparison API](api.md#viewer-reads) | Compare 2–4 players at one cutoff/source snapshot. Default same-position; explicit cross-position opt-in shows a notice and shared metric intersection. `npm run test:api`/`test:ui` verify alignment; comparison creates no saved revision |
| Honest unavailable/incomplete/stale/loading/error states | [`forecast-presentation.ts`](../src/lib/forecast-presentation.ts), [`use-api.ts`](../src/lib/use-api.ts), forecast/API/browser tests | Missing evidence blocks dependent outputs; form-only is distinguishable from a future forecast. Tests exercise null versus zero, expired targets, source changes, permission/session/service failures and asynchronous states |
| Free, bounded, provenance-backed source ingestion | [`provider.ts`](../src/server/ingestion/provider.ts), [`coverage.ts`](../src/server/ingestion/coverage.ts), [`pipeline.ts`](../src/server/ingestion/pipeline.ts), [ingestion](ingestion.md) | `npm run test:unit`/`test:ingestion` verify allowlisting, shared 120-attempt rolling-hour budget, archive-first recovery and normalization with synthetic responses; tests require no provider key |
| Administrator recovery and numeric corrections | [`admin.ts`](../src/server/api/admin.ts), [`admin-correction.tsx`](../src/components/admin-correction.tsx), [operations API](api.md#administrator-operations) | `/admin` exposes job/import/audit status, queued commands and revision-checked corrections; `npm run test:api` covers 403/409, idempotency, actor audit and manual provenance. Corrections cannot invent participation/membership/finality |
| Responsive, accessible navigation and evidence | [`accessibility.browser.test.ts`](../tests/accessibility.browser.test.ts), [`interface.browser.test.ts`](../tests/interface.browser.test.ts) | `npm run test:ui` and `npm run test:accessibility` check keyboard focus, labels, feedback, disclosures, touch targets and layouts at 390/768/1440 pixels. This is scoped automated/manual review, not a claim of exhaustive assistive-technology conformance |
| Explain measured performance and coverage | [`src/server/evaluation`](../src/server/evaluation/), [evaluation protocol/result](evaluation.md) | `npm run evaluate --silent` reads one current snapshot using the fixed historical protocol without writes; published dated result is **0/2,596 scored**, with `null` errors. `npm run test:evaluation` uses synthetic positive cohorts to verify paired scoring/cutoffs/leakage boundaries |
| Preserve predictions for later real-outcome scoring | [`measure.ts`](../scripts/measure.ts), [`prospective.ts`](../src/server/evaluation/prospective.ts), [forward protocol](evaluation.md#forward-measurement) | `npm run measure --silent -- capture ./forecast-capture.json`, then later `npm run measure --silent -- score ./forecast-capture.json`. Reader-only, immutable private 0600 capture before local matchday midnight; pending outcomes supply no measured accuracy |

## Evidence limits

The frozen historical window is October 1–November 9, 2026. No actual roster
observation preceded any holdout cutoff, so later roster imports cannot supply
historical forecast evidence. The zero-scored result and unavailable error
statistics remain part of the deliverable. Forward captures supplement that
result; only finalized real outcomes and available paired cases can produce a
future measured score. Private captures and original provider payloads are not
published.

## Verification record

On **2026-11-10**, the documented combined integration recipe and service-free
unit suite passed **329 tests with no failures or skips** using isolated
PostgreSQL 17/MongoDB 8, Node.js 24.13.1 and npm 11.8.0. The locked install, lint,
typecheck, production build and independent synthetic database demo passed too.
For that verification, the executable application code matched
[`fdd411f`](https://github.com/DevaOnL/Live-Sports-Prediction/commit/fdd411f338e3800fe661061baddfaf67c9c31616),
whose [CI run](https://github.com/DevaOnL/Live-Sports-Prediction/actions/runs/42804478897)
also passed all 329 tests. The committed [workflow](../.github/workflows/ci.yml)
repeats these checks for subsequent published changes.

A separate no-provider Compose rehearsal verified fresh setup, empty-data login,
viewer/admin restrictions and disabled-worker health. Matched PostgreSQL/MongoDB
logical dumps restored into empty isolated targets with equal record/archive
hashes, owners/effective grants, all nine migrations, preserved-session access
and forecast evidence. The exact MongoDB backup/restore shell blocks were also
executed. These dated checks cover a single-host synthetic rehearsal, not an
external HTTPS deployment or future-provider guarantee. Integration and recovery
verification never targeted the existing application databases.

## Screen evidence

These interface examples were captured on **2026-11-10** using isolated
synthetic demonstration data and example accounts. They show implemented screen
behavior, not live provider coverage or measured forecast accuracy. Reproduce
the journeys with the [UI test prerequisites](ingestion.md#isolated-integration-tests)
and `npm run test:ui`, or sign in to an application configured through the
[setup guide](../README.md).

| Screen | Example | What to inspect |
| --- | --- | --- |
| `/overview` | [Overview](screenshots/overview.png) | Stored evaluation/coverage counts and links into player discovery |
| `/players/PLAYER_ID` | [Player detail](screenshots/player.png) | Separately labeled form/forecast, the exact selected five and output evidence |
| `/compare` | [Comparison](screenshots/comparison.png) | Shared snapshot, aligned units and each player's availability |
| `/admin` | [Administration](screenshots/administration.png) | Restricted status, queued operations, corrections and audit/recovery controls |

The player example shows a saved August forecast with its stale-target warning;
comparison recalculates at the current shared cutoff and shows missing-history
reasons. A saved revision and a current comparison can therefore differ in
availability. Neither screen substitutes missing evidence with invented values.

The offline database demo uses clearly labeled synthetic football data to make
SQL/NoSQL behavior repeatable. The separate [real-data replay](replay.md) uses
observed records in a disposable clone and a fixed present cutoff. Neither
demonstration establishes provider completeness or predictive accuracy.
Interactive football availability depends on the actual imported evidence and
worker progress. Preserve these distinctions when demonstrating the application.
