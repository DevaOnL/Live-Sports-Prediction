# Sessions and application API

The server exposes authenticated football reads and administrator operations.
The website provides sign-in and account/logout screens; the catalogue, forecast,
comparison and operational dashboards are not yet product screens. The root page
is a methodology preview. API results preserve unavailable values and explanations.

## Configure local access

Apply pending migrations explicitly, including `009_auth_rate_limit.sql`. Keep
existing volumes. Set these ignored `.env` variables before recreating the app:

```dotenv
AUTH_BASE_URL=http://localhost:3000
BETTER_AUTH_SECRET=replace-with-an-independent-random-auth-secret
```

Replace the secret with at least 32 random characters, for example output from
`openssl rand -hex 32`. Keep it stable across restarts and app instances. The app
also needs the existing independent reader/writer/auth PostgreSQL passwords.
Only HTTPS origins are accepted outside loopback development. The canonical
origin includes the scheme and port; open that exact origin and configure a
reverse proxy to preserve its Host. Forwarded host/IP headers are not trusted.
The Compose app receives no provider, MongoDB, bootstrap or migrator credentials.
Host development commands load local dotenv files normally; use a separate,
restricted environment if running the web server directly on the host.

Create local password accounts through the controlled migrator CLI. In Bash:

```bash
read -rs -p 'Viewer password: ' account_password
printf '%s\n' "$account_password" | npm run users -- create --email viewer@example.test --name 'Local viewer' --role viewer --password-stdin
unset account_password
read -rs -p 'Administrator password: ' account_password
printf '%s\n' "$account_password" | npm run users -- create --email admin@example.test --name 'Local administrator' --role admin --password-stdin
unset account_password
docker compose up -d --build app
```

Use independent passwords of 12–128 characters. These commands do not send email
or assert verified mailbox ownership. There is no public signup or password-reset
endpoint. Passwords are read from redirected stdin, hashed by Better Auth, and
never accepted as command arguments. `create` refuses existing users. Explicit
administration uses `set-password --email EMAIL --password-stdin`,
`role --email EMAIL --role viewer|admin`, or `revoke --email EMAIL` with the same
`npm run users --` prefix. Password/role changes revoke existing sessions.
Migration credentials remain outside app/worker containers.

Open `/login`. Sessions use Better Auth 1.7.18 with PostgreSQL storage, an 8-hour
expiry and a 15-minute refresh interval for persistent sessions. The login screen
uses nonpersistent cookies and an eight-hour session without renewal.
Authenticated guards do not silently refresh a session without returning its
cookie; the explicit session endpoint can refresh persistent sessions.
Cookie caching is disabled. Roles are loaded from SQL on every
protected request, independent of client input. Cookies are HttpOnly, SameSite=Lax
and Secure for HTTPS. Logout explicitly revokes the SQL session before reporting
success; a database failure returns a service error.

Login is limited to five attempts per minute in a database-backed shared bucket.
Other auth operations have a 100/minute bucket. With no trusted proxy configured,
buckets are shared per endpoint across users; forged forwarding headers cannot
create new identities. These limits are separate from the football API budget.

## HTTP conventions

Only `POST /api/auth/sign-in/email`, `GET /api/auth/get-session` and
`POST /api/auth/sign-out` are exposed from the auth library. Login accepts
`{email,password,rememberMe?}`; logout accepts `{}`. Auth responses omit session
tokens, IP addresses and user agents. Session cookies carry authentication.
Public `/api/health` reports process liveness and configured feature flags; it
performs no database readiness check. Database containers authenticate their own
health checks. All other APIs require a valid session.

Product/admin successes use `{data: ...}`; failures use
`{error:{code,message}}` with generic service errors. Auth successes keep the
library's user/session shape with sensitive fields removed. Session-sensitive
responses use `Cache-Control: no-store`. Mutations require the exact canonical
Origin and Host, `Content-Type: application/json` and an object no larger than
16 KiB. Unknown fields, query keys and repeated scalar query keys are rejected.
Use cookies from login and include `Origin: AUTH_BASE_URL` in CLI HTTP mutations.
Unauthenticated requests return 401; viewer admin attempts return 403; validation
returns 400/413/415; missing records/routes return 404; conflicts return 409;
throttling returns 429; unexpected service failures return 503.

## Viewer reads

| Method and path | Result / query |
| --- | --- |
| `GET /api/me` | Current identity, authoritative role and session expiry |
| `GET /api/overview` | Covered competition/club/player and stored forecast counts, source watermark |
| `GET /api/competitions` | Enabled approved competitions/seasons |
| `GET /api/clubs?leagueId=153` | Covered registered clubs; optional league filter |
| `GET /api/players` | `q`, `leagueId`, `clubId`, `position`, `availability`, `page`, `pageSize` |
| `GET /api/players/PLAYER_ID` | Identity, up to 50 recent observed appearances, saved forecast and provenance |
| `GET /api/players/PLAYER_ID/forecast` | Saved immutable revision and latest evaluation envelope |
| `GET /api/compare?playerId=ID&playerId=ID` | Current canonical comparison at one cutoff/source snapshot |

IDs are positive provider identifiers. Catalogue pages default to 1, with a
maximum page size of 50; search text is at most 80 characters. Positions are
`GK`, `DEF`, `MID`, `FWD`, `UNKNOWN`; availability is `available`, `partial`,
`unavailable` or `uncomputed`. Search is literal parameterized text. Coverage stays
restricted to enabled regular-season Championship/Ligue 2, 2026/27. Current club
requires complete, unambiguous latest roster evidence; old appearances do not
establish current membership.

Catalogue availability filters and overview counts describe the **last stored
evaluation**, not an instant recalculation. Summaries label it `stored-evaluation`
and expose evaluation cutoff, check time and source ordinal. Detail retains the
immutable revision cutoff separately from the latest evaluation. The response
source watermark describes the current canonical read snapshot. Imports and clock
changes refresh forecasts asynchronously; equal source ordinals alone do not prove
freshness because a target can expire with time. Keep these dates and availability
reasons visible when consuming the API.

Comparison accepts 2–4 unique players. Its default requires matching positions;
set `allowCrossPosition=true` to compare different positions with an explicit
notice and only shared projected metrics. Rating and adjusted form remain distinct.
The response is `kind: "transient-comparison"`; all players use the same cutoff and
source ordinal in a repeatable-read read-only transaction. It writes no saved
revisions and makes no provider requests. Each `canonicalInputHash` and
`canonicalStatus` describes the full canonical model evaluation before presentation
prunes nonshared outputs. The displayed `result` can therefore have a different
availability status. `storedRevision` separately identifies any prior saved result.
The canonical input/provenance remains available to explain the five-match window.

## Administrator operations

| Method and path | Body / behavior |
| --- | --- |
| `GET /api/admin/status` | Coverage/import/job aggregates and the shared provider request budget |
| `GET /api/admin/jobs` | Bounded `page`, `pageSize`, optional `status` and `kind` |
| `GET /api/admin/audit` | Bounded `page`, `pageSize`, safe actor/action/correction evidence |
| `POST /api/admin/imports` | `{requestId}` queues a source synchronization |
| `POST /api/admin/statistics` | `{requestId,leagueId,fixtureId}` queues covered fixture details |
| `POST /api/admin/forecasts/refresh` | `{requestId}` queues a local forecast refresh |
| `POST /api/admin/jobs/JOB_ID/retry` | `{requestId}` resets an eligible failed job |
| `PATCH /api/admin/appearances` | `{requestId,playerId,fixtureId,expectedRevisionId,reason,changes}` |

`requestId` is a UUID generated for the intended command. Retry the same body with
the same UUID to retrieve its original outcome; reuse with a different command is
a 409 conflict. Actor audit and command effects commit together. Queue submissions
return 202 and mean accepted, not completed. Inspect jobs for completion/retry.
The worker executes source synchronization and statistics fetches using its own
existing provider credentials and shared rolling-hour budget. The web process
never fetches provider data or bypasses that budget. Forecast refresh is local.

Corrections require a finalized, known-played appearance with known membership in
approved coverage and its current `expectedRevisionId`. Only `minutes`, `rating`,
`goals`, `assists`, `shotsOnTarget`, `keyPasses`, `tackles`, `interceptions`, `saves`
and `goalsConceded` may be changed. Missing values remain null; counts/minutes are
nonnegative integers, rating is 0–10 with at most two decimal places. Corrections
cannot manufacture participation, membership or finality. They append distinctly
manual SQL source/revision evidence, retain reason/before/after/actor audit and
emit a canonical refresh event. Authoritative provider archives remain immutable.
Provider observations retrieved after the correction may supersede its canonical
metrics. Older/equal observations retain import evidence but skip that fixture,
including headers and omitted player rows, and record
`superseded_by_manual_correction`. If a newer import of the same action/resource
already supersedes the whole archive, the existing `superseded_archive` issue
applies instead. Manual lineage remains auditable afterward.

## Verification

`npm run test:auth` verifies real PostgreSQL-backed Better Auth sessions, SQL
expiry/logout/revocation, role/grant boundaries, CLI administration and atomic
shared throttling. `npm run test:api` verifies reader snapshots/filters/comparisons,
audited admin operations and real HTTP behavior against a built server. Run
`npm run build` first. These suites require the exact disposable `_test` cluster
identities documented in [database.md](database.md#isolated-integration-tests)
and [ingestion.md](ingestion.md#isolated-integration-tests). HTTP tests also need
the isolated MongoDB marker because they seed synthetic archives. They never run
against a demo/shared database and never make provider requests. CI runs all suites.
