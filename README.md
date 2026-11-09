# Live Sports Prediction

A football player analysis project built around five qualifying league appearances,
with opponent strength and competition context informing an explainable forecast.

The current application provides a responsive preview, an idle worker, and a
containerized PostgreSQL/MongoDB environment. Match imports, forecasts, comparisons,
and application login are not implemented yet. Preview screens clearly label
forecast availability.

## Requirements

- Node.js 24 and npm 11
- Docker with Docker Compose

## Run locally

```bash
npm ci
cp .env.example .env
```

Replace both placeholder passwords in `.env` with independent random values.
Keep that file local. No football API credential is needed to run this application.

```bash
docker compose config --quiet
docker compose up --build -d --wait
```

Open <http://localhost:3000>. PostgreSQL and MongoDB bind to loopback ports 5432
and 27017. The worker health listener is internal on port 4001. App and worker
processes receive no database credentials and do not establish database connections.
Their health endpoints report process liveness; database health is checked
separately with authentication.

```bash
docker compose ps
docker compose stop
```

Named volumes preserve database data when containers are stopped or replaced.
Database initialization occurs only on empty volumes; editing `.env` does not
rotate an existing database password. A normal `docker compose down` retains
volumes. Deleting volumes destroys their stored data.

## Development

Stop the app container before running the local development server on port 3000:

```bash
docker compose stop app
npm run dev
```

Run the idle worker separately with `npm run worker`. It exposes `GET /health`
without performing imports or background jobs. Web health is available at
`GET /api/health`.

```bash
npm run lint
npm run typecheck
npm run build
```

The lockfile pins npm dependency versions. GitHub Actions runs installation, lint,
type checking, and the production build without database or API credentials.

## Methodology

The intended analysis uses the latest five finalized appearances with at least
60 reported minutes each. A shorter appearance leaves that window unchanged.
Opponent and own-team strength provide context for an overall rating and selected
position-specific statistics. Counts represent decimal estimates under a
90-minute playing-time assumption. Missing data must remain distinct from zero.

The initial intended data coverage is regular-season Championship and Ligue 2,
2026/27, using APIFootball.com's permanent free plan. Data integration and the
forecast calculations are not present in this application yet. Forecasts will be
heuristic estimates rather than guaranteed outcomes or calibrated probabilities.

## Technology

Next.js and TypeScript provide the web interface and a shared language for server
and worker code. PostgreSQL is intended for canonical relational records and
constraints; MongoDB is intended for source archives. Docker Compose provides a
reproducible local environment with persistent database volumes. Inter is
self-hosted through the application bundle.
