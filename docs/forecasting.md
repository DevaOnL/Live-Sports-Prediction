# Player forecasts

The fixed `heuristic-v1` model estimates a next-match rating and selected
position-specific statistics. It has no established predictive accuracy. Model
outputs, observed player statistics, and the adjusted form index are separate
quantities.

## Run and inspect

Apply all pending migrations explicitly, then recover existing roster evidence:

```bash
npm run db:migrate
npm run ingest -- reconcile
npm run forecast -- refresh all
npm run forecast -- status
npm run forecast -- show PLAYER_ID
```

Replace `PLAYER_ID` with the APIFootball.com player identifier. A single-player
refresh uses `npm run forecast -- refresh PLAYER_ID`. Unknown identifiers return
zero refreshed players or `null` when shown. The forecast CLI requires only the
PostgreSQL writer connection; it makes no provider requests and does not connect
to MongoDB. Reconciliation separately requires both database runtime identities.
These commands do not expose web forecast routes or a login flow.

The enabled worker processes canonical, standings and roster events and checks
time every minute. It coalesces pending changes into one durable refresh, retaining
changes that arrive while it runs for a later refresh. Forecasts run locally even
when source-detail jobs are deferred by the shared provider budget. Database
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
conflicting newest evidence blocks target selection. Roster observation times
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

The adjusted form index and displayed forecast rating both use 0–100, with
different meanings. Form can remain available when no next fixture is known.
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

Each batch reads canonical data under the ingestion transaction lock, giving
all players a common cutoff and source ordinal. An immutable revision saves
the model version, full input, result, missing-data explanations and provenance.
Provenance includes the historical roster observations used to scope missing matches.
Historical context is reconstructed directly so a queued standings rebuild cannot
silently leave stale inputs. A separate mutable head points to the current result.

SHA-256 hashes cover semantic model evidence, including relevant short/DNP and
gap evidence and current target/context. Wall-clock ticks, random SQL identifiers,
and unrelated global revision increments do not create a revision. Identical
inputs retain the existing revision and its original cutoff; that time is the
saved observation time, not an assertion that the worker has stopped checking.
A correction from A to B and back to A appends a third revision with a parent
link. Runtime roles cannot update/delete saved revisions. Forecast audit entries
do not emit canonical events or cause a refresh feedback loop.

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
separate PostgreSQL/MongoDB ingestion suite. No provider credential is needed.
