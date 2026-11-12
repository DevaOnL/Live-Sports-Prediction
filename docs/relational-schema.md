# Relational schema

This reference derives the implemented PostgreSQL schema from the Chen entity–relationship model. Five ER sheets and five corresponding relational sheets cover football, observed context, evidence, operations, and authentication. They describe **31 stored relations**: 25 in `sports`, five in `auth`, and one in `infra`. These diagram sheets are separate from the single SQL view, `sports.effective_appearances`. MongoDB archives are documented separately because they are document collections rather than SQL relations.

The schema follows the thirteen published migrations and the migration ledger created by the database setup script. The relation dictionary below records the final column types, nullability, primary keys, unique constraints and foreign keys, including later `ALTER TABLE` changes. The executable definitions remain authoritative; the diagrams introduce no schema or model changes.

## Diagrams and export

Start with the connected [football ER overview](diagrams/er-overview.svg), then use
the complete domain sheets. Gray reference boxes repeat an entity or key already
defined elsewhere; they do not add tables. The detailed sheets are zoomable vector
artwork. The [combined PDF](diagrams/database-model.pdf) presents the overview,
all five Chen sheets, then all five derived relational sheets in that order.
It uses detailed poster pages; use the SVG originals or PDF zoom for full labels.

| Domain | Chen ER model | Derived horizontal relational diagram |
| --- | --- | --- |
| Football and registration | [ER sheet 1](diagrams/er-football.svg) | [Schema sheet 1](diagrams/schema-football.svg) |
| Standings and rosters | [ER sheet 2](diagrams/er-context.svg) | [Schema sheet 2](diagrams/schema-context.svg) |
| Provenance, supplements and forecasts | [ER sheet 3](diagrams/er-evidence.svg) | [Schema sheet 3](diagrams/schema-evidence.svg) |
| Processing and infrastructure | [ER sheet 4](diagrams/er-operations.svg) | [Schema sheet 4](diagrams/schema-operations.svg) |
| Authentication | [ER sheet 5](diagrams/er-auth.svg) | [Schema sheet 5](diagrams/schema-auth.svg) |

In each relational diagram, a named horizontal strip lists stored attributes, with
every primary-key component underlined. Each `Fnn` arrow joins an ordered foreign-key
group to its referenced key. Ticks join the participating cells into one group;
composite keys are not several independent scalar constraints. Gray strips show
only the referenced key, with the complete relation’s sheet number. Types, nullable
columns, defaults, unique expressions and full FK declarations are listed below.

## Reading the Chen model

The model uses Chen shapes described in Wikipedia’s [Entity–relationship model](https://en.wikipedia.org/wiki/Entity%E2%80%93relationship_model): rectangles denote entity types, diamonds denote relationships, and ellipses denote attributes. A solid underline marks a chosen key. When several attributes form a key, their **combination** identifies the entity; the underline does not assert that each attribute is individually unique.

Ordinary scalar attributes appear as ellipses. Foreign-key context is expressed through relationships and becomes columns during relational mapping. Attributes needed to show a chosen composite identifier also appear on its entity. A JSONB object or array is shown as one document-valued attribute, with its internal structure kept outside the relational key model.

Plain `1` and `N` labels show the **maximum cardinality ratio**. The `1` label is placed at the one-side entity and `N` at the many-side entity. Thus Competition `1`—contains—`N` CompetitionSeason means that one competition can have many seasons, while one season belongs to at most one competition. The number `1` alone does not require a relationship to exist. A `1:1` relationship permits at most one counterpart on each side; an `M:N` relationship permits many on both sides.

A double line from an entity to a relationship means **total participation**, so every entity instance must participate at least once. A single line denotes partial participation and permits no relationship. Minimum participation therefore comes from the line style, separately from the maximum `1`/`N` ratio. In the competition example, the double line at CompetitionSeason requires exactly one competition per season, while the single line at Competition permits a stored competition to have no seasons. The relation dictionary records exact FK nullability and the conditional rules that the drawing alone cannot express. Labels such as `home`, `away`, `parent` and `child` distinguish different roles of the same entity type.

A double rectangle denotes a weak entity, a double diamond its identifying relationship, and a dashed underline its partial key. StandingsRow is modeled as weak under StandingsSnapshot: `club_id` distinguishes rows within one snapshot, while the owner’s identifier completes its identity. Its relational key is therefore `(snapshot_id, club_id)`. The weak side participates totally in its identifying relationship. The separate registered-club relationship is retained.

Mandatory foreign keys alone do not make an entity weak. PlayerMembership, Appearance, RosterSnapshot, ForecastRevision and SupplementObservation retain their independent chosen identifiers. SeasonClub and RosterEntry are reified associations with composite keys; their association role is stated explicitly rather than inferred from a double rectangle.

A dashed ellipse denotes a derived attribute. StandingsRow’s `goal_difference` is computed as `goals_for - goals_against`; it is not a stored column. Double ellipses would denote multivalued attributes. No such attribute is introduced merely to demonstrate the notation: repeated registrations, appearances and observations are modeled as relationships or entities with their own identities.

## Deriving the relations

A regular entity becomes a relation containing its stored attributes and chosen primary key. Alternate business identifiers become unique constraints. For provider records, `(provider, provider_id)` preserves the provider namespace; a display name or lookup slug is not substituted for identity.

For a 1:N relationship, the key of the one-side entity becomes a foreign key in the many-side relation. Total participation on that child side normally requires a nonnull FK; optional participation permits null. This FK does not require every parent to have children. Conditional rules remain separate: an appearance’s club and membership are nullable for unknown participation, while confirmed `played` or `dnp` records require both.

An M:N association becomes a relation containing participant keys. SeasonClub reifies season registration, with primary key `(season_id, club_id)`, because fixtures, memberships and observations reference that registration itself. Associations with repeated temporal or evidential occurrences need their own identity or additional distinguishing attributes: PlayerMembership and Appearance preserve their UUID keys and alternate uniqueness constraints.

RosterEntry preserves a three-part observation identity, `(snapshot_id, player_id, club_id)`. A single snapshot may contain conflicting club observations for one player; replacing this key with `(snapshot_id, player_id)` would discard that fact. Its `season_id` supplies enforced context for the registered-club relationship and must agree with the snapshot’s season.

For the weak StandingsRow entity, the owner key and partial key form the primary key. The identifying relationship maps into the row’s owner FK, so it needs no separate relationship table. The derived goal difference is omitted from the stored relation.

The two `Current` diamonds are optional 1:1 relationships with stored metadata and **single participation lines at both endpoints**. CurrentForecast relates a Player to its selected ForecastRevision; CurrentSupplement relates an Appearance to its selected SupplementObservation. An owner need not have a current selection, and a saved revision or observation need not be selected. Each maps to a separate head relation keyed by the owning player or appearance. Its pointer is required when a head exists. Composite pointer FKs also require the referenced revision or observation to belong to that same owner. Timestamps, evaluation metadata and the supplement conflict flag are relationship attributes stored on these head relations. No new surrogate head identifier is introduced.

Recursive revision relationships become optional self-FKs with explicit parent/child roles. Composite FKs preserve the same entity or player, while an earlier-ordinal constraint prevents cycles. Each revision may have no parent and a parent may have several children; the model does not imply a single unbranched chain.

The derivation follows the entity, participation, weak-entity and relationship-mapping rules in the University of Cape Town’s [Entity–Relationship Modelling](https://www.cs.uct.ac.za/mit_notes/database/htmls/chp06.html). A SQL FK may reference a declared unique key as well as a primary key. Composite FK columns remain a single ordered constraint; splitting them into unrelated links would lose the context guarantee.

## Model-to-relation map

The five sheets collectively map to all 31 stored relations. Gray reference rectangles repeat an existing entity endpoint so relationships can be read locally. They denote the same entity type, introduce no additional relation, and do not change participation or cardinality. Each entity's full attribute cluster appears in its principal location.

| Sheet | ER entity or relationship | Stored relation | Mapping decision |
| --- | --- | --- | --- |
| Football | Competition | `sports.competitions` | UUID entity key; unique provider identity. |
| Football | CompetitionSeason | `sports.competition_seasons` | UUID key; required Competition FK; unique label within competition. |
| Football | Club | `sports.clubs` | UUID entity key; unique provider identity. |
| Football | SeasonClub registration | `sports.season_clubs` | Reified association; composite season/club PK and participant FKs. |
| Football | Player | `sports.players` | UUID entity key; unique provider identity. |
| Football | PlayerMembership | `sports.player_memberships` | UUID association key; Player and registered SeasonClub FKs; dated business uniqueness. |
| Football | Fixture | `sports.fixtures` | UUID key; required season and role-specific home/away registration FKs. |
| Football | Appearance | `sports.appearances` | UUID association key; unique fixture/player pair; optional matching club/membership context. |
| Context | StandingsSnapshot | `sports.standings_snapshots` | UUID key; required season and normalized revision; multiple observed revisions per cutoff allowed. |
| Context | StandingsRow | `sports.standings_rows` | Weak owner/discriminator identity `(snapshot_id, club_id)`; registered-club context. |
| Context | PointsAdjustment | `sports.points_adjustments` | UUID key; registered-club FK and dated provenance uniqueness. |
| Context | RosterSnapshot | `sports.roster_snapshots` | UUID key; required season and individually unique source observation FK. |
| Context | RosterEntry | `sports.roster_entries` | Composite snapshot/player/club identity; retains conflicting club observations. |
| Evidence | SourceRevision | `sports.source_revisions` | UUID key; unique source reference and timestamped content-observation identity. |
| Evidence | NormalizedRevision | `sports.normalized_revisions` | UUID key; unique ordinal; source FK and optional same-entity parent FK. |
| Evidence | IngestionBatch | `sports.ingestion_batches` | Archive identifier PK; required source and optional normalized revision FKs; SQL import receipt. |
| Evidence | ForecastRevision | `sports.forecast_revisions` | UUID key; Player FK, optional same-player parent, versioned inputs/provenance/result. |
| Evidence | CurrentForecast | `sports.forecast_heads` | Player PK/FK; required same-player revision pointer; current-evaluation relationship attributes. |
| Evidence | SupplementObservation | `sports.appearance_enrichments` | UUID key; appearance, fixture and separately named primary/fixture/source/normalized revision anchors. |
| Evidence | CurrentSupplement | `sports.appearance_enrichment_heads` | Appearance PK/FK; required same-appearance observation pointer; conflict/update relationship attributes. |
| Operations | OutboxEvent | `sports.outbox` | UUID key; unique deduplication key and event document. |
| Operations | Job | `sports.jobs` | UUID key; required OutboxEvent FK; unique deduplication key and processing lifecycle. |
| Operations | AuditEvent | `sports.audit_log` | UUID key; optional normalized revision FK; durable actor text is not an AuthUser FK. |
| Operations | ProviderRequest | `sports.provider_requests` | UUID key; independent request-reservation history. |
| Operations | EnrichmentQuota | `sports.enrichment_request_quota` | Provider PK; independent shared daily quota state. |
| Operations | SchemaMigration | `infra.schema_migrations` | Filename PK; independent applied-migration ledger. |
| Authentication | AuthUser | `auth."user"` | Text key; case-insensitive unique email. |
| Authentication | AuthSession | `auth.session` | Text key; User FK, unique token and server-side persistence mode. |
| Authentication | AuthAccount | `auth.account` | Text key; User FK and unique provider/account pair. |
| Authentication | AuthVerification | `auth.verification` | Text key; independent verification record, with no User FK. |
| Authentication | AuthRateLimit | `auth."rateLimit"` | Text key; unique request key, with no User FK. |

## Logical structure and physical constraints

The relational diagrams show each relation as a **horizontal strip of named attribute cells**, with every primary-key component underlined. Arrows run from the referencing FK attribute group to its referenced key group. A composite FK is one ordered group, even when its connector branches to several cells; it is not several independent scalar FKs. Group labels connect each arrow to the exact constraint in the dictionary. This relational notation is distinct from Chen entity rectangles, relationship diamonds and attribute ellipses.

The diagrams show every stored attribute name, while the dictionary supplies complete types, nullability, PKs, unique constraints and ordered FK source/target columns. Nullable columns remain nullable; missing observations are not converted to zero. The dictionary includes unique indexes as well as table-level unique constraints, including expression-based uniqueness such as case-insensitive email. A nullable FK can make the referenced parent optional for that row; a nonnull FK does not by itself require the parent to have any children.

Stable players and clubs, season registrations, temporal memberships, fixtures, observations and immutable revisions are separate facts. The implementation also deliberately repeats context columns so composite FKs can reject cross-season, cross-player and cross-appearance records. For example, `fixture_id` determines an appearance’s `season_id`, and `snapshot_id` determines the repeated `season_id` in standings rows and roster entries.

These repetitions are enforced physical design choices, so the whole implementation should not be described as uniformly in 3NF or BCNF. In the composite-key row and roster relations, `snapshot_id` is a proper subset of the PK and determines `season_id`, creating a partial dependency. In Appearance, fixture-to-season context creates a transitive dependency from its UUID key. Redundant unique supersets such as `(id, season_id)` exist to support these composite references, not to claim additional minimal candidate keys.

Some rules require more than keys and cardinalities: memberships cover a half-open interval; appearance context depends on participation; fixture sides must differ; complete standings require the expected registrations and rows; revision parents must be earlier; supplement anchors must match current primary evidence; and job leases must fit lifecycle state. Check constraints, deferred triggers and database privileges preserve these rules alongside the structural FK model. Required child FKs alone do not guarantee complete snapshots, source freshness or forecast eligibility.

## Documents, archives and derived results

SQL JSONB columns retain structured payloads, validation issues, audit details and immutable forecast or matching evidence. They are document-valued columns, not invented SQL entity tables. IDs inside a JSON document do not gain referential integrity unless a declared SQL constraint supplies it. Their storage is a deliberate evidence boundary, not a claim that every document has been decomposed into a textbook normalized relation.

MongoDB `raw_archives` preserves actual source-response observations, while `import_metadata` tracks their processing state. The shared archive identifier and SQL archive references are application correlations, not SQL-to-Mongo foreign keys. A source revision can also represent an explicit manual correction without a provider archive. No distributed SQL/Mongo transaction or automatic cross-store referential constraint is implied.

`sports.effective_appearances` is a derived view over primary appearances and valid current supplements. It fills only null rating, key passes, tackles and interceptions; preserves primary identity, minutes and numeric zero; checks current revision anchors and conflict state; and reports per-field provenance. It has no separate stored appearance identity. Likewise, the Chen `goal_difference` ellipse is computed from stored standings fields and adds no column. Immutable saved forecast revisions remain stored entities even though their results were calculated.

For the conceptual/relational distinction and the meaning of candidate keys and FKs, see Wikipedia’s [Relational model](https://en.wikipedia.org/wiki/Relational_model) and [Database schema](https://en.wikipedia.org/wiki/Database_schema). Wikipedia’s [Weak entity](https://en.wikipedia.org/wiki/Weak_entity), corroborated by the UCT chapter, explains the owner-plus-partial-key identity used for StandingsRow.

## Complete relation definitions

The signatures below contain every stored column after migrations 001–013 and the
migration runner’s ledger definition. Column order follows PostgreSQL. `Fnn` labels
are shared with the schema diagrams; each label denotes one whole ordered FK tuple,
not independently valid scalar references. `PK` marks components of one combined
primary key. `UNIQUE` includes redundant supersets retained as composite FK targets;
it does not assert that every listed tuple is a minimal candidate key. Types use
PostgreSQL spelling in the dictionary. The diagrams show attribute names.

### 1. Football and registration

#### `sports.competitions`

```text
sports.competitions(id, provider, provider_id, name, country_name, timezone, coefficient, enabled, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `provider` | `text` | No | — | `'apifootball'::text` |
| `provider_id` | `text` | No | — | — |
| `name` | `text` | No | — | — |
| `country_name` | `text` | No | — | — |
| `timezone` | `text` | No | — | — |
| `coefficient` | `numeric(2,1)` | No | — | — |
| `enabled` | `boolean` | No | — | `false` |
| `normalized_revision_id` | `uuid` | Yes | F21 | — |

```sql
-- F21
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
PRIMARY KEY (id)
UNIQUE (provider, provider_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((coefficient = ANY (ARRAY[1.5, 2.0])))
CHECK ((btrim(country_name) <> ''::text))
CHECK ((btrim(name) <> ''::text))
CHECK ((btrim(provider) <> ''::text))
CHECK ((btrim(provider_id) <> ''::text))
CHECK ((btrim(timezone) <> ''::text))
```

</details>

#### `sports.competition_seasons`

```text
sports.competition_seasons(id, competition_id, label, starts_on, ends_on, expected_clubs, enabled, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `competition_id` | `uuid` | No | F19 | — |
| `label` | `text` | No | — | — |
| `starts_on` | `date` | No | — | — |
| `ends_on` | `date` | No | — | — |
| `expected_clubs` | `smallint` | No | — | — |
| `enabled` | `boolean` | No | — | `false` |
| `normalized_revision_id` | `uuid` | Yes | F20 | — |

```sql
-- F19
FOREIGN KEY (competition_id) REFERENCES sports.competitions(id)
-- F20
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
PRIMARY KEY (id)
UNIQUE (competition_id, label)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((ends_on >= starts_on))
CHECK ((expected_clubs >= 2))
CHECK ((btrim(label) <> ''::text))
```

</details>

#### `sports.clubs`

```text
sports.clubs(id, provider, provider_id, name, normalized_revision_id, provider_slug)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `provider` | `text` | No | — | `'apifootball'::text` |
| `provider_id` | `text` | No | — | — |
| `name` | `text` | No | — | — |
| `normalized_revision_id` | `uuid` | Yes | F18 | — |
| `provider_slug` | `text` | Yes | — | — |

```sql
-- F18
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
PRIMARY KEY (id)
UNIQUE (provider, provider_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((btrim(name) <> ''::text))
CHECK ((btrim(provider) <> ''::text))
CHECK ((btrim(provider_id) <> ''::text))
```

</details>

#### `sports.season_clubs`

```text
sports.season_clubs(season_id, club_id, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `season_id` | `uuid` | No | PK, F49 | — |
| `club_id` | `uuid` | No | PK, F47 | — |
| `normalized_revision_id` | `uuid` | Yes | F48 | — |

```sql
-- F47
FOREIGN KEY (club_id) REFERENCES sports.clubs(id)
-- F48
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F49
FOREIGN KEY (season_id) REFERENCES sports.competition_seasons(id)
PRIMARY KEY (season_id, club_id)
```

#### `sports.players`

```text
sports.players(id, provider, provider_id, name, position, normalized_revision_id, provider_slug)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `provider` | `text` | No | — | `'apifootball'::text` |
| `provider_id` | `text` | No | — | — |
| `name` | `text` | No | — | — |
| `position` | `text` | No | — | `'UNKNOWN'::text` |
| `normalized_revision_id` | `uuid` | Yes | F38 | — |
| `provider_slug` | `text` | Yes | — | — |

```sql
-- F38
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
PRIMARY KEY (id)
UNIQUE (provider, provider_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((btrim(name) <> ''::text))
CHECK (("position" = ANY (ARRAY['GK'::text, 'DEF'::text, 'MID'::text, 'FWD'::text, 'UNKNOWN'::text])))
CHECK ((btrim(provider) <> ''::text))
CHECK ((btrim(provider_id) <> ''::text))
```

</details>

#### `sports.player_memberships`

```text
sports.player_memberships(id, player_id, club_id, season_id, valid_from, valid_until, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `player_id` | `uuid` | No | F36 | — |
| `club_id` | `uuid` | No | F37 | — |
| `season_id` | `uuid` | No | F37 | — |
| `valid_from` | `timestamp with time zone` | No | — | — |
| `valid_until` | `timestamp with time zone` | Yes | — | — |
| `normalized_revision_id` | `uuid` | Yes | F35 | — |

```sql
-- F35
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F36
FOREIGN KEY (player_id) REFERENCES sports.players(id)
-- F37
FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id)
PRIMARY KEY (id)
UNIQUE (id, player_id, club_id, season_id)
UNIQUE (player_id, club_id, season_id, valid_from)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))
```

</details>

#### `sports.fixtures`

```text
sports.fixtures(id, provider, provider_id, season_id, home_club_id, away_club_id, kickoff_at, status, statistics_status, home_score, away_score, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `provider` | `text` | No | — | `'apifootball'::text` |
| `provider_id` | `text` | No | — | — |
| `season_id` | `uuid` | No | F23, F24, F25 | — |
| `home_club_id` | `uuid` | No | F25 | — |
| `away_club_id` | `uuid` | No | F23 | — |
| `kickoff_at` | `timestamp with time zone` | Yes | — | — |
| `status` | `text` | No | — | `'unknown'::text` |
| `statistics_status` | `text` | No | — | `'unknown'::text` |
| `home_score` | `integer` | Yes | — | — |
| `away_score` | `integer` | Yes | — | — |
| `normalized_revision_id` | `uuid` | Yes | F22 | — |

```sql
-- F22
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F23
FOREIGN KEY (season_id, away_club_id) REFERENCES sports.season_clubs(season_id, club_id)
-- F24
FOREIGN KEY (season_id) REFERENCES sports.competition_seasons(id)
-- F25
FOREIGN KEY (season_id, home_club_id) REFERENCES sports.season_clubs(season_id, club_id)
PRIMARY KEY (id)
UNIQUE (id, season_id)
UNIQUE (provider, provider_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((away_score >= 0))
CHECK ((home_club_id <> away_club_id))
CHECK ((home_score >= 0))
CHECK ((btrim(provider) <> ''::text))
CHECK ((btrim(provider_id) <> ''::text))
CHECK ((statistics_status = ANY (ARRAY['unknown'::text, 'missing'::text, 'partial'::text, 'complete'::text])))
CHECK ((status = ANY (ARRAY['unknown'::text, 'scheduled'::text, 'live'::text, 'final'::text, 'postponed'::text, 'cancelled'::text, 'suspended'::text])))
```

</details>

#### `sports.appearances`

```text
sports.appearances(id, fixture_id, player_id, season_id, club_id, membership_id, participation, minutes, rating, goals, assists, shots_on_target, key_passes, tackles, interceptions, saves, goals_conceded, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `fixture_id` | `uuid` | No | F12 | — |
| `player_id` | `uuid` | No | F14, F16 | — |
| `season_id` | `uuid` | No | F12, F14 | — |
| `club_id` | `uuid` | Yes | F11, F14 | — |
| `membership_id` | `uuid` | Yes | F13, F14 | — |
| `participation` | `text` | No | — | `'unknown'::text` |
| `minutes` | `integer` | Yes | — | — |
| `rating` | `numeric(4,2)` | Yes | — | — |
| `goals` | `integer` | Yes | — | — |
| `assists` | `integer` | Yes | — | — |
| `shots_on_target` | `integer` | Yes | — | — |
| `key_passes` | `integer` | Yes | — | — |
| `tackles` | `integer` | Yes | — | — |
| `interceptions` | `integer` | Yes | — | — |
| `saves` | `integer` | Yes | — | — |
| `goals_conceded` | `integer` | Yes | — | — |
| `normalized_revision_id` | `uuid` | Yes | F15 | — |

```sql
-- F11
FOREIGN KEY (club_id) REFERENCES sports.clubs(id)
-- F12
FOREIGN KEY (fixture_id, season_id) REFERENCES sports.fixtures(id, season_id)
-- F13
FOREIGN KEY (membership_id) REFERENCES sports.player_memberships(id)
-- F14
FOREIGN KEY (membership_id, player_id, club_id, season_id) REFERENCES sports.player_memberships(id, player_id, club_id, season_id)
-- F15
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F16
FOREIGN KEY (player_id) REFERENCES sports.players(id)
PRIMARY KEY (id)
UNIQUE (fixture_id, player_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((assists >= 0))
CHECK (((participation = 'unknown'::text) OR ((club_id IS NOT NULL) AND (membership_id IS NOT NULL))))
CHECK (((membership_id IS NULL) OR (club_id IS NOT NULL)))
CHECK (((participation <> 'dnp'::text) OR ((COALESCE(minutes, 0) = 0) AND (COALESCE(rating, (0)::numeric) = (0)::numeric) AND (COALESCE(goals, 0) = 0) AND (COALESCE(assists, 0) = 0) AND (COALESCE(shots_on_target, 0) = 0) AND (COALESCE(key_passes, 0) = 0) AND (COALESCE(tackles, 0) = 0) AND (COALESCE(interceptions, 0) = 0) AND (COALESCE(saves, 0) = 0) AND (COALESCE(goals_conceded, 0) = 0))))
CHECK ((goals >= 0))
CHECK ((goals_conceded >= 0))
CHECK ((interceptions >= 0))
CHECK ((key_passes >= 0))
CHECK ((minutes >= 0))
CHECK ((participation = ANY (ARRAY['unknown'::text, 'played'::text, 'dnp'::text])))
CHECK (((rating >= (0)::numeric) AND (rating <= (10)::numeric)))
CHECK ((saves >= 0))
CHECK ((shots_on_target >= 0))
CHECK ((tackles >= 0))
```

</details>

### 2. Standings and roster observations

#### `sports.standings_snapshots`

```text
sports.standings_snapshots(id, season_id, cutoff_local_date, cutoff_at, normalized_revision_id, complete, created_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `season_id` | `uuid` | No | F53 | — |
| `cutoff_local_date` | `date` | No | — | — |
| `cutoff_at` | `timestamp with time zone` | No | — | — |
| `normalized_revision_id` | `uuid` | No | F52 | — |
| `complete` | `boolean` | No | — | `false` |
| `created_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F52
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F53
FOREIGN KEY (season_id) REFERENCES sports.competition_seasons(id)
PRIMARY KEY (id)
UNIQUE (id, season_id)
UNIQUE (season_id, cutoff_local_date, normalized_revision_id)
```

#### `sports.standings_rows`

```text
sports.standings_rows(snapshot_id, season_id, club_id, position, rank_uncertain, played, wins, draws, losses, goals_for, goals_against, points)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `snapshot_id` | `uuid` | No | PK, F51 | — |
| `season_id` | `uuid` | No | F50, F51 | — |
| `club_id` | `uuid` | No | PK, F50 | — |
| `position` | `smallint` | No | — | — |
| `rank_uncertain` | `boolean` | No | — | `false` |
| `played` | `smallint` | No | — | — |
| `wins` | `smallint` | No | — | — |
| `draws` | `smallint` | No | — | — |
| `losses` | `smallint` | No | — | — |
| `goals_for` | `integer` | No | — | — |
| `goals_against` | `integer` | No | — | — |
| `points` | `integer` | No | — | — |

```sql
-- F50
FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id)
-- F51
FOREIGN KEY (snapshot_id, season_id) REFERENCES sports.standings_snapshots(id, season_id)
PRIMARY KEY (snapshot_id, club_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((played = ((wins + draws) + losses)))
CHECK ((draws >= 0))
CHECK ((goals_against >= 0))
CHECK ((goals_for >= 0))
CHECK ((losses >= 0))
CHECK ((played >= 0))
CHECK (("position" > 0))
CHECK ((wins >= 0))
```

</details>

#### `sports.points_adjustments`

```text
sports.points_adjustments(id, season_id, club_id, points, reason, effective_at, provenance_url, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `season_id` | `uuid` | No | F40 | — |
| `club_id` | `uuid` | No | F40 | — |
| `points` | `integer` | No | — | — |
| `reason` | `text` | No | — | — |
| `effective_at` | `timestamp with time zone` | No | — | — |
| `provenance_url` | `text` | No | — | — |
| `normalized_revision_id` | `uuid` | Yes | F39 | — |

```sql
-- F39
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F40
FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id)
PRIMARY KEY (id)
UNIQUE (season_id, club_id, effective_at, provenance_url)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((points <> 0))
CHECK ((provenance_url ~ '^https://'::text))
CHECK ((btrim(reason) <> ''::text))
```

</details>

#### `sports.roster_snapshots`

```text
sports.roster_snapshots(id, season_id, source_revision_id, observed_at, complete, normalized_revision_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `season_id` | `uuid` | No | F45 | — |
| `source_revision_id` | `uuid` | No | F46 | — |
| `observed_at` | `timestamp with time zone` | No | — | — |
| `complete` | `boolean` | No | — | — |
| `normalized_revision_id` | `uuid` | Yes | F44 | — |

```sql
-- F44
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F45
FOREIGN KEY (season_id) REFERENCES sports.competition_seasons(id)
-- F46
FOREIGN KEY (source_revision_id) REFERENCES sports.source_revisions(id)
PRIMARY KEY (id)
UNIQUE (id, season_id)
UNIQUE (source_revision_id)
```

#### `sports.roster_entries`

```text
sports.roster_entries(snapshot_id, season_id, player_id, club_id)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `snapshot_id` | `uuid` | No | PK, F43 | — |
| `season_id` | `uuid` | No | F42, F43 | — |
| `player_id` | `uuid` | No | PK, F41 | — |
| `club_id` | `uuid` | No | PK, F42 | — |

```sql
-- F41
FOREIGN KEY (player_id) REFERENCES sports.players(id)
-- F42
FOREIGN KEY (season_id, club_id) REFERENCES sports.season_clubs(season_id, club_id)
-- F43
FOREIGN KEY (snapshot_id, season_id) REFERENCES sports.roster_snapshots(id, season_id)
PRIMARY KEY (snapshot_id, player_id, club_id)
```

### 3. Provenance, supplements and forecasts

#### `sports.source_revisions`

```text
sports.source_revisions(id, provider, action, resource_key, archive_ref, content_sha256, retrieved_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `provider` | `text` | No | — | `'apifootball'::text` |
| `action` | `text` | No | — | — |
| `resource_key` | `text` | No | — | — |
| `archive_ref` | `text` | No | — | — |
| `content_sha256` | `text` | No | — | — |
| `retrieved_at` | `timestamp with time zone` | No | — | — |

```sql
PRIMARY KEY (id)
UNIQUE (archive_ref)
UNIQUE (provider, action, resource_key, content_sha256, retrieved_at)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((btrim(action) <> ''::text))
CHECK ((btrim(archive_ref) <> ''::text))
CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text))
CHECK ((btrim(provider) <> ''::text))
CHECK ((btrim(resource_key) <> ''::text))
```

</details>

#### `sports.normalized_revisions`

```text
sports.normalized_revisions(id, ordinal, source_revision_id, entity_type, entity_key, content_sha256, parent_id, created_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `ordinal` | `bigint` | No | — | GENERATED ALWAYS AS IDENTITY |
| `source_revision_id` | `uuid` | No | F34 | — |
| `entity_type` | `text` | No | F33 | — |
| `entity_key` | `text` | No | F33 | — |
| `content_sha256` | `text` | No | — | — |
| `parent_id` | `uuid` | Yes | F33 | — |
| `created_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F33
FOREIGN KEY (parent_id, entity_type, entity_key) REFERENCES sports.normalized_revisions(id, entity_type, entity_key)
-- F34
FOREIGN KEY (source_revision_id) REFERENCES sports.source_revisions(id)
PRIMARY KEY (id)
UNIQUE (id, entity_type, entity_key)
UNIQUE (ordinal)
UNIQUE (source_revision_id, entity_type, entity_key, content_sha256)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((parent_id IS DISTINCT FROM id))
CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text))
CHECK ((btrim(entity_key) <> ''::text))
CHECK ((btrim(entity_type) <> ''::text))
```

</details>

#### `sports.ingestion_batches`

```text
sports.ingestion_batches(archive_id, source_revision_id, normalized_revision_id, fixture_count, appearance_count, issues_json, committed_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `archive_id` | `text` | No | PK | — |
| `source_revision_id` | `uuid` | No | F31 | — |
| `normalized_revision_id` | `uuid` | Yes | F30 | — |
| `fixture_count` | `integer` | No | — | — |
| `appearance_count` | `integer` | No | — | — |
| `issues_json` | `jsonb` | No | — | — |
| `committed_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F30
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F31
FOREIGN KEY (source_revision_id) REFERENCES sports.source_revisions(id)
PRIMARY KEY (archive_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((appearance_count >= 0))
CHECK ((archive_id ~ '^[0-9a-f]{64}$'::text))
CHECK ((fixture_count >= 0))
CHECK ((jsonb_typeof(issues_json) = 'array'::text))
```

</details>

#### `sports.appearance_enrichments`

```text
sports.appearance_enrichments(id, appearance_id, fixture_id, primary_revision_id, fixture_revision_id, source_revision_id, normalized_revision_id, external_fixture_id, external_player_id, retrieved_at, rating, key_passes, tackles, interceptions, evidence_json)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `appearance_id` | `uuid` | No | F05 | — |
| `fixture_id` | `uuid` | No | F06 | — |
| `primary_revision_id` | `uuid` | No | F09 | — |
| `fixture_revision_id` | `uuid` | No | F07 | — |
| `source_revision_id` | `uuid` | No | F10 | — |
| `normalized_revision_id` | `uuid` | No | F08 | — |
| `external_fixture_id` | `text` | No | — | — |
| `external_player_id` | `text` | No | — | — |
| `retrieved_at` | `timestamp with time zone` | No | — | — |
| `rating` | `numeric(4,2)` | Yes | — | — |
| `key_passes` | `integer` | Yes | — | — |
| `tackles` | `integer` | Yes | — | — |
| `interceptions` | `integer` | Yes | — | — |
| `evidence_json` | `jsonb` | No | — | — |

```sql
-- F05
FOREIGN KEY (appearance_id) REFERENCES sports.appearances(id)
-- F06
FOREIGN KEY (fixture_id) REFERENCES sports.fixtures(id)
-- F07
FOREIGN KEY (fixture_revision_id) REFERENCES sports.normalized_revisions(id)
-- F08
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
-- F09
FOREIGN KEY (primary_revision_id) REFERENCES sports.normalized_revisions(id)
-- F10
FOREIGN KEY (source_revision_id) REFERENCES sports.source_revisions(id)
PRIMARY KEY (id)
UNIQUE (id, appearance_id)
UNIQUE (normalized_revision_id)
UNIQUE (source_revision_id, appearance_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((jsonb_typeof(evidence_json) = 'object'::text))
CHECK ((external_fixture_id ~ '^[1-9][0-9]{0,17}$'::text))
CHECK ((external_player_id ~ '^[1-9][0-9]{0,17}$'::text))
CHECK ((interceptions >= 0))
CHECK ((key_passes >= 0))
CHECK (((rating >= (0)::numeric) AND (rating <= (10)::numeric)))
CHECK (isfinite(retrieved_at))
CHECK ((tackles >= 0))
```

</details>

#### `sports.appearance_enrichment_heads`

```text
sports.appearance_enrichment_heads(appearance_id, enrichment_id, conflicted, updated_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `appearance_id` | `uuid` | No | PK, F03, F04 | — |
| `enrichment_id` | `uuid` | No | F04 | — |
| `conflicted` | `boolean` | No | — | `false` |
| `updated_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F03
FOREIGN KEY (appearance_id) REFERENCES sports.appearances(id)
-- F04
FOREIGN KEY (enrichment_id, appearance_id) REFERENCES sports.appearance_enrichments(id, appearance_id)
PRIMARY KEY (appearance_id)
```

#### `sports.forecast_revisions`

```text
sports.forecast_revisions(id, ordinal, player_id, parent_id, model_version, input_hash, source_ordinal, cutoff_at, input_json, provenance_json, result_json, created_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `ordinal` | `bigint` | No | — | GENERATED ALWAYS AS IDENTITY |
| `player_id` | `uuid` | No | F28, F29 | — |
| `parent_id` | `uuid` | Yes | F28 | — |
| `model_version` | `text` | No | — | — |
| `input_hash` | `text` | No | — | — |
| `source_ordinal` | `bigint` | No | — | — |
| `cutoff_at` | `timestamp with time zone` | No | — | — |
| `input_json` | `jsonb` | No | — | — |
| `provenance_json` | `jsonb` | No | — | — |
| `result_json` | `jsonb` | No | — | — |
| `created_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F28
FOREIGN KEY (parent_id, player_id) REFERENCES sports.forecast_revisions(id, player_id)
-- F29
FOREIGN KEY (player_id) REFERENCES sports.players(id)
PRIMARY KEY (id)
UNIQUE (id, player_id)
UNIQUE (ordinal)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((parent_id IS DISTINCT FROM id))
CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text))
CHECK ((jsonb_typeof(input_json) = 'object'::text))
CHECK ((btrim(model_version) <> ''::text))
CHECK ((jsonb_typeof(provenance_json) = 'object'::text))
CHECK ((jsonb_typeof(result_json) = 'object'::text))
CHECK ((source_ordinal >= 0))
```

</details>

#### `sports.forecast_heads`

```text
sports.forecast_heads(player_id, revision_id, updated_at, evaluation_cutoff_at, evaluation_source_ordinal, evaluation_provenance_json, checked_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `player_id` | `uuid` | No | PK, F26, F27 | — |
| `revision_id` | `uuid` | No | F27 | — |
| `updated_at` | `timestamp with time zone` | No | — | `now()` |
| `evaluation_cutoff_at` | `timestamp with time zone` | No | — | — |
| `evaluation_source_ordinal` | `bigint` | No | — | — |
| `evaluation_provenance_json` | `jsonb` | No | — | — |
| `checked_at` | `timestamp with time zone` | No | — | — |

```sql
-- F26
FOREIGN KEY (player_id) REFERENCES sports.players(id)
-- F27
FOREIGN KEY (revision_id, player_id) REFERENCES sports.forecast_revisions(id, player_id)
PRIMARY KEY (player_id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((jsonb_typeof(evaluation_provenance_json) = 'object'::text))
CHECK ((evaluation_source_ordinal >= 0))
```

</details>

### 4. Processing and infrastructure

#### `sports.outbox`

```text
sports.outbox(id, event_type, aggregate_type, aggregate_id, deduplication_key, payload, created_at, published_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `event_type` | `text` | No | — | — |
| `aggregate_type` | `text` | No | — | — |
| `aggregate_id` | `uuid` | No | — | — |
| `deduplication_key` | `text` | No | — | — |
| `payload` | `jsonb` | No | — | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | No | — | `now()` |
| `published_at` | `timestamp with time zone` | Yes | — | — |

```sql
PRIMARY KEY (id)
UNIQUE (deduplication_key)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((btrim(aggregate_type) <> ''::text))
CHECK (((published_at IS NULL) OR (published_at >= created_at)))
CHECK ((btrim(deduplication_key) <> ''::text))
CHECK ((btrim(event_type) <> ''::text))
CHECK ((jsonb_typeof(payload) = 'object'::text))
```

</details>

#### `sports.jobs`

```text
sports.jobs(id, outbox_id, kind, deduplication_key, payload, status, attempts, max_attempts, run_after, locked_by, locked_until, last_error, created_at, completed_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `outbox_id` | `uuid` | No | F32 | — |
| `kind` | `text` | No | — | — |
| `deduplication_key` | `text` | No | — | — |
| `payload` | `jsonb` | No | — | `'{}'::jsonb` |
| `status` | `text` | No | — | `'ready'::text` |
| `attempts` | `integer` | No | — | `0` |
| `max_attempts` | `integer` | No | — | `5` |
| `run_after` | `timestamp with time zone` | No | — | `now()` |
| `locked_by` | `text` | Yes | — | — |
| `locked_until` | `timestamp with time zone` | Yes | — | — |
| `last_error` | `text` | Yes | — | — |
| `created_at` | `timestamp with time zone` | No | — | `now()` |
| `completed_at` | `timestamp with time zone` | Yes | — | — |

```sql
-- F32
FOREIGN KEY (outbox_id) REFERENCES sports.outbox(id)
PRIMARY KEY (id)
UNIQUE (deduplication_key)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((attempts >= 0))
CHECK ((attempts <= max_attempts))
CHECK (((status <> 'ready'::text) OR (attempts < max_attempts)))
CHECK (((status = 'running'::text) = ((locked_by IS NOT NULL) AND (locked_until IS NOT NULL))))
CHECK (((locked_by IS NULL) = (locked_until IS NULL)))
CHECK (((status <> 'running'::text) OR (attempts > 0)))
CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) = (completed_at IS NOT NULL)))
CHECK (((completed_at IS NULL) OR (completed_at >= created_at)))
CHECK ((btrim(deduplication_key) <> ''::text))
CHECK ((btrim(kind) <> ''::text))
CHECK (((locked_by IS NULL) OR (btrim(locked_by) <> ''::text)))
CHECK ((max_attempts > 0))
CHECK ((jsonb_typeof(payload) = 'object'::text))
CHECK ((status = ANY (ARRAY['ready'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
```

</details>

#### `sports.audit_log`

```text
sports.audit_log(id, normalized_revision_id, actor_type, actor_id, action, entity_type, entity_key, detail, occurred_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `normalized_revision_id` | `uuid` | Yes | F17 | — |
| `actor_type` | `text` | No | — | — |
| `actor_id` | `text` | Yes | — | — |
| `action` | `text` | No | — | — |
| `entity_type` | `text` | No | — | — |
| `entity_key` | `text` | No | — | — |
| `detail` | `jsonb` | No | — | `'{}'::jsonb` |
| `occurred_at` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F17
FOREIGN KEY (normalized_revision_id) REFERENCES sports.normalized_revisions(id)
PRIMARY KEY (id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((btrim(action) <> ''::text))
CHECK ((actor_type = ANY (ARRAY['system'::text, 'user'::text, 'worker'::text, 'migrator'::text])))
CHECK (((actor_type <> 'user'::text) OR ((actor_id IS NOT NULL) AND (btrim(actor_id) <> ''::text))))
CHECK ((jsonb_typeof(detail) = 'object'::text))
CHECK ((btrim(entity_key) <> ''::text))
CHECK ((btrim(entity_type) <> ''::text))
```

</details>

#### `sports.provider_requests`

```text
sports.provider_requests(id, action, resource_key, attempted_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK | `gen_random_uuid()` |
| `action` | `text` | No | — | — |
| `resource_key` | `text` | No | — | — |
| `attempted_at` | `timestamp with time zone` | No | — | `now()` |

```sql
PRIMARY KEY (id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((action = ANY (ARRAY['get_teams'::text, 'get_events'::text, 'get_statistics'::text, 'get_standings'::text])))
CHECK ((btrim(resource_key) <> ''::text))
```

</details>

#### `sports.enrichment_request_quota`

```text
sports.enrichment_request_quota(provider, utc_day, remaining)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `provider` | `text` | No | PK | — |
| `utc_day` | `date` | No | — | — |
| `remaining` | `integer` | No | — | — |

```sql
PRIMARY KEY (provider)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((provider = 'highlightly'::text))
CHECK (((remaining >= 0) AND (remaining <= 100)))
```

</details>

#### `infra.schema_migrations`

```text
infra.schema_migrations(filename, checksum, applied_at)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `filename` | `text` | No | PK | — |
| `checksum` | `text` | No | — | — |
| `applied_at` | `timestamp with time zone` | No | — | `clock_timestamp()` |

```sql
PRIMARY KEY (filename)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))
CHECK ((filename ~ '^[0-9]{3}_[a-z][a-z0-9_]*[.]sql$'::text))
```

</details>

### 5. Authentication storage

#### `auth."user"`

```text
auth."user"(id, name, email, emailVerified, image, role, createdAt, updatedAt)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `text` | No | PK | — |
| `name` | `text` | No | — | — |
| `email` | `text` | No | — | — |
| `emailVerified` | `boolean` | No | — | `false` |
| `image` | `text` | Yes | — | — |
| `role` | `text` | No | — | `'viewer'::text` |
| `createdAt` | `timestamp with time zone` | No | — | `now()` |
| `updatedAt` | `timestamp with time zone` | No | — | `now()` |

```sql
PRIMARY KEY (id)
CREATE UNIQUE INDEX user_email_normalized_unique ON auth."user" USING btree (lower(email));
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((length(btrim(email)) > 3))
CHECK ((length(btrim(id)) > 0))
CHECK ((length(btrim(name)) > 0))
CHECK ((role = ANY (ARRAY['viewer'::text, 'admin'::text])))
```

</details>

#### `auth.session`

```text
auth.session(id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId, persistent)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `text` | No | PK | — |
| `expiresAt` | `timestamp with time zone` | No | — | — |
| `token` | `text` | No | — | — |
| `createdAt` | `timestamp with time zone` | No | — | `now()` |
| `updatedAt` | `timestamp with time zone` | No | — | `now()` |
| `ipAddress` | `text` | Yes | — | — |
| `userAgent` | `text` | Yes | — | — |
| `userId` | `text` | No | F02 | — |
| `persistent` | `boolean` | No | — | `false` |

```sql
-- F02
FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE
PRIMARY KEY (id)
UNIQUE (token)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK (("expiresAt" > "createdAt"))
CHECK ((length(btrim(id)) > 0))
CHECK ((length(btrim(token)) > 0))
```

</details>

#### `auth.account`

```text
auth.account(id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `text` | No | PK | — |
| `accountId` | `text` | No | — | — |
| `providerId` | `text` | No | — | — |
| `userId` | `text` | No | F01 | — |
| `accessToken` | `text` | Yes | — | — |
| `refreshToken` | `text` | Yes | — | — |
| `idToken` | `text` | Yes | — | — |
| `accessTokenExpiresAt` | `timestamp with time zone` | Yes | — | — |
| `refreshTokenExpiresAt` | `timestamp with time zone` | Yes | — | — |
| `scope` | `text` | Yes | — | — |
| `password` | `text` | Yes | — | — |
| `createdAt` | `timestamp with time zone` | No | — | `now()` |
| `updatedAt` | `timestamp with time zone` | No | — | `now()` |

```sql
-- F01
FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE
PRIMARY KEY (id)
UNIQUE ("providerId", "accountId")
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((length(btrim("accountId")) > 0))
CHECK ((length(btrim(id)) > 0))
CHECK ((length(btrim("providerId")) > 0))
```

</details>

#### `auth.verification`

```text
auth.verification(id, identifier, value, expiresAt, createdAt, updatedAt)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `text` | No | PK | — |
| `identifier` | `text` | No | — | — |
| `value` | `text` | No | — | — |
| `expiresAt` | `timestamp with time zone` | No | — | — |
| `createdAt` | `timestamp with time zone` | No | — | `now()` |
| `updatedAt` | `timestamp with time zone` | No | — | `now()` |

```sql
PRIMARY KEY (id)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((length(btrim(id)) > 0))
CHECK ((length(btrim(identifier)) > 0))
CHECK ((length(btrim(value)) > 0))
```

</details>

#### `auth."rateLimit"`

```text
auth."rateLimit"(id, key, count, lastRequest)
```

| Column | Type | Nullable | Key | Default |
| --- | --- | --- | --- | --- |
| `id` | `text` | No | PK | — |
| `key` | `text` | No | — | — |
| `count` | `integer` | No | — | — |
| `lastRequest` | `bigint` | No | — | — |

```sql
PRIMARY KEY (id)
UNIQUE (key)
```

<details>
<summary>Column and row CHECK constraints</summary>

```sql
CHECK ((count >= 0))
CHECK ((btrim(id) <> ''::text))
CHECK ((btrim(key) <> ''::text))
CHECK (("lastRequest" >= 0))
```

</details>
