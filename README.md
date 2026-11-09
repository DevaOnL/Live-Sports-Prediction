# Live Sports Prediction

A football player analysis project built around five qualifying league appearances,
with opponent strength and competition context informing an explainable forecast.

The application provides a responsive preview and a recoverable football-data
worker backed by PostgreSQL and MongoDB. Imports preserve source responses, normalize
fixtures and player statistics, reconstruct historical standings, and save
explainable player forecasts with immutable input evidence. Comparisons and
application login remain future work. The web interface remains a preview;
forecasts are currently available through the operational CLI.

## Requirements

- Node.js 24 and npm 11
- Docker with Docker Compose

## Run locally

```bash
npm ci
cp .env.example .env
```

Replace all placeholder passwords in `.env` with independent random values of at
least 16 characters.
Keep that file local and ignored by Git. Leave `INGESTION_ENABLED=false` to run the
preview and idle worker without a football API credential.

```bash
docker compose config --quiet
docker compose up --build -d --wait
```

Open <http://localhost:3000>. PostgreSQL and MongoDB bind to loopback ports 5432
and 27017. The worker health listener is internal on port 4001. The app
process receives no database credentials. An enabled worker receives only the
restricted PostgreSQL writer and MongoDB ingestion credentials. Health endpoints
report process liveness; database health is checked separately with authentication.

```bash
docker compose ps
docker compose stop
```

Named volumes preserve database data when containers are stopped or replaced.
Database initialization occurs only on empty volumes; editing `.env` does not
rotate an existing database password. A normal `docker compose down` retains
volumes. Deleting volumes destroys their stored data.

## Set up the relational database

With PostgreSQL running, provision its restricted logins and apply the migrations:

```bash
npm run db:provision
npm run db:migrate
```

Provisioning creates or updates the reader, writer, authentication, and migration
logins using the local password variables. Migration files run in order, each in
its own transaction, and their checksums are recorded. Rerunning the migration
command verifies the applied history and applies only new files. Apply upgrades
explicitly with these commands while preserving existing volumes; never edit an
already-applied migration.

The [database guide](docs/database.md) documents the ER diagram, relational
constraints, role grants, migration behavior, and an isolated PostgreSQL test
recipe. Database tests create temporary databases and require a verified disposable
cluster. Run them only using that recipe or the dedicated CI service.

## Import covered football data

Use APIFootball.com's permanent free plan and put its API key in the local `.env`
as `APIFOOTBALL_API_KEY`. Provision the restricted MongoDB identity after both
database services are healthy:

```bash
npm run mongo:provision
```

Set `INGESTION_ENABLED=true` locally, then run an initial import and queued detail
work. These commands use the restricted runtime identities:

```bash
npm run ingest -- sync
npm run ingest -- once
npm run ingest -- status
```

Recreate the worker after changing its environment with
`docker compose up -d --build worker`. The enabled worker polls every 15 minutes,
shares a 120-request rolling-hour budget with the CLI, and processes durable jobs.
The initial backlog may take several request windows. Read the
[ingestion guide](docs/ingestion.md) for coverage, missing-data behavior, recovery,
and isolated PostgreSQL/MongoDB verification.

## Calculate forecasts

Apply pending migrations before starting an upgraded worker. Existing imports
can recover their latest roster observations from archived data without provider
requests:

```bash
npm run db:migrate
npm run ingest -- reconcile
npm run forecast -- refresh all
npm run forecast -- status
```

Use `npm run forecast -- show PLAYER_ID` with a provider player identifier to
inspect the current result, fixed five-match window, target, missing-data reasons,
and saved provenance. The enabled worker refreshes automatically after canonical
changes and checks target expiry every minute. Calculations need PostgreSQL writer
credentials, with no provider key or MongoDB connection. See the
[forecasting guide](docs/forecasting.md) for formulas and availability rules.

## Development

Stop the app container before running the local development server on port 3000:

```bash
docker compose stop app
npm run dev
```

Run the worker separately with `npm run worker`. With ingestion disabled, it
exposes `GET /health` without database connections or jobs. With ingestion enabled,
it runs imports and queued processing. Web health is available at `GET /api/health`.

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

The lockfile pins npm dependency versions. GitHub Actions runs installation, lint,
type checking, and the production build without database or API credentials. A
separate job verifies migrations, constraints, ingestion, forecast persistence,
and refresh processing against disposable PostgreSQL 17 and MongoDB 8 services.

## Methodology

The analysis uses the latest five finalized appearances with at least
60 reported minutes each. A shorter appearance leaves that window unchanged.
Opponent and own-team strength provide context for an overall rating and selected
position-specific statistics. Counts represent decimal estimates under a
90-minute playing-time assumption. Missing data must remain distinct from zero.

Data coverage is restricted to regular-season Championship (153) and Ligue 2
(164), 2026/27, using APIFootball.com's permanent free plan. Free-plan availability
can change; missing source data remains explicit. Forecasts are fixed heuristic
estimates, with no established predictive accuracy or calibrated probability.

## Technology

Next.js and TypeScript provide the web interface and a shared language for server
and worker code. PostgreSQL stores canonical relational records and enforces
constraints; MongoDB stores immutable source archives and separate import metadata.
Docker Compose provides a reproducible local environment with persistent database
volumes. Inter is
self-hosted through the application bundle.
