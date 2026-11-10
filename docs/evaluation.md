# Retrospective evaluation

The fixed `heuristic-v1` model has no established predictive accuracy. The frozen
real-data evaluation scored **0 of 2,596 eligible target appearances (0% coverage)**.
Historical roster observations were unavailable at every target cutoff. MAE and
median absolute error are therefore **unavailable (`null`)** for the heuristic and
all paired baselines. These results do not establish whether one method is better.

## Fixed protocol

The holdout is **2026-10-01 through 2026-11-09**, inclusive, in each competition's
local calendar: Europe/London for Championship and Europe/Paris for Ligue 2.
Inputs freeze at 00:00 on the target local date. History and standings use only
strictly earlier local dates, also before that shared UTC instant. October's DST
transition and the different London/Paris midnights are respected.

The evaluator uses the existing forecast engine and its exact latest five final
appearances of at least 60 reported minutes. Shorter appearances do not enter the
window; uncertain history, missing metrics and missing pre-cutoff roster evidence
keep dependent outputs unavailable. A realized target appearance never supplies
missing input club membership. The model must select that same target fixture;
otherwise the case is excluded.

Target eligibility requires a final match, known fixture membership, played status
and at least 60 reported minutes. The denominator includes eligible appearances
whose target metric is missing; output coverage therefore cannot improve by
silently dropping missing values. Whole matches with no appearance rows and
undated fixtures are reported separately because their missing player population
cannot be counted from observed appearances. Exclusion reasons are nonexclusive.

Only approved 2026/27 regular-season competitions 153 and 164 are included. The
holdout, formulas and baselines are fixed; the command has no tuning arguments.
Canonical positions, fixture headers and results are retrospectively corrected.
Future results and target appearances are hidden from model history. Corrected
schedule metadata and historical outcomes were retrieved later, so this is a
retrospective evaluation, not a replay of what the provider published at the time.
Roster evidence still requires its actual observation timestamp before the freeze.

## Paired outputs and baselines

For each output, all methods score the identical cases with complete required
inputs and an available model output. Ratings use the continuous 0–10 forecast,
not its rounded display. Statistics use decimal events per 90 minutes, including
reported minutes above 90. Null values remain missing; an observed zero is valid.

| Output | Actual value | Frozen simple baseline | Additional baseline |
| --- | --- | --- | --- |
| Rating | Provider rating, 0–10 | Mean of the five provider ratings | — |
| Position-specific statistic | `90 × target count / target minutes` | Mean of the five individual `90 × count / minutes` rates | `90 × sum(count) / sum(minutes)` |
| Forward goals | As above | As above | Constant zero, alongside the pooled baseline |

Available metrics follow the model: forwards use goals, assists and shots on
target; midfielders use assists, key passes and tackles; defenders use tackles and
interceptions; goalkeepers use saves and goals conceded. Every position also has
a rating. The JSON report includes eligible counts, actual-value availability,
scored counts, coverage, exclusions, MAE and median absolute error for each output,
position and league, plus aggregate cohorts. With zero scored cases, both error
statistics are `null`; with no eligible cases, coverage is also `null`.

## Observed real-data result

Snapshot: **2026-11-10 09:30 UTC**, normalized source ordinal **46708**, latest
source retrieval **2026-11-09 15:00 UTC**. Across 130 final holdout fixtures,
5,184 observed appearance rows included 2,596 eligible targets. No holdout final
was entirely missing appearance rows, and no covered fixture had an unknown
kickoff. Partial match statistics still represent uncertainty; a match having
some appearance rows does not establish a complete lineup.

| League | Final fixtures | Complete / partial statistics | First roster observation (UTC) |
| --- | ---: | ---: | --- |
| Championship | 85 | 12 / 73 | 2026-11-09 10:04:41 |
| Ligue 2 | 45 | 7 / 38 | 2026-11-09 10:04:46 |

Both first roster observations occur after the final holdout midnight. All 2,596
eligible rating targets consequently have `missing_roster_observation`; additional
history and participation exclusions can overlap. There are 2,587 observed rows
below 60 minutes and one with missing minutes; 1,150 also have a non-played status.
These counts describe observed rows, not the unknowable number of absent players.

| Output, all leagues/positions | Eligible targets | Scored | Coverage | Heuristic and paired-baseline MAE / median error |
| --- | ---: | ---: | ---: | --- |
| Rating | 2,596 | 0 | 0% | unavailable / unavailable |
| Goals | 567 | 0 | 0% | unavailable / unavailable |
| Assists | 1,365 | 0 | 0% | unavailable / unavailable |
| Shots on target | 567 | 0 | 0% | unavailable / unavailable |
| Key passes | 798 | 0 | 0% | unavailable / unavailable |
| Tackles | 1,777 | 0 | 0% | unavailable / unavailable |
| Interceptions | 979 | 0 | 0% | unavailable / unavailable |
| Saves | 252 | 0 | 0% | unavailable / unavailable |
| Goals conceded | 252 | 0 | 0% | unavailable / unavailable |

For every row below, all listed outputs have zero scored cases, 0% coverage,
and unavailable heuristic and paired-baseline MAE/median error.

| League | Position | Eligible targets per output | Outputs |
| --- | --- | ---: | --- |
| Championship | GK | 162 | rating, saves, goals conceded |
| Championship | DEF | 613 | rating, tackles, interceptions |
| Championship | MID | 518 | rating, assists, key passes, tackles |
| Championship | FWD | 371 | rating, goals, assists, shots on target |
| Ligue 2 | GK | 90 | rating, saves, goals conceded |
| Ligue 2 | DEF | 366 | rating, tackles, interceptions |
| Ligue 2 | MID | 280 | rating, assists, key passes, tackles |
| Ligue 2 | FWD | 196 | rating, goals, assists, shots on target |

## Run and verify

After migration and ingestion, configure `POSTGRES_HOST`, `POSTGRES_PORT`,
`POSTGRES_DB` and `POSTGRES_READER_PASSWORD` in the ignored local `.env`, then run:

```bash
npm run evaluate --silent > evaluation.json
```

The output is aggregate JSON only. Keep the generated file local; it is ignored
by default. The evaluator uses `lsp_reader` in one repeatable-read, read-only SQL
transaction. It makes no provider calls, needs no MongoDB or writer credentials,
and never updates live forecast heads, revisions, jobs or source records. A later
run can differ as canonical evidence changes; the dated result above describes
its recorded source snapshot.

`npm run test:unit` includes synthetic paired-scoring checks for formulas, units,
missing/zero values, all positions and chronological guards. Against an owned
disposable PostgreSQL 17 cluster following the [database test recipe](database.md),
`npm run test:evaluation` verifies positive scoring, unchanged SQL records, outcome
leakage protection, missing rosters, fixture gaps, timezone boundaries and DST.
Synthetic errors verify calculation correctness and are not real accuracy results.

With the additional guarded MongoDB 8 service from the
[ingestion test recipe](ingestion.md) and a preceding `npm run build`, run
`npm run test:worker` for actual-process crash, lease, stalled-source and archive
recovery checks. Its provider transport and clock are controlled only by a test
preload; real timers and database leases still run. It cannot contact the provider.
Run `npm run test:accessibility` after installing Chromium as described in the
README. Those checks exercise keyboard login, visible focus contrast, expanded
filters/evidence/admin tables, asynchronous feedback and 44px targets at 390, 768
and 1440 pixels. The browser blocks external requests. These checks supplement
manual review; they do not establish exhaustive assistive-technology conformance.
