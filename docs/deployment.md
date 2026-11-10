# Deployment and recovery

The supported demonstration is a single-host Docker Compose application with
PostgreSQL 17 and MongoDB 8. Start with the [README](../README.md) for installation,
database provisioning and viewer/admin creation. An empty catalogue is expected
before ingestion. The [offline demo](demo.md) needs no provider account and uses
its own disposable databases; it does not seed the application database.

## Configuration and persistence

Use the committed lockfile with Node.js 24/npm 11. Keep the ignored `.env` owned
by the operator with mode 0600. All database passwords must be independent random
values of at least 16 characters. The authentication secret must be independent,
at least 32 characters and stable across ordinary restarts. Never expose this file,
database dumps, original provider responses or private evaluation captures through
the website or repository. Docker build contexts explicitly exclude local secrets.

The default Compose project is `live-sports-prediction`. PostgreSQL data, MongoDB
data and MongoDB configuration use named volumes. Reuse the original project name,
environment file and Compose files on every operational command. If an existing
installation uses `-p`, `--env-file` or `-f`, include those same options in the
examples below. A different project name selects different resources.

Host CLI settings use loopback database addresses/ports; containers use internal
service names and fixed internal ports. The default host bindings are
`127.0.0.1:3000`, `127.0.0.1:5432` and `127.0.0.1:27017`; worker health port 4001
is internal. Do not publish database ports to the Internet. The app receives only
reader/writer/auth SQL passwords and its authentication settings. Provider and
restricted MongoDB credentials belong to the worker; bootstrap/migrator credentials
belong to controlled administration. See [architecture](architecture.md).

Changing `.env` does not rotate passwords stored inside existing databases.
`db:provision` deliberately creates/updates restricted SQL passwords;
`mongo:provision` creates/updates its restricted archive account. Coordinate any
rotation with all affected consumers. Neither is a substitute for rotating an
existing database bootstrap account through that database's administration tools.

For routine startup and inspection:

```bash
docker compose config --quiet
docker compose up -d --wait postgres mongo
docker compose up -d --build --wait app worker
docker compose ps
curl --fail http://localhost:3000/api/health
```

Do not print `docker compose config` without `--quiet`: resolved environment
values include credentials. Database initialization applies only to empty volumes.
Ordinary `stop`, container replacement and `down` preserve named data volumes;
never use volume deletion as an upgrade or recovery command.

## HTTPS on a host

Complete local setup first. Set `AUTH_BASE_URL` to the one exact public HTTPS
origin, for example `https://sports.example.com`, without a path, query or fragment.
Recreate the app after changing it. Keep the stable authentication secret. HTTP
authentication is supported only for loopback development.

Use a host reverse proxy with a certificate for that domain, forwarding to the
loopback app listener. For example, within an HTTPS Nginx server configured with
your certificate and key:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Preserve the incoming Host exactly, including a nonstandard port. Rewriting it
to the upstream loopback host causes `UNTRUSTED_HOST`. Forwarded host/IP headers
do not establish application trust; a mutation must also carry the exact canonical
Origin. Login cookies use Secure with HTTPS, HttpOnly and SameSite=Lax. The shared
database-backed sign-in limit is five attempts per minute across users/instances;
forwarded IP values do not create separate buckets. Test a real login and protected
read through HTTPS, viewer denial of administrator actions, and sign-out. App
process health alone does not verify the proxy, cookie, database or permission path.

Only the worker has a restart policy in the base Compose file. For automatic
single-host recovery, create an ignored local `compose.override.yaml`:

```yaml
services:
  app:
    restart: unless-stopped
  postgres:
    restart: unless-stopped
  mongo:
    restart: unless-stopped
```

Default Compose invocation loads this override automatically. If you use explicit
`-f` arguments, include it explicitly with `-f compose.override.yaml` too.
Enable the Docker service at host boot,
validate the merged configuration with `docker compose config --quiet`, and apply
it with `docker compose up -d --wait`. Containers may start before databases are
ready; verify authenticated reads and worker progress after restart. With the base
file alone, run the startup commands explicitly after a host reboot. TLS, external
DNS/certificate management, monitoring and off-host backups are operator tasks;
the local checks do not establish an Internet deployment.

## Health and operations

| Check | What it establishes |
| --- | --- |
| `docker compose ps` | Container status and configured health checks |
| `GET /api/health` | Web process liveness and configured feature flags; no database query |
| Database container health | Authenticated PostgreSQL/MongoDB connectivity |
| Enabled worker `GET /health`, internal port 4001 | Database access and progress of source/local-forecast loops; no guarantee of provider access or complete history |
| Disabled worker health | Process liveness only; no databases or jobs |
| Viewer `/overview`, catalogue and player evidence | Authenticated application reads, stored availability and freshness |
| Admin `/admin` or `npm run ingest -- status` | Job/import state, shared request budget and reconciliation status |
| `npm run forecast -- status` | Saved model-output counts and revision state |

`INGESTION_ENABLED=false` stops the long-running worker's database/provider work.
Explicit `ingest sync` and `ingest once` can still make provider calls. Do not run
them during an offline check. The app queues source work; the enabled worker
executes it within the shared 60-attempt rolling-minute Sorare application budget
and one-second request pacing. Queue
acceptance is not completion. Inspect job errors and freshness rather than
creating additional accounts or bypassing the cap.

For an interrupted import, restore database/service access and use
`npm run ingest -- reconcile`; repeat for a pending backlog larger than 1,000.
It makes no provider requests. Retry a failed job explicitly after correcting its
cause. Local forecast refresh needs only the SQL writer and no provider budget.
See [ingestion recovery](ingestion.md#storage-and-recovery) for exact semantics.

## Switching an existing installation to current coverage

Take a coordinated backup before the source upgrade. Stop the app, worker, preview
instances and host CLI writers; preserve database volumes and runtime secrets.
Apply `npm run db:migrate` through `010_current_coverage.sql`. The migration disables
former active coverage and adds source-aware reporting without deleting historical
observations, forecasts or archives. Keep migrations 001–009 unchanged.

Configure the ignored `SORARE_API_KEY`, then run `npm run ingest -- sync` and
`npm run ingest -- once` to begin current imports. The long-running worker drains
the remaining match-statistics backlog. Rebuild and recreate app/worker containers
with the same project/volumes. Verify both current leagues, import issues,
statistics backlog and authenticated player reads. The app must receive no Sorare
key or MongoDB credentials. Existing sessions and account roles remain in SQL.
Retired-source jobs and outboxes stay isolated from the current worker.

`npm run forecast -- refresh all` recalculates available count outputs after imports.
Conventional player ratings and key passes remain unavailable with this provider;
check individual outputs rather than treating an overall rating gap as an import
failure. Provisional score reviews and incomplete player history remain visible.
A source change does not establish predictive accuracy or replace the archived
historical evaluation.

## Coordinated backup

Back up both databases at one quiescent application state. Stop app and worker,
all host CLI workers/imports/corrections and any other external writers before
dumping; keep them stopped until both dumps finish. PostgreSQL alone contains
manual corrections, users, password hashes, sessions, forecasts and audits.
MongoDB alone contains original response bytes and import markers. Reconciliation
does not rebuild a lost SQL database from archives already marked imported or
repair an older-SQL/newer-MongoDB backup pair.

The following Bash example uses the configured PostgreSQL database and the
default MongoDB database `sports`. Replace the final `sports` argument if
`MONGO_DB` differs. It creates a private sibling directory and leaves app/worker
stopped on success or failure so the operator decides when to resume.

```bash
(
  set -eu
  umask 077
  backup_dir="../live-sports-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  backup_env_file=".env"
  mkdir -m 700 "$backup_dir"
  docker compose stop app worker
  docker compose exec -T postgres sh -c '
    PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom
  ' > "$backup_dir/postgres.dump.part"
  mv "$backup_dir/postgres.dump.part" "$backup_dir/postgres.dump"
  docker compose exec -T mongo sh -c '
    set -eu
    umask 077
    mongo_tools_config=$(mktemp)
    trap "rm -f -- \"$mongo_tools_config\"" EXIT
    mongosh --nodb --quiet --eval \
      "print(JSON.stringify({password: process.env.MONGO_INITDB_ROOT_PASSWORD}))" \
      </dev/null > "$mongo_tools_config"
    mongodump --config="$mongo_tools_config" \
      --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin \
      --db="$1" --archive --gzip
  ' sh sports > "$backup_dir/mongo.archive.gz.part"
  mv "$backup_dir/mongo.archive.gz.part" "$backup_dir/mongo.archive.gz"
  cp "$backup_env_file" "$backup_dir/runtime.env"
  git rev-parse HEAD > "$backup_dir/commit.txt"
  (
    cd "$backup_dir"
    sha256sum postgres.dump mongo.archive.gz runtime.env commit.txt > SHA256SUMS
  )
)
```

If using a custom `--env-file`, change `backup_env_file` to that exact file before
running the block and use the same Compose options throughout.
The temporary MongoDB-tools configuration avoids passing its password as a command
argument. Dumps/configuration contain private records and provider payloads; keep
the backup directory outside the repository, restrict access and retain a protected
off-host copy. Preserve any forward capture files separately, byte-for-byte with
0600 permissions and their confirmation trailers. They are not stored in either
database. Checksums detect changed files; they do not independently authenticate
the backup. Test restoration before relying on a backup.

To resume the same installation without upgrading, use
`docker compose start app worker`, then verify the operational checks above.

## Restore to a separate empty installation

Use a clean checkout of the backed-up commit in a separate directory. Do not
restore over an existing application or point these commands at shared databases.
Verify `SHA256SUMS` from inside the private backup directory first. Use the
recorded release, database names and secret configuration; a database dump does
not include SQL login passwords or MongoDB administrator configuration.

Copy the backup's `runtime.env` to this checkout's ignored `.env` (mode 0600).
Before any startup, set a new unique `COMPOSE_PROJECT_NAME`,
`INGESTION_ENABLED=false` and a blank `SORARE_API_KEY` (also clear any legacy `APIFOOTBALL_API_KEY`). For a same-host
restore rehearsal, choose unused ports and set the host CLI variables
`POSTGRES_PORT=15432`, `MONGO_PORT=17017` and
`AUTH_BASE_URL=http://localhost:13000`. Keep host addresses loopback. A local
`compose.override.yaml` must replace, rather than append, the original bindings:

```yaml
services:
  app:
    ports: !override ["127.0.0.1:13000:3000"]
  postgres:
    ports: !override ["127.0.0.1:15432:5432"]
  mongo:
    ports: !override ["127.0.0.1:17017:27017"]
```

`!override` requires Docker Compose 2.24.4 or later. Substitute other unused ports
in both the file and `.env` if necessary. A distinct project name alone does not
change published ports. With explicit `-f` arguments, include this override
explicitly too. Confirm the selected project's resources with
`docker compose ps -a` and validate configuration before proceeding. The targets
must be new/empty: create SQL roles **before restoring**, without running migrations
or user creation first. Do not pre-provision MongoDB collections.

After `npm ci`, set `backup_dir` to the private backup's absolute directory and run
from this new checkout:

```bash
(
set -eu
: "${backup_dir:?Set backup_dir to the private backup directory}"
(cd "$backup_dir" && sha256sum --check SHA256SUMS)
docker compose config --quiet
docker compose up -d --wait postgres mongo
npm run db:provision
docker compose exec -T postgres sh -c '
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction
' < "$backup_dir/postgres.dump"
docker compose exec -T mongo sh -c '
  set -eu
  umask 077
  mongo_tools_config=$(mktemp)
  trap "rm -f -- \"$mongo_tools_config\"" EXIT
  mongosh --nodb --quiet --eval \
    "print(JSON.stringify({password: process.env.MONGO_INITDB_ROOT_PASSWORD}))" \
    </dev/null > "$mongo_tools_config"
  mongorestore --config="$mongo_tools_config" \
    --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin \
    --nsInclude="$1.*" --archive --gzip --stopOnError
' sh sports < "$backup_dir/mongo.archive.gz"
npm run db:migrate
npm run mongo:provision
)
```

Preserve the SQL dump's ownership, ACLs and `infra.schema_migrations`; do not use
`--no-owner`, `--no-acl`, cleanup/drop options or a fresh migration ledger.
MongoDB restore includes both raw archives and import metadata; provisioning then
recreates its restricted runtime account/role and verifies validators/indexes.
Compare expected record counts, archive content hashes and import markers before
allowing writes. Verify migrations against the recorded release, viewer/admin
accounts, reader write denial and forecast evidence. Authentication sessions and
password hashes are private restored records; test with authorized accounts.

Once the matched data is verified, offline `ingest reconcile` can repair remaining
interruption gaps, and `forecast refresh all` can update targets for the current
clock. Such refreshes may append revisions; perform parity checks before them.
Start app/worker with ingestion disabled, test login/role restrictions and inspect
status. Keep the original installation intact until restore checks pass. Switching
the canonical HTTPS origin, re-enabling the provider and routing traffic are
separate deliberate operational steps. Only delete specifically identified
temporary rehearsal resources; never reset original data volumes.

## Upgrade an existing installation

1. Record the current Git commit and Compose project/configuration. Stop all
   writers and take a verified coordinated backup as above.
2. Check out the reviewed new commit without discarding local secrets or changing
   the existing project/volumes. Run `npm ci` and `npm run db:migrate`. Do not edit
   applied migrations or rerun password provisioning as a routine upgrade step.
3. With MongoDB available, run `npm run ingest -- reconcile`, then
   `npm run forecast -- refresh all`. These use existing restricted runtime
   identities and make no provider requests.
4. Run `docker compose up -d --build --wait app worker`. Verify login, viewer/admin
   boundaries, imported coverage, saved forecast freshness and job state.

If an upgrade fails after new migrations, keep writers stopped and investigate.
There is no automatic down-migration. Running older application code against a
newer schema is not an established rollback strategy; restore the matched backup
into a separate verified installation if rollback is required.

## Verification scope

The documented local setup and matched logical restore are rehearsed with
isolated synthetic data. Integration/browser tests use guarded disposable
databases and never an application/shared database. The
[requirement guide](requirements.md) maps these checks to executable artifacts.
The [evaluation report](evaluation.md) records actual historical zero coverage
and unavailable errors; neither a restore test nor a healthy deployment establishes
predictive accuracy. The screenshots are labeled synthetic examples.
