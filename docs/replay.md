# Real-data sixth-appearance replay

`npm run replay` demonstrates how a newly available eligible appearance changes
the selected five and creates a refreshed forecast revision. It reads a current
canonical snapshot and performs the demonstration in a disposable PostgreSQL 17
clone. Use genuine imported football records for the real-data demonstration;
[`npm run demo`](demo.md) provides a separate synthetic seed.

This is a **present-cutoff data-arrival demonstration**. The sixth appearance is
already historical when the snapshot is read. Its fixture stays final throughout
the exercise; only that player's appearance row is temporarily withheld in the
clone. The initial result must therefore report incomplete history. It is not a
forecast known to have been issued before that match.

## Run

Use Node.js 24, npm 11, the committed lockfile and a Linux Docker engine capable
of running `postgres:17-alpine`. Docker may need network access to obtain the
image. The command makes no football provider calls and needs no MongoDB service,
provider key, web session or authentication database credentials.

Configure these source connection settings in the ignored local `.env`:

- `POSTGRES_HOST` and `POSTGRES_PORT` (defaults: `127.0.0.1`, `5432`)
- `POSTGRES_DB` (default: `sports`)
- `POSTGRES_READER_PASSWORD`, for the restricted `lsp_reader` login

The source must already contain the approved schema and genuine imported
football evidence. Follow [setup](../README.md) and
[ingestion](ingestion.md) if it is empty; the replay itself never imports data.

```bash
npm ci
npm run replay --silent
```

The command accepts no arguments. It fails rather than fabricating a case when
the snapshot has no suitable player with six eligible appearances and sufficient
evidence for the final model outputs. Each run selects from its own snapshot, so
later imports or the passage of time can change the selected player, target or
availability.

## What the command verifies

The implementation is [`scripts/replay.ts`](../scripts/replay.ts). A successful
run checks the following sequence:

1. Read approved canonical football, roster and provenance records using
   `lsp_reader` in one repeatable-read, read-only transaction. Keep the source
   identifiers, actual observation times and fixed present evaluation cutoff.
2. Create a fresh PostgreSQL 17 container with temporary in-memory storage,
   random credentials and an automatically assigned loopback port. Verify its
   ownership, system identifier and empty database before provisioning and
   applying the unchanged migrations.
3. Clone the captured records, withholding exactly the chosen player's latest
   eligible appearance. Evaluate the prior five with the real final fixture
   still present. The missing appearance must produce `incomplete_history` and
   unavailable outputs; selected candidate rows alone do not prove complete
   history.
4. Restore the exact captured appearance and enqueue a local demonstration event.
   Process it through the normal `JobQueue` and `ForecastStore`. The new sixth
   enters the window, its prior oldest appearance leaves, and a new immutable
   revision follows the baseline revision.
5. Compare the refreshed semantic input hash and complete result with the
   untouched source snapshot's calculation at the same cutoff. Verify repeat
   refresh is idempotent, audit/outbox effects agree, and the reader cannot write.

Output is a compact JSON report labeled `historical-arrival-replay-v1`,
`observed-canonical` and `present-cutoff-data-arrival`. The label describes the
input format; the command cannot independently attest a database's real-world
origin. Inspect the source/cutoff, player and withheld fixture identifiers,
withheld kickoff and separate future target, before/after revision IDs and input
hashes, the new revision's parent, selected fixture IDs, history/output states
and verification flags. Raw provider payloads, full model
inputs, credentials and source database dumps are not printed or saved.

## Dates and interpretation

The evaluation cutoff is the present snapshot time. Historical kickoffs identify
the observed appearances; roster observations retain the dates on which they
were actually retrieved. No roster or source record is backdated. Both replay
states use the same cutoff, so the change measures arrival of the withheld row
rather than a later evaluation clock.

The forecast after restoration targets the earliest eligible future scheduled
fixture for the confirmed current club at capture. That target is separate from
the restored sixth appearance. Historical standings still use their documented
competition-local matchday cutoffs. See [forecast rules](forecasting.md).

The exercise verifies selection, missing-data handling, queued refresh and saved
revision behavior on real records. It supplies no prediction for the already
played sixth match and no predictive accuracy measurement. The frozen historical
evaluation remains **0/2,596 scored**, with unavailable errors because genuine
pre-cutoff roster evidence is absent. [Forward measurement](evaluation.md#forward-measurement)
requires its own timely private capture and later real outcomes.

## Dated real-data verification

On **2026-11-10**, the command passed against the application's imported football
records. Its two selected windows each contained five appearances with four in
common: the prior oldest left and the sixth entered. The baseline correctly
reported incomplete history; restoring the exact observation produced an
available forecast in a new child revision matching the untouched snapshot.
Provenance/time preservation, idempotence, role restrictions, queue/audit effects
and owned-container cleanup passed with zero provider requests. This is an
operational replay result, not a forecast accuracy result.

## Isolation and reruns

All demonstration writes use fresh credentials in the owned clone. The source
connection remains reader-only; existing containers and named volumes are not
used for demonstration writes. No snapshot file or provider archive is published.

Normal completion, handled failures and handled interrupts remove only the exact
owned container. A subsequent run creates a new clone. An uncatchable host or
process failure may leave a container named `lsp-replay-pg-*` behind; inspect its
`live-sports-historical-replay` ownership label and creation time before removing
that exact container. If Docker cleanup cannot complete, the command fails
instead of reporting successful removal. Existing application volumes are never
replay cleanup targets.
