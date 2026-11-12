# Sessions and application API

The server exposes authenticated football reads and administrator operations.
The website provides sign-in, an overview, player discovery and detail, comparison,
administrator operations, and account/logout screens. The root page links to
player discovery and comparison, with a compact method summary. API results preserve unavailable values and explanations.
These endpoints support the website's own product flows. Provider data remains
subject to its source terms, including [Highlightly's data usage rights](https://highlightly.net/terms/);
the application does not offer that data as a reusable feed or downloadable dataset.

## Configure local access

Apply pending migrations explicitly, through `013_session_persistence.sql`. Keep
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
The issued persistence mode is stored server-side; omitting a secondary cookie
cannot make a nonpersistent session renewable. Sessions from before this upgrade
retain their existing expiry and remain valid until then, without renewal.
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
`GET /api/auth/get-session` returns JSON `null` with status 200 when there is no
session; `GET /api/me` instead requires authentication and returns 401.
Public `/api/health` reports process liveness and configured feature flags; it
performs no database readiness check. Database containers authenticate their own
health checks. All other APIs require a valid session.

Product/admin successes use `{data: ...}`; failures use
`{error:{code,message}}` with generic service errors. Auth successes keep the
library's user/session shape with sensitive fields removed. Session-sensitive
responses use `Cache-Control: no-store`. Mutations require the exact canonical
Origin and Host, `Content-Type: application/json` and an object no larger than
16 KiB. Unknown fields, query keys and repeated scalar query keys are rejected.
Reads also require the canonical Host; if an Origin header is supplied, it must
match the canonical origin. Product reads use `{data: ...}` even when a field
inside that result is unavailable or null.
Use cookies from login and include `Origin: AUTH_BASE_URL` in CLI HTTP mutations.
Unauthenticated requests return 401; viewer admin attempts return 403; validation
returns 400/413/415; missing records/routes return 404; conflicts return 409;
unsupported methods return 405; throttling returns 429; unexpected service
failures return 503. Administrator routes with unsupported methods return 404.

## Viewer reads

| Method and path | Result / query |
| --- | --- |
| `GET /api/me` | Current identity, authoritative role and session expiry |
| `GET /api/overview` | Covered competition/club/player and stored forecast counts, source watermark |
| `GET /api/competitions` | Enabled approved competitions/seasons |
| `GET /api/clubs?leagueId=premier-league-gb-eng` | Covered registered clubs; optional league filter |
| `GET /api/players` | Player summaries with `bestStatistic`; `q`, `leagueId`, `clubId`, `position`, `availability`, `page`, `pageSize` |
| `GET /api/players/PLAYER_ID` | Identity and `bestStatistic`, up to 50 recent observed appearances, saved forecast and provenance |
| `GET /api/players/PLAYER_ID/forecast` | Saved immutable revision and latest evaluation envelope |
| `GET /api/compare?playerId=ID&playerId=ID` | Current canonical comparison at one cutoff/source snapshot |

Current football identities are Sorare native node identifiers represented as
strings: `Player:UUID`, `Club:UUID` and `Game:UUID`. Keep the prefix, including in
JSON bodies, and URL-encode identifiers used in paths or query parameters.
League IDs are `premier-league-gb-eng` and `laliga-es`. Player summaries can
include `sourceUrl`, built only from the stored genuine Sorare player slug; a
slug is separate from the player's identifier. SQL revision/job identifiers and
command request identifiers are bare UUIDs. Catalogue pages default to page 1
with 20 items, with a maximum page size of 50; search text is at most 80 characters. Positions are
`GK`, `DEF`, `MID`, `FWD`, `UNKNOWN`. The `availability` filter accepts
`ready` (stored `available` or `partial`) and `hidden` (stored `unavailable` or
`uncomputed`), as well as each of those four individual statuses. Filtering
happens before counting and pagination. Omitting the filter still returns all
statuses for API compatibility; the website requests `ready` by default under
the **With results** filter and provides **Show hidden**, **Hidden**, and **All**
controls. Present statistics have no success badge; partial results and recorded
gaps retain their meaningful indicators. Missing result cards
and comparison cells are hidden by default without changing API values, the
exact five-match evidence, or numeric zero. Revealing missing results shows
neutral labels and their recorded explanations. Search ignores case, accents and punctuation:
`mbappe` and `mbappe'` both match `Mbappé`. Space-separated partial terms must all
occur in the name, in any order. `%`, `_` and backslash remain literal characters,
not search operators; input containing only ignored punctuation returns no
matches. Search stays parameterized and does not change provider identity matching. Coverage stays
restricted to enabled regular-season Premier League/La Liga, 2026/27. Former
APIFootball records remain stored for archival provenance and do not appear in
current product reads. Current club requires complete, unambiguous latest roster
evidence; old appearances do not
establish current membership.
Missing/incomplete roster blockers apply only to seasons with this player's
pre-cutoff appearance or roster-inclusion evidence. An unrelated league's missing
roster does not invalidate a confirmed club; explicit conflicting claims still do.

Every player summary includes `bestStatistic`, including `player` in detail,
saved-forecast and comparison responses. Its available shape contains:

| Field | Meaning |
| --- | --- |
| `status`, `metric`, `total` | `"available"`, the selected metric, and its observed integer total |
| `per90`, `minutes`, `matches` | Observed rate per 90 minutes, total reported minutes, and exactly `5` appearances |
| `percentile`, `cohortSize`, `standout` | Conservative integer rank, eligible group size including the player, and whether the rank is at least 80 |
| `leagueId`, `season`, `position` | The confirmed comparison group |
| `fixtureIds`, `cutoffAt` | The five selected fixtures and the current read cutoff |

An unavailable statistic is `{status:"unavailable",reason:CODE}` and has no
numeric value. The [scouting rules](forecasting.md#observed-scouting-statistics)
define eligibility, metric selection, missing-data reasons and ranking. Cohorts
use all eligible players in the same position, league and season, with at least
10 players including the subject; search, filters, pagination and comparison
selections do not narrow them. Computation uses the request's read-only snapshot
and makes no provider requests or saved forecast revisions. These are observed
strengths, calculated independently of ratings, standings context and forecast
availability. A nonelite best statistic can be available with `standout:false`.

Catalogue availability filters and overview counts describe the **last stored
evaluation**, not an instant recalculation. Summaries label it `stored-evaluation`
and expose evaluation cutoff, check time and source ordinal. Detail retains the
immutable revision cutoff separately from the latest evaluation. The response
source watermark describes the current canonical read snapshot. Imports and clock
changes refresh forecasts asynchronously; equal source ordinals alone do not prove
freshness because a target can expire with time. Keep these dates and availability
reasons visible when consuming the API.

Stored forecast endpoints return `forecast: null` for a known player whose model
has not been evaluated. Within a saved or transient result, each output has
`{status,value,reasons}`; unavailable outputs use `value: null`. Numeric zero is
an available value when the evidence supports it.

| Result field | Units / interpretation |
| --- | --- |
| `forecastRating` | Continuous next-match rating, 0–10 |
| `displayedForecastRating` | Legacy `10 × forecastRating`, 0–100; the website uses `forecastRating` |
| `adjustedFormIndex` | Weighted historical form on a fixed 0–100 scale; separate from the next-match rating |
| `projected90.METRIC` | Decimal events per 90 reported minutes under a 90-minute playing-time assumption |
| `observedAppearances[].metrics` | Observed integer match counts, before per-90 conversion |

The [model guide](forecasting.md#context-and-formulas) defines the formulas and
explains the form scale. Model status can be `partial` with form alone available;
inspect each output before treating it as a future projection.

Each recent observed appearance includes its current primary `revisionId` (nullable when
no revision exists) and `membershipKnown`. These fields describe the current
observation, separately from the immutable forecast input. The administrator
correction form obtains its optimistic revision token from this read endpoint;
it reloads after a 409 rather than silently overwriting a concurrent change.

An appearance's `fieldSources` identifies each value supplied by Highlightly,
with its provider, normalized/source revision IDs and actual observation time.
Only missing primary fields can be supplemented; primary appearance or fixture
corrections invalidate the old supplement. Forecast provenance records the same
lineage under `appearanceEnrichments`. Private payloads, identity-matching evidence
and credentials stay outside these responses. Current-source freshness keeps
`latestRetrievedAt` for Sorare and reports active supplementary data separately
as `supplementLatestRetrievedAt`, so a recent supplement cannot mask stale
primary evidence.

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

Administrators open **Account settings → Operations** to reach `/admin`.
Operations is absent from the top navigation for every role; the account link is
administrator-only, and server authorization also protects every operation.

| Method and path | Body / behavior |
| --- | --- |
| `GET /api/admin/status` | Coverage/import/job aggregates and the shared provider request budget |
| `GET /api/admin/jobs` | Bounded `page`, `pageSize`, optional `status` and `kind` |
| `GET /api/admin/audit` | Bounded `page`, `pageSize`, safe actor/action/correction evidence |
| `GET /api/admin/imports` | Bounded `page`, `pageSize`, committed import summaries and sanitized validation issues |
| `POST /api/admin/imports` | `{requestId}` queues a source synchronization |
| `POST /api/admin/statistics` | `{requestId,leagueId,fixtureId}` queues covered fixture details |
| `POST /api/admin/forecasts/refresh` | `{requestId}` queues a local forecast refresh |
| `POST /api/admin/jobs/JOB_ID/retry` | `{requestId}` resets an eligible failed job |
| `PATCH /api/admin/appearances` | `{requestId,playerId,fixtureId,expectedRevisionId,reason,changes}` |

`requestId` is a UUID generated for the intended command. Retry the same body with
the same UUID as the same administrator to retrieve its original outcome; reuse
by another administrator or with a different command is
a 409 conflict. Actor audit and command effects commit together. Queue submissions
return 202 and mean accepted, not completed. Inspect jobs for completion/retry.
The worker executes source synchronization and statistics fetches using its own
Sorare credential and the shared 60-attempt rolling-minute application budget,
with one-second request spacing. Every HTTP page consumes an attempt. The web
process never fetches provider data or bypasses that budget. Forecast refresh is local.

Job summaries expose `outboxId` to correlate source commands. Forecast refresh
commands can coalesce into shared work, so a command does not guarantee a distinct
completed job. Committed import pages expose counts, dates, safe resource
identifiers and up to 50 allowlisted issue previews per batch, with `issueTotal`
and an explicit truncation flag. They expose no raw provider payloads or keys.
The application request budget is separate from provider-side limits.
Administrator list endpoints default to page 1 with 25 items. They accept at most
100 items per page and page numbers through 10,000. Job statuses are `ready` (shown as **Queued**),
`running`, `succeeded`, `failed`; kinds are `source.sync`, `fixture.statistics`,
`standings.rebuild`, `forecast.refresh`. Statistics requests require a covered
fixture already stored as live or final; they cannot request an arbitrary fixture.

Corrections require a finalized, known-played appearance with known membership in
approved coverage and its current `expectedRevisionId`. Only `minutes`, `rating`,
`goals`, `assists`, `shotsOnTarget`, `keyPasses`, `tackles`, `interceptions`, `saves`
and `goalsConceded` may be changed. Missing values remain null; counts/minutes are
nonnegative integers, rating is 0–10 with at most two decimal places. Corrections
require a nonempty `changes` object and a reason of 3–1,000 characters without
control characters. Omitted metric fields retain their existing values; send
explicit `null` only to mark a field missing. `expectedRevisionId` must be the
current non-null appearance revision UUID from the player read, not a forecast
revision. A successful correction returns 200 with the new revision and metrics.
After a 409 revision conflict, reload before submitting a new intended correction.
Corrections cannot manufacture participation, membership or finality. They append distinctly
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
`npm run test:source` additionally verifies current Sorare native identifiers,
scope isolation, missing fields, observed scouting reads and migration/reporting
overloads in that guarded PostgreSQL/MongoDB environment. Archived synthetic
HTTP/browser fixtures use `LSP_TEST_SOURCE=legacy` only in a valid `_test`
database; that selector does not re-enable archived leagues in production.
