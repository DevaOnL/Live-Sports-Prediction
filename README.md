# Live Sports Prediction

A football player analysis project built around five qualifying league appearances,
with opponent strength and competition context informing an explainable forecast.

The application provides database-backed sign-in, authenticated football APIs,
player comparison, administrator operations, and a recoverable data worker.
Imports preserve source responses, normalize fixtures and player statistics,
reconstruct historical standings, and save forecasts with immutable input
evidence. The website includes an overview, searchable player catalogue, detailed
forecast evidence, player comparisons, and restricted administrator operations.
The image-led interface uses locally served football photography and generic
position artwork, with detailed evidence available in expandable sections.
Photographs are illustrative; asset sources and licenses accompany the files.

## Requirements

- Node.js 24 and npm 11
- Docker with Docker Compose

## Run locally

```bash
npm ci
cp .env.example .env
```

Replace all placeholder database passwords in `.env` with independent random
values of at least 16 characters. Set `BETTER_AUTH_SECRET` to an independent
random value of at least 32 characters; `openssl rand -hex 32` generates one.
Keep that secret stable across restarts. Keep `.env` local and ignored by Git.
`AUTH_BASE_URL` is the exact browser origin, initially `http://localhost:3000`;
HTTPS is required for non-loopback origins. Leave `INGESTION_ENABLED=false` until
ingestion is configured. Login and stored-data reads need no football API key.

```bash
docker compose config --quiet
docker compose up -d --wait postgres mongo
```

PostgreSQL and MongoDB bind to loopback ports 5432 and 27017. Provision SQL and
create local users below before starting the app. The Compose app receives only
the authentication secret and restricted PostgreSQL reader/writer/auth credentials.
The enabled Compose worker receives writer/MongoDB ingestion credentials and the
provider key. Neither app nor worker receives bootstrap or migrator credentials.

```bash
docker compose ps
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
command verifies the applied history and applies only new files. Apply schema
upgrades explicitly with `npm run db:migrate` while preserving existing volumes;
never edit an already-applied migration. Rerun provisioning only for deliberate
role setup or password rotation.

Existing installations must apply `009_auth_rate_limit.sql` before using web
sessions. Preserve their volumes and applied migration files.

The [database guide](docs/database.md) documents the ER diagram, relational
constraints, role grants, migration behavior, and an isolated PostgreSQL test
recipe. Database tests create temporary databases and require a verified disposable
cluster. Run them only using that recipe or the dedicated CI service.

## Create users and start the app

Create viewer and administrator accounts with the local migrator CLI. Passwords
are accepted through stdin and must contain 12–128 characters. For example, in
Bash:

```bash
read -rs -p 'Viewer password: ' account_password
printf '%s\n' "$account_password" | npm run users -- create --email viewer@example.test --name 'Local viewer' --role viewer --password-stdin
unset account_password
docker compose up -d --build --wait app worker
```

Use the [session/API guide](docs/api.md) for the administrator creation command,
password changes, role changes and session revocation. There is no public signup
or password-reset endpoint. Open <http://localhost:3000/login> using the exact
configured origin. Sessions use HttpOnly cookies and authoritative SQL roles;
viewers cannot perform administrator operations. Sign-in opens `/overview`.
Use `/players` to filter covered players and select two to four for `/compare`.
Player pages separate the saved five-match window from current observations and
show missing evidence, output units, target context and freshness warnings.
Administrators can use `/admin` to inspect imports, jobs and audit records, queue
work, retry failures, and apply revisions with conflict checks. Queue acceptance
does not mean processing has completed. The underlying APIs are documented in
the session/API guide.

`GET /api/health` reports process liveness and configured feature flags without
querying a database. It does not prove database readiness or forecast freshness.
Database services authenticate their own health checks. The worker health
listener is internal on port 4001.

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
and saved provenance. Saved API and CLI results describe the last completed
evaluation, with its cutoff and check time. Imports and target expiry refresh
asynchronously; an unchanged source ordinal alone does not establish freshness.
The comparison API evaluates current canonical inputs at a common read snapshot
without saving revisions. The enabled worker refreshes automatically after canonical
changes and checks target expiry every minute. Calculations need PostgreSQL writer
credentials, with no provider key or MongoDB connection. See the
[forecasting guide](docs/forecasting.md) for formulas and availability rules.

## Database demonstrations

Run `npm run demo` after `npm ci` to execute the SQL and MongoDB examples on
fresh disposable Docker containers. It uses synthetic data, independent temporary
credentials, and no football API calls. Existing project databases and volumes
are untouched. The [demonstration guide](docs/demo.md) maps each example to its
source, expected result, and safety checks.

## Development

Stop the app container before running the local development server on port 3000:

```bash
docker compose stop app
npm run dev
```

Host development and CLI processes load the local `.env`; Compose explicitly
limits each container's environment as described above. Keep administrative
credentials out of deployed application environments.

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
refresh processing, reporting permissions, sessions/roles, authenticated HTTP APIs,
browser journeys, and isolated database demonstrations against disposable
PostgreSQL 17 and MongoDB 8 services. `npm run test:auth` needs the guarded PostgreSQL test recipe;
`npm run test:api` also needs the guarded MongoDB server and a preceding
`npm run build`. See the database and ingestion guides before running either.
With the same isolated cluster guards, run `npx playwright install chromium` and
`npm run test:ui` for real browser checks of viewer/admin flows and responsive
layouts. Linux hosts may need `npx playwright install --with-deps chromium`.
An existing compatible browser can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Browser tests seed synthetic data, block
external browser requests and do not call the football provider.

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
