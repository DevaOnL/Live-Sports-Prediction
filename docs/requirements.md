# Requirement traceability

This guide maps the DBMS demonstration requirements and football behavior to
implemented artifacts and repeatable checks. Commands describe how to reproduce
evidence; a source link or screenshot alone does not demonstrate a database
operation. The archived [real-data sixth-appearance replay](replay.md) demonstrates
window replacement and queued refresh in an isolated clone at a present cutoff. Existing
window/recovery tests and the self-contained database demonstration use synthetic
data; the replay does not establish historical forecast issuance or accuracy.
Current product coverage is Sorare Premier League/La Liga, 2026/27. The original
APIFootball evaluation/replay remains separately documented as archived evidence.

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

`npm run replay --silent` separately reads genuine archived APIFootball records
through `lsp_reader` and performs a sixth-appearance arrival demonstration in its
own PostgreSQL 17 clone. It needs a matching archived snapshot/checkout, the source
reader connection and suitable real evidence, makes no provider calls and leaves
source records unchanged. See the
[replay prerequisites and interpretation](replay.md).

All `test:db`, `test:ingestion`, `test:forecast`, `test:reporting`, `test:auth`,
`test:api`, `test:evaluation`, `test:worker`, `test:source`, `test:ui` and
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
| ER diagram | [Chen ER model](database.md#entity-relationships), [complete domain sheets](relational-schema.md#diagrams-and-export) | Trace rectangles, relationship diamonds, attribute ovals, chosen keys, 1/N ratios, total participation and the weak standings row; compare the conceptual facts with the model-to-relation map |
| Relational schema with keys, relationships and constraints | [ER derivation and complete relation dictionary](relational-schema.md), [horizontal schema diagrams and PDF](relational-schema.md#diagrams-and-export), [`db/migrations`](../db/migrations/) | Follow each ER mapping to its relation, then inspect all 31 relations, 248 columns and 53 ordered FK groups; `npm run test:db` verifies structural/context rules and `npm run demo` rejects an invalid roster-player FK |
| SQL implementation: DDL with constraints | [`scripts/db.ts`](../scripts/db.ts), migrations 001–013 | `npm run test:db` applies the schema fresh, reruns it, rejects altered migration history and invalid records, and verifies failed DDL rolls back; `npm run test:source` verifies the 001–009→010 upgrade preserves existing evidence and routines. Actual setup uses `npm run db:provision` then `npm run db:migrate` |
| NoSQL or vector database creation | [`scripts/mongo.ts`](../scripts/mongo.ts), [`archive.ts`](../src/server/ingestion/archive.ts) | `npm run test:ingestion` provisions MongoDB 8 validators/indexes and its restricted worker identity; `npm run demo` also verifies document collection creation/validation/indexes. This project implements MongoDB, not vector search |
| Technology justification | [Architecture and choices](architecture.md#why-these-technologies) | Explain each component's data/privilege boundary and tradeoff using the diagram, SQL grants, archive permissions and worker flow |
| DML: INSERT, UPDATE and DELETE | [`dml.sql`](../db/demo/sql/dml.sql) | `npm run demo` returns one row for each operation on a separate synthetic player, then verifies rollback restores the sports data |
| Nested, correlated, recursive and JOIN queries | [`queries.sql`](../db/demo/sql/queries.sql) | `npm run demo` checks a club/player JOIN, nested eligible-player selection, correlated counts, latest-five CTE/window query and recursive forecast ancestry; expected rows are documented in [demo](demo.md#executable-examples) |
| Functions/procedures, triggers and CTEs | [`008_reporting.sql`](../db/migrations/008_reporting.sql), [`010_current_coverage.sql`](../db/migrations/010_current_coverage.sql), [`advanced.sql`](../db/demo/sql/advanced.sql) | `npm run demo` runs original history/lineage functions and an idempotent refresh procedure, then proves audit/outbox trigger effects and rollback; `npm run test:reporting` checks original routines, and `npm run test:source` checks current provider-aware overloads and privilege/idempotence boundaries |
| NoSQL features and read/update/delete operations | [`operations.ts`](../db/demo/mongo/operations.ts) | `npm run demo` demonstrates indexed projected reads, `$set`, `$addToSet`, scoped deletion and `$match`/`$unwind`/`$group` aggregation; it leaves three synthetic annotations before dropping only the owned demo collection and verifies source archives are unchanged |
| Next.js interface | [`src/app`](../src/app/), [`src/components`](../src/components/) | Visit `/login`, `/overview`, `/players`, `/players/PLAYER_ID`, `/compare`, `/account` and admin-only `/admin`; Operations is reached through Account settings. `npm run test:ui` exercises actual browser journeys and responsive layouts |
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
| Competition coefficient 2 or 1.5 | [`sources.ts`](../src/server/ingestion/sources.ts), [`engine.ts`](../src/server/forecast/engine.ts), model tests | Only Premier League, Ligue 1, Bundesliga, Serie A and La Liga use 2; both current leagues use 2. Archived second divisions retain 1.5. Formula tests do not enable additional data coverage |
| Position-specific decimal per-90 estimates | [`engine.ts`](../src/server/forecast/engine.ts), [metric table/formula](forecasting.md#context-and-formulas) | Unit tests cover GK/DEF/MID/FWD, reported minutes above 90, valid zero and dependent missing fields; detail/comparison show units and the 90-minute assumption |
| Separate observed statistics, adjusted form and forecast | [`forecast-view.tsx`](../src/components/forecast-view.tsx), [`player-detail.tsx`](../src/components/player-detail.tsx) | Player detail labels rating 0–10, adjusted form 0–100 and per-90 forecasts; disclosures retain exact inputs, provenance, warnings and output-specific reasons |
| Observed player strength for scouting | [`highlights.ts`](../src/server/scouting/highlights.ts), [`best-statistic.tsx`](../src/components/best-statistic.tsx), [scouting rules](forecasting.md#observed-scouting-statistics) | Cards show Best statistic above Evaluation details; profiles show the same highlight. Rank the exact five-match per-90 rate against at least ten eligible same-position/league/season players, including the subject; only percentile ≥80 earns Top 20%. Unit/source/browser tests cover ties, zeros, missing evidence and display |
| Player-to-player comparison | [`read.ts`](../src/server/api/read.ts), [`comparison.tsx`](../src/components/comparison.tsx), [comparison API](api.md#viewer-reads) | Compare 2–4 players at one cutoff/source snapshot. Default same-position; explicit cross-position opt-in shows a notice and shared metric intersection. `npm run test:api`/`test:ui` verify alignment; comparison creates no saved revision |
| Honest unavailable/incomplete/stale/loading/error states | [`forecast-presentation.ts`](../src/lib/forecast-presentation.ts), [`use-api.ts`](../src/lib/use-api.ts), forecast/API/browser tests | Missing evidence blocks dependent outputs; form-only is distinguishable from a future forecast. Tests exercise null versus zero, expired targets, source changes, permission/session/service failures and asynchronous states |
| Free, bounded, provenance-backed source ingestion | [`sorare-client.ts`](../src/server/ingestion/sorare-client.ts), [`sorare-normalize.ts`](../src/server/ingestion/sorare-normalize.ts), [`sorare.ts`](../src/server/ingestion/sorare.ts), [`sources.ts`](../src/server/ingestion/sources.ts), [ingestion](ingestion.md) | Registered free access to current Premier League/La Liga statistics was verified on 2026-11-10. `npm run test:unit`/`test:source` verify allowlisting, native IDs, shared 60-attempt rolling-minute budget with one-second spacing, paginated capture completeness, archive-first recovery and nullable normalization; tests require no provider key |
| Administrator recovery and numeric corrections | [`admin.ts`](../src/server/api/admin.ts), [`admin-correction.tsx`](../src/components/admin-correction.tsx), [operations API](api.md#administrator-operations) | `/admin` exposes job/import/audit status, queued commands and revision-checked corrections; `npm run test:api` covers 403/409, idempotency, actor audit and manual provenance. Corrections cannot invent participation/membership/finality |
| Responsive, accessible navigation and evidence | [`accessibility.browser.test.ts`](../tests/accessibility.browser.test.ts), [`interface.browser.test.ts`](../tests/interface.browser.test.ts) | `npm run test:ui` and `npm run test:accessibility` check keyboard focus, labels, feedback, disclosures, touch targets and layouts at 390/768/1440 pixels. This is scoped automated/manual review, not a claim of exhaustive assistive-technology conformance |
| Explain measured performance and coverage | [`src/server/evaluation`](../src/server/evaluation/), [evaluation protocol/result](evaluation.md) | `npm run evaluate --silent` reads an archived APIFootball snapshot using the fixed historical protocol without writes; reproduction needs the matching archived checkout/snapshot. Published dated result is **0/2,596 scored**, with `null` errors. `npm run test:evaluation` uses synthetic positive cohorts to verify paired scoring/cutoffs/leakage boundaries; it does not measure current Sorare accuracy |
| Preserve predictions for later real-outcome scoring | [`measure.ts`](../scripts/measure.ts), [`prospective.ts`](../src/server/evaluation/prospective.ts), [archived forward protocol](evaluation.md#forward-measurement) | Under the archived APIFootball protocol/prerequisites, `npm run measure --silent -- capture ./forecast-capture.json`, then later `npm run measure --silent -- score ./forecast-capture.json`. Reader-only, immutable private 0600 capture before local matchday midnight; pending outcomes supply no measured accuracy. Existing captures retain their original source identity |

## Evidence limits

The archived APIFootball historical window is October 1–November 9, 2026. No actual roster
observation preceded any holdout cutoff, so later roster imports cannot supply
historical forecast evidence. The zero-scored result and unavailable error
statistics remain part of the deliverable. Forward captures supplement that
result; only finalized real outcomes and available paired cases can produce a
future measured score. Private captures and original provider payloads are not
published. Current Sorare rating/form/key-pass outputs remain unavailable without
matching source metrics; fantasy scores are not conventional ratings. Supported
count projections and observed scouting statistics can be available when their
own evidence is complete. No measured current-source accuracy is established.

## Verification record

Before the current-source migration, on **2026-11-10**, the then-documented combined
integration recipe and service-free unit suite passed **329 tests with no failures or skips** using isolated
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

These live interface snapshots were captured on **2026-11-12**, between
**12:12:16 and 12:12:27 UTC**, using imported Premier League and La Liga data.
They include the current navigation, hidden-results filter and scouting statistic.
Displayed values were checked against the exact API responses used by the browser;
player and comparison arithmetic was independently recomputed from recorded inputs.
Counts, worker state and forecasts can change after capture. Sign in to an
application configured through the [setup guide](../README.md) to inspect current
data. The [UI test prerequisites](ingestion.md#isolated-integration-tests) and
`npm run test:ui` reproduce the journeys using isolated synthetic test data.

| Screen | Example | What to inspect |
| --- | --- | --- |
| `/overview` | [Overview](screenshots/overview.png) | 1,402 players, 40 clubs, two leagues; 386 ready and 79 partial saved results |
| `/players/PLAYER_ID` | [Player detail](screenshots/player.png) | Kylian Mbappé's observed best statistic, separate form/forecast and exact five-match window |
| `/compare` | [Comparison](screenshots/comparison.png) | Mbappé and Lamine Yamal at one shared cutoff, observed ratings and populated outputs with aligned units |
| `/admin` | [Administration](screenshots/administration.png) | Actual application budget, coverage, committed imports, job history and correction controls |

The player screenshot shows a 7.98/10 forecast rating and 59.86/100 adjusted form
index. Its observed best statistic is 12 shots on target across 443 minutes
(2.44 per 90); its projected shots-on-target rate is separately shown as 2.17 per
90 minutes. Comparison shows Yamal's 8.21/10 forecast and 61.56/100 form index,
alongside both players' five observed match ratings. Mbappé's zero assists is an
observed zero and remains a numeric zero in the projection. Administration was
captured through reads only; no imports, retries, refresh jobs or corrections were
submitted for these images. Missing history and genuine freshness warnings remain
subject to the normal application rules; no output or image was fabricated.

The offline database demo uses clearly labeled synthetic football data to make
SQL/NoSQL behavior repeatable. The separate [real-data replay](replay.md) uses
archived observed records in a disposable clone and a fixed present cutoff. Neither
demonstration establishes provider completeness or predictive accuracy.
Interactive football availability depends on the actual imported evidence and
worker progress. Preserve these distinctions when demonstrating the application.
