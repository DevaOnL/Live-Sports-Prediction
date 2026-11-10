# Player forecasts

The fixed `heuristic-v1` model estimates a next-match rating and selected
position-specific statistics. It has no established predictive accuracy. Model
outputs, observed player statistics, and the adjusted form index are separate
quantities.

## Run and inspect

First provision the databases and apply pending migrations using the
[database guide](database.md#provisioning-and-migrations). On an existing import,
recover interrupted work and project the latest archived roster evidence:

```bash
npm run db:migrate
npm run ingest -- reconcile
```

Migration uses the controlled migrator credentials. Offline reconciliation uses
the SQL writer and MongoDB runtime identities, preserving original roster
observation times; it does not fetch missing evidence from the provider. Once
those prerequisites are ready, the forecast commands need only the SQL writer:

```bash
npm run forecast -- refresh all
npm run forecast -- status
npm run forecast -- show PLAYER_ID
npm run forecast -- history PLAYER_ID
npm run forecast -- lineage PLAYER_ID
npm run forecast -- request
```

Replace `PLAYER_ID` with the APIFootball.com player identifier. A single-player
refresh uses `npm run forecast -- refresh PLAYER_ID`. Unknown identifiers return
zero refreshed players or `null` when shown. The forecast CLI requires only the
PostgreSQL writer connection; it makes no provider requests and does not connect
to MongoDB. Reconciliation separately requires both database runtime identities.
`history` accepts an optional ISO-8601 cutoff and lists eligible candidates; it
does not establish that source history is complete. `lineage` follows the current
head backward through its immutable parents. `request` enqueues an all-player
refresh for the enabled worker; reusing its optional UUID is idempotent. These
commands are local operational tools and do not authenticate a web session.

Signed-in viewers and administrators can read stored evidence through
`GET /api/players/PLAYER_ID` and `GET /api/players/PLAYER_ID/forecast`.
`GET /api/compare?playerId=ID&playerId=ID` calculates a comparison from the current
canonical database snapshot. The application uses the restricted SQL reader for
these football reads; local forecast CLI commands use the writer. See the
[API guide](api.md) for login, cookie handling, filters and administrator refresh
requests. The player profile shows saved form, forecasts and their evidence; the
comparison screen shows the shared snapshot and matching per-90 statistics.

The enabled worker processes canonical, standings and roster events and checks
time every minute. It coalesces pending changes into one durable refresh, retaining
changes that arrive while it runs for a later refresh. Forecasts run locally even
when source-detail jobs are deferred by the shared provider budget. A separate
five-second local queue loop continues while source requests are in flight. Docker
restarts the worker after a failed startup; health tracks both processing loops. Database
leases, retries and failure inspection use the [ingestion job lifecycle](ingestion.md).

## History, membership and availability

History is restricted to enabled regular-season Championship (153) and Ligue 2
(164), 2026/27. Select the latest five finalized appearances strictly before the
cutoff, ordered by kickoff UTC then provider fixture identifier. Each requires
known participation and fixture club membership and at least 60 reported minutes.
Preserve minutes above 90. Every new eligible appearance replaces the oldest,
regardless of performance. A confirmed shorter appearance or DNP leaves the five
unchanged but still refreshes context and the next target.

Current clubs require separate roster observations. Historical appearances do
not establish a current club or continuous tenure. The latest complete roster
can invalidate an earlier association by omitting the player; incomplete or
conflicting newest evidence in a relevant season blocks target selection.
A season is relevant only when this player has pre-cutoff appearance or
roster-inclusion evidence there. An unrelated league's missing/empty roster
cannot contradict a confirmed club. Appearance evidence establishes relevance,
not current membership. Roster observation times
are never backdated. Conflicting observations at the same time remain ambiguous;
random database identifiers do not choose a winning club. Explicit appearance and roster club checkpoints scope
possible missing matches, with a confirmed new club closing former-club risk
from that checkpoint onward. Absence from a lineup or statistics response is
never synthesized as DNP.

Unknown ordering or eligibility that could change the selected five produces
`incomplete_history` and blocks all outputs. Complete history with fewer than
five qualifying appearances produces `insufficient_history`. Missing statistics
on the fixed five block only dependent outputs; numeric zero remains valid.
Missing ratings can leave per-90 outputs available. Unknown position permits
rating/form but no position-specific projections. Every unavailable output has
machine-readable reasons, including affected fields and fixtures where known.
Source gaps are retained even when a fixture reports complete statistics.

| Reason | Interpretation / next step |
| --- | --- |
| `incomplete_history` | Unknown participation, membership, ordering or a relevant missing appearance could alter the five; inspect the named source gaps and import genuine correcting evidence |
| `insufficient_history` | Fewer than five confirmed eligible covered appearances; a short appearance or DNP cannot fill the window |
| `missing_metric` | One of the fixed five lacks a required field; only dependent outputs are blocked |
| `missing_roster_observation`, `incomplete_roster_observation`, `ambiguous_current_club`, `unknown_current_club` | Current club is unconfirmed at this cutoff; a later roster cannot repair an earlier historical cutoff |
| `missing_standings_context`, `incomplete_standings_context` | Schedule or earlier results cannot establish reliable weighting; inspect context reasons |
| `no_future_fixture` | No covered scheduled future target for the confirmed club; historical form can still be available |

Refreshing re-evaluates existing canonical evidence. It cannot manufacture missing
appearances, metrics or earlier roster observations. Historical evaluation and
the separate forward-measurement protocol are documented in
[evaluation.md](evaluation.md).

## Context and formulas

Historical context reconstructs corrected canonical results at 00:00 on each
fixture's local matchday, using strictly earlier local dates. Championship uses
Europe/London and Ligue 2 uses Europe/Paris. A future target uses already observed
final results, including same-day finals before the forecast cutoff. Both require
the full covered season schedule and valid result context. Reconstruction uses
competition-specific tie rules and the recorded Southampton points deduction.
It does not claim to reproduce tables as originally published.

For `N` clubs, rank `r` has strength +1 when `100r <= 35N`, 0 through `70N`, and
−1 otherwise. An unresolved tied rank interval crossing a tier boundary uses
neutral strength 0 and records a warning; a tie wholly within a tier retains that
tier. Define `z = opponent strength − own strength` and `D = 1 + 0.1z`.

The competition coefficient `C` is 2 only for Premier League, Ligue 1,
Bundesliga, Serie A and La Liga. All other competitions use 1.5, including both
currently covered leagues. Implemented coefficients do not enable extra coverage.

For the fixed five provider ratings `r_i`:

```text
F = sum(r_i × D_i × C_i) / 5
adjustedFormIndex = 100 × F / 24
forecastRating = clamp(F / (D_next × C_next), 0, 10)
displayedForecastRating = 10 × forecastRating
```

The website shows `forecastRating` on a 0–10 scale and the separate
`adjustedFormIndex` on a 0–100 scale. The legacy API field
`displayedForecastRating` remains `10 × forecastRating` on a 0–100 scale; the
website does not display that field. Form can remain available when no next
fixture is known. The fixed normalizer is `24 = 10 × 1.2 × 2`; with the two
approved leagues' coefficient of 1.5, the form index can reach at most 75 on that
0–100 scale. It is neither a percentile nor a probability or accuracy percentage.
Select the earliest scheduled future fixture for the known current club within
enabled coverage. Live, final, cancelled, postponed and unknown fixtures are
excluded. Once kickoff passes, the old fixture is no longer a future target.

| Position | Projected statistics |
| --- | --- |
| Forward | Goals, assists, shots on target |
| Midfielder | Assists, key passes, tackles |
| Defender | Tackles, interceptions |
| Goalkeeper | Saves, goals conceded |

For each relevant count metric on the same five appearances:

```text
w_i = C_i / (1 + abs(z_i − z_next))
projected90 = 90 × sum(w_i × count_i) / sum(w_i × reported_minutes_i)
```

These are decimal estimates under a 90-minute playing-time assumption. They do
not predict minutes played and are not guaranteed event counts or probabilities.
The denominator preserves reported extra minutes.

## Stored evidence and replay

Each persisted refresh batch reads canonical data under the ingestion transaction
lock, giving all players a common cutoff and source ordinal. An immutable revision saves
the model version, full input, result, missing-data explanations and provenance.
Provenance includes the historical roster observations used to scope missing matches.
Historical context is reconstructed directly so a queued standings rebuild cannot
silently leave stale inputs. A separate mutable head points to the current result.

SHA-256 hashes cover semantic model evidence, including relevant short/DNP and
gap evidence and current target/context. Wall-clock ticks, random SQL identifiers,
and unrelated global revision increments do not create a revision. Identical
inputs retain the existing revision and its original cutoff; that time is the
saved observation time. `show().evaluation` records the latest successful check
cutoff, source ordinal, provenance, and `checkedAt`, even when the semantic input
hash is unchanged. The top-level cutoff and evidence remain those of the immutable
revision. Apply `007_forecast_freshness.sql` before using this envelope; existing
heads are backfilled from their revisions.
A correction from A to B and back to A appends a third revision with a parent
link. Runtime roles cannot update/delete saved revisions. A changed head invokes a transactional database trigger that writes one
`forecast.refresh` audit entry and one `forecast.updated` notification. Freshness-only
updates emit neither. These notifications are separate from canonical events and
do not cause a refresh feedback loop. See the [database demonstrations](demo.md)
for reporting functions, refresh requests and their privilege boundaries.

API catalogue availability and overview counts describe the last stored
model evaluation, including both historical form and future-match outputs.
`available` requires a known position and every expected output; `partial` means
at least one output is available but full model requirements are unmet (possibly
form only). `unavailable` means none are available.
`uncomputed` means there is no saved evaluation. A partial model result does not
establish that any future-match forecast is available. Catalogue summaries label
this `kind: "stored-evaluation"` and include
`evaluationCutoffAt`, `checkedAt` and the evaluation source ordinal. A forecast
response additionally includes the current read's `source.cutoffAt` and source
watermark. Reading a saved forecast does not recalculate it: its target may have
expired or source inputs may have changed while a worker refresh is pending.
Equal source ordinals alone cannot establish freshness because time can change
target eligibility without changing source data. Retain the separate revision,
evaluation and response dates when displaying saved results.

Comparisons are explicitly `kind: "transient-comparison"`. Two to four distinct
players share one UTC cutoff and source ordinal in a repeatable-read, read-only
snapshot. The default requires matching positions. Explicit cross-position
opt-in shows a notice and only the shared per-90 projections, alongside distinct
rating/form outputs. Each player's `canonicalInputHash` and `canonicalStatus`
refer to the full model evaluation before unshared outputs are removed from the
displayed `result`. Its displayed availability can therefore differ from the
canonical status. `storedRevision` separately identifies any previously saved
result; comparison does not create revisions or request provider data.

Administrator metric corrections append manual source/revision and audit
evidence, then request an asynchronous refresh. Older or equal-time provider
archives skip the protected fixture, including header changes and omitted player
rows, while retaining import evidence and a
`superseded_by_manual_correction` issue. The correction history preserves that
protection after a strictly newer provider observation becomes current. A later
provider observation may supersede the manual values; prior revisions and the
reason/actor audit remain available. Provider archives are never edited.
An archive already superseded by a newer observation of the same action/resource
can instead be rejected earlier with `superseded_archive`.

## Verification

`npm run test:unit` checks formulas and model boundaries without services.
`npm run test:forecast` checks canonical loading, transfers, revisions, permissions,
coalescing, concurrent dispatch, retries and provider-budget isolation using a
disposable PostgreSQL 17 cluster. It requires the same guarded `_test` database,
`NODE_ENV=test` and exact `POSTGRES_TEST_CLUSTER_ID` described in the
[database test recipe](database.md#isolated-integration-tests). Run the forecast
suite after `npm run test:db` inside that recipe's subshell, before cleanup. The
suite clears only the verified test cluster's application tables and uses synthetic
data; it must never run against a demo or shared cluster. CI runs it after the
separate PostgreSQL/MongoDB ingestion suite. `npm run test:api` additionally checks
stored/read date distinctions, catalogue filtering, shared comparison projections,
reader permissions, correction replay protection and built-server authorization.
It requires a production build and the guarded PostgreSQL/MongoDB environment in
the [combined integration recipe](ingestion.md#isolated-integration-tests).
No provider credential is needed.
