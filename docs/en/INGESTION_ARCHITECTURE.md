# Ingestion Architecture

- **简体中文：** [../zh/INGESTION_ARCHITECTURE.md](../zh/INGESTION_ARCHITECTURE.md)
- **Status:** Phase 1 implementation architecture
- **Related:** RFC 0005, RFC 0006, RFC 0007, [Technology stack](TECH_STACK.md), and [Message orchestration](MESSAGE_ORCHESTRATION.md)

## 1. Purpose

Phase 1 is a local-first ingestion foundation for one person. Native input and connectors are converted into `IngestBatch` records and persisted as RFC-shaped Blob and Event records. The Org overlay later uses the same contract without replacing the Personal pipeline.

Connectors are the receive half of [message orchestration](MESSAGE_ORCHESTRATION.md). Send (`EgressAdapter`) comes later. It is not part of this ingest core.

The design rule:

> Adapters translate. The ingestion core validates, authorizes, deduplicates, stores, and audits.

A connector never writes Event, Blob, identity, or access-policy records directly. Source-specific behavior stays outside product invariants, so adding a source does not duplicate boundary, storage, or reliability logic.

For collaboration sources, agent turns are provenance-bearing records, not authority. See [Context platform integration architecture](CONTEXT_PLATFORM_INTEGRATION.md).

## 2. Scope

### 2.1 Goals

- Support native API input, webhooks, polling, and backfill through one pipeline.
- Preserve source identity, timestamps, authorship, thread structure, provenance, and access scope.
- Store content through the `BlobStore` port and thin Event metadata through `AuthorityStore`.
- Make retries safe through deterministic idempotency.
- Handle edits, recalls, deletes, partial batches, and out-of-order delivery.
- Enforce the local principal boundary in Personal and fail closed when Org identity or ACL mapping is unresolved.
- Isolate connector failures and apply per-connector backpressure.
- Produce auditable Event records suitable for later distillation.
- Keep connector and storage implementations replaceable behind stable ports.

### 2.2 Out of scope

- Digest generation or daily distillation.
- Claim extraction, context snapshots, or knowledge graph construction.
- LLM calls, embeddings, or semantic search.
- Standard lifecycle implementation.
- A connector marketplace.
- Cross-source entity resolution beyond explicit external identity mappings.
- Exactly-once delivery from third-party systems. Regenic guarantees idempotent effects instead.

## 3. Invariants

1. Every accepted source record passes through the same ingestion application service.
2. Every Event belongs to an authority boundary: the local principal in Personal, or an organization and ACL scope in Org.
3. Missing or ambiguous Org ACL mapping never defaults to organization-wide visibility.
4. Blob bytes have no standalone read path. Reads are authorized through a referencing Event.
5. Event bodies do not live in `AuthorityStore` except for the RFC-limited preview.
6. `(org_id, source, external_id)` identifies one source occurrence and is idempotent.
7. A connector cursor advances only after all preceding records are committed or durably quarantined.
8. Source retries may repeat work but may not create duplicate effects.
9. Connector code cannot broaden permissions, mint privileged principals, or bypass validation.
10. Post-ingest work starts from a committed durable job record, not from uncommitted state. Personal may process it in-process; Org may publish it through an outbox to BullMQ.
11. UTC is used for storage. Useful source timezone and timestamp representations remain in metadata.
12. Raw source payloads are not retained by default after canonicalization.

## 4. Context

```text
Native clients                 External systems
     |                       webhook | poll | backfill
     |                               |
     v                               v
Native adapter              ChannelConnector drivers
     |                               |
     +---------- IngestBatch --------+
                       |
                       v
               Ingestion Service
          validate | map | authorize
          canonicalize | hash | dedupe
                       |
             +---------+----------+
             |                    |
             v                    v
      BlobStore port         AuthorityStore port
      canonical bytes        Event metadata
              boundary / policy refs
              cursor / quarantine
              durable job records
                                   |
                                   v
              JobQueue port
                         index | distill | notify later
```

## 5. Components

### 5.1 ChannelConnector

A driver understands one source protocol. It may verify signatures, call source APIs, normalize records, and report capabilities. It does not own persistence or authorization decisions.

```ts
interface ChannelConnector {
  readonly source: string;

  capabilities(): ConnectorCapabilities;
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
  handleWebhook(webhook: VerifiedWebhook): Promise<IngestBatch>;
  poll(cursor: ConnectorCursor | null): Promise<PollResult>;
  backfill(range: BackfillRange): AsyncIterable<IngestBatch>;
  syncMembers(scope: ExternalScopeRef): Promise<MembershipBatch>;
}

interface ConnectorCapabilities {
  webhook: boolean;
  poll: boolean;
  backfill: boolean;
  member_sync: boolean;
  edits: boolean;
  tombstones: boolean;
  attachments: boolean;
}
```

Capabilities are explicit. Orchestration never infers behavior from a driver name.

### 5.2 Connector Orchestrator

The orchestrator runs webhook, poll, backfill, and, for Org, membership-sync workflows. It owns scheduling, cursor progression, rate limits, retry policy, and queue isolation. Each connector installation has an independent logical queue and concurrency limit. Personal uses the in-process `JobQueue` driver; Org may use BullMQ.

### 5.3 Ingestion Service

The ingestion service is the only application boundary allowed to create or change Events. It owns:

- schema and connector installation validation;
- authority-boundary checks;
- external principal and scope resolution;
- canonical content generation;
- content hashing and Blob writes;
- Event idempotency and revision handling;
- tombstones and quarantine decisions;
- kernel disposition after accept (filter / layer); the Event remains as evidence;
- audit records and durable post-ingest job creation.

### 5.4 Boundary Resolver

In Personal, the boundary resolver maps imported records to the one local principal and records the external actor as provenance. A connector cannot escape that local authority boundary.

In Org, identity and scope resolvers map `ExternalPrincipalRef` and `ExternalScopeRef` to RFC 0006 Principal and ACL scopes. An unresolved identity or scope is quarantined. It never falls back to organization scope for convenience.

### 5.5 Content Canonicalizer

Canonicalization is selected by media type and schema version, not by connector. It produces stable bytes before hashing.

- Text uses UTF-8 and normalized line endings without transport wrappers.
- JSON uses a defined schema projection and deterministic key ordering.
- Files retain original bytes while metadata is stored separately.
- Rich text retains the source representation as a Blob; a plain-text projection is a separate derived artifact.

Canonicalization must not silently remove meaningful content. A lossy projection cannot replace the source Blob.

### 5.6 BlobStore

The RFC port remains minimal:

```ts
interface BlobStore {
  put(hash: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(hash: string): Promise<Uint8Array>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
}
```

`put` is idempotent for identical bytes. The ingestion service computes the hash; a driver-provided hash is never trusted.

### 5.7 AuthorityStore

`AuthorityStore` is the relational source-of-truth port. SQLite is the Personal default and PostgreSQL is the Org default. Drivers preserve the same operations and transaction semantics:

```ts
interface AuthorityStore {
  findBySourceIdentity(identity: SourceIdentity): Promise<EventRecord | null>;
  append(input: NewEvent): Promise<EventRecord>;
  appendRevision(input: EventRevision): Promise<EventRecord>;
  markTombstone(input: TombstoneEvent): Promise<EventRecord>;
  putDisposition(decision: ArrangementDecision): Promise<void>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  listInbox(orgId: string): Promise<InboxItem[]>;
}
```

`listInbox` returns only current source heads whose disposition is `current_work`. Tombstoned or later-noise Events stay in the store and stay out of the inbox. A current head with no disposition is arranged on the next ingest of that source identity, including a duplicate replay.

## 6. Canonical Input Contract

Connectors produce a versioned `IngestBatch`. This internal contract is independent of source SDKs.

```ts
interface IngestBatch {
  schema_version: "1.0";
  connector_id: string;
  org_id: string;
  delivery_id: string;
  records: IngestRecord[];
  next_cursor?: string;
  received_at: string;
}

interface IngestRecord {
  operation: "create" | "revise" | "tombstone";
  source: string;
  external_id: string;
  revision_id?: string;
  occurred_at: string;
  actor: ExternalPrincipalRef;
  scope: ExternalScopeRef;
  type: string;
  thread?: ExternalThreadRef;
  parent_external_id?: string;
  content?: ContentPart[];
  direction_tags?: string[];
  weight_hints?: WeightHints;
  attrs?: Record<string, JsonValue>;
}

interface ContentPart {
  role: "body" | "attachment" | "transcript" | "metadata";
  media_type: string;
  bytes?: Uint8Array;
  text?: string;
  external_locator?: string;
  source_filename?: string;
}
```

Contract rules:

- Exactly one of `bytes`, `text`, or `external_locator` is present for a content part.
- A connector fetches `external_locator` through its authenticated source client. The core never receives source credentials.
- `external_id` is deterministic and namespaced when a source account does not guarantee uniqueness within the active authority boundary.
- `delivery_id` deduplicates webhook or polling deliveries. It does not replace Event idempotency.
- Connector-specific fields remain in `attrs` and cannot contain long bodies or secrets.
- Unknown record types are rejected or quarantined according to connector version policy. They are never silently mapped to `message`.

## 7. Persistence

The accepted RFC records remain authoritative:

- `Blob`: content-addressed body metadata.
- `Event`: thin source occurrence with a Blob reference and ACL scope.
- Personal owner and source actor provenance.
- Org `Principal`, `AclScope`, and `AclMembership` when the Org overlay is enabled.

Reliable ingestion also requires operational records in `AuthorityStore`.

### 7.1 ConnectorInstallation

```text
id
org_id
source
status
config
credentials_ref
created_at
updated_at
```

Secret values never appear in `config`. Credentials are resolved through `SecretStore`.

### 7.2 ConnectorCursor

```text
connector_id
stream_key
cursor
updated_at
lease_owner
lease_expires_at
```

The lease prevents overlapping pollers. Cursor progression is committed with the completed batch outcome. Personal may use a process lease backed by SQLite; Org may use a distributed lease.

### 7.3 IngestAttempt

```text
id
org_id
connector_id
delivery_id
started_at
finished_at
status
accepted_count
duplicate_count
quarantined_count
error_code
```

This record contains operational metadata, not raw message bodies.

### 7.4 IngestQuarantine

```text
id
org_id
connector_id
delivery_id
record_identity
reason_code
safe_metadata
created_at
resolved_at
resolution
```

Quarantine data is deliberately minimal. Sensitive content remains at the source and can be refetched after the mapping problem is fixed. Diagnostic retention for non-refetchable sources requires an explicit encrypted retention policy.

### 7.5 OutboxMessage

```text
id
org_id
topic
aggregate_id
payload
created_at
published_at
attempt_count
```

The durable job payload contains identifiers and safe routing metadata, never Blob content. In Personal, an in-process worker consumes committed rows directly. In Org, a transactional outbox publisher may forward them to BullMQ.

## 8. Processing

### 8.1 Native API

1. Authenticate the local principal or Org principal.
2. Validate the active authority boundary and requested scope when applicable.
3. Convert the request to an `IngestBatch` through the native adapter.
4. Call the same ingestion service used by external connectors.
5. Return per-record outcomes and stable Event identifiers.

### 8.2 Webhook

1. Resolve the connector installation from the route, not request data.
2. Apply request size and rate limits.
3. Verify signature and replay window before parsing business content.
4. Convert the verified payload to an `IngestBatch`.
5. Persist canonical outcomes before returning success.
6. Return a retryable status only when no durable outcome exists.
7. Publish post-ingest work asynchronously from the outbox.

Canonical persistence happens before acknowledgement so the only source copy is never an uncommitted queue message.

### 8.3 Polling

1. Acquire the connector stream lease.
2. Read the committed cursor.
3. Fetch one bounded source page.
4. Convert the page to an `IngestBatch`.
5. Persist every record outcome.
6. Commit the next cursor only when every record is accepted, duplicate, or durably quarantined.
7. Release or renew the lease.

### 8.4 Backfill

Backfill reuses polling with a fixed time range, smaller concurrency, and lower priority. It cannot block real-time webhook ingestion. Backfill and webhook records converge through Event idempotency.

### 8.5 Per-record Flow

```text
validate IngestBatch
  -> validate connector and authority boundary
  -> resolve local owner or Org principal
  -> resolve personal source scope or Org ACL scope
  -> validate write permission
  -> canonicalize content
  -> compute SHA-256
  -> idempotent BlobStore.put
  -> append Event or revision in AuthorityStore
  -> kernel writes disposition (filter / layer)
  -> append audit and durable job rows
  -> return accepted | duplicate | quarantined
```

Event, audit, cursor outcome, and durable job changes use one `AuthorityStore` transaction. Blob writes happen first and are idempotent. A failed transaction may leave an unreferenced Blob for GC. The reverse order is forbidden because an Event must never reference missing bytes.

## 9. Idempotency and Source Changes

### 9.1 Create

The source identity is `(org_id, source, external_id)`. Repeating the same identity with the same canonical content hash returns the existing Event as a duplicate success.

### 9.2 Conflicting Duplicate

The same source identity with different content is not overwritten. It becomes:

- a revision when the connector supplies revision semantics;
- an out-of-order delivery when it matches a known revision;
- quarantine with `source_identity_conflict` when intent is ambiguous.

### 9.3 Revision

Revisions are append-only Events linked through `parent_event_id`. The original Event remains available for provenance. A stable source `revision_id` is preferred; otherwise the canonical hash contributes to a deterministic synthetic revision identity.

Current source state is resolved by source time plus ingestion ordering rules, while historical decisions keep their original Event references.

### 9.4 Tombstone

A recall or delete tombstones the target source occurrence and creates an audit record. It does not immediately delete Blob bytes. Retention and evidence references follow RFC 0005 GC rules.

A tombstone that arrives before its create is stored as a pending tombstone keyed by source identity. The later create is persisted already tombstoned.

### 9.5 Batch Outcomes

A batch is not all-or-nothing across independent records. Each record receives one durable outcome:

- `accepted`;
- `duplicate`;
- `quarantined`;
- `retryable_failure`.

A cursor cannot advance across `retryable_failure`. Quarantined records do not block it because their durable metadata supports later resolution.

## 10. Security

### 10.1 Trust Boundaries

- Incoming webhook bytes are untrusted until signature verification succeeds.
- Connector output remains untrusted input to the ingestion core.
- Source owner, organization, role, ACL, hash, and actor identifiers are never accepted as internal identifiers.
- Connector credentials stay behind `SecretStore` and source clients.

### 10.2 Personal and Org Boundaries

- Personal imports are readable only by the local principal. Source actors and channels remain provenance, not local authorization grants.
- Org external channels map to explicit `channel` scopes.
- Org membership synchronization grants or expires memberships but cannot create organization administrators.
- An Org record with no resolved scope is quarantined.
- An Org service principal can write only to configured scopes and only with `can_write_event`.
- Event previews inherit the Blob sensitivity.
- Operational logs cannot include body text, attachment bytes, access tokens, or signed webhook payloads.

### 10.3 Limits

Configurable limits apply at the edge and in the core:

- request bytes;
- records per batch;
- content parts per record;
- body, attachment, and decompressed bytes;
- connector requests per interval;
- backfill range and concurrency.

Archive and document parsers must defend against decompression bombs, path traversal, and malformed media.

## 11. Failure Handling

| Class | Examples | Result |
| --- | --- | --- |
| Permanent input | Invalid schema, unsupported type | Quarantine |
| Mapping | Unknown actor or scope | Quarantine and alert |
| Authorization | Connector cannot write scope | Reject, audit, no retry |
| Source transient | Timeout, 429, 5xx | Source-aware retry |
| Storage transient | AuthorityStore or BlobStore unavailable | Retry; do not advance cursor |
| Conflict | Ambiguous content for source identity | Quarantine |
| Internal defect | Invariant violation | Fail batch, alert, preserve cursor |

Retries use exponential backoff with jitter, honor `Retry-After`, and have bounded age and attempts. Each connector installation is isolated. Dead-letter queues provide operational visibility; durable resolution state stays in `AuthorityStore`.

## 12. Observability

### 12.1 Metrics

- records received, accepted, duplicate, quarantined, and failed;
- ingest latency by connector and operation;
- cursor lag and oldest unprocessed source timestamp;
- Blob bytes written and dedupe ratio;
- unresolved principal and scope counts;
- webhook signature and replay rejection counts;
- retry count, rate-limit time, and queue depth;
- outbox publish lag;
- Events missing Blob or required boundary references, which must remain zero.

### 12.2 Logs and Audit

Structured logs may contain correlation, attempt, connector, authority-boundary, safe source identity, result, and reason identifiers. They cannot contain bodies, secrets, authorization headers, or hidden previews.

Audit records cover connector installation changes, membership synchronization, Event create/revision/tombstone, quarantine resolution, and manual replay or backfill requests.

## 13. API Surface

Personal endpoints use the same resource shapes under the local principal scope:

```http
POST /v1/me/ingest/events
POST /v1/me/ingest/batches
GET  /v1/me/ingest/attempts/{attempt_id}
GET  /v1/me/events/{event_id}
GET  /v1/me/events/{event_id}/content
```

The Org overlay exposes corresponding organization-scoped endpoints:

```http
POST /v1/orgs/{org_id}/ingest/events
POST /v1/orgs/{org_id}/ingest/batches
GET  /v1/orgs/{org_id}/ingest/attempts/{attempt_id}
GET  /v1/orgs/{org_id}/events/{event_id}
GET  /v1/orgs/{org_id}/events/{event_id}/content
```

Connector administration remains separate from submission:

```http
POST /v1/orgs/{org_id}/connectors
GET  /v1/orgs/{org_id}/connectors
POST /v1/orgs/{org_id}/connectors/{connector_id}:test
POST /v1/orgs/{org_id}/connectors/{connector_id}:backfill
POST /v1/orgs/{org_id}/connectors/{connector_id}:sync_members
```

Webhook endpoints identify installations through opaque route tokens:

```http
POST /v1/connector-webhooks/{route_token}
```

A route token locates configuration but is not sufficient authentication. The driver still verifies the source signature.

## 14. Repository Layout

```text
apps/api/src/ingest/
  ingest.controller.ts
  connector-webhook.controller.ts
  ingest.module.ts

apps/worker/src/connectors/
  connector-orchestrator.ts
  poll.processor.ts
  backfill.processor.ts
  membership.processor.ts
  outbox.processor.ts

packages/domain/src/ingest/
  contracts.ts
  canonicalization.ts
  errors.ts
  outcomes.ts

packages/connectors/
  src/port.ts
  src/native/
  src/testing/

packages/blob-store/
  src/port.ts
  src/memory/
  src/fs/
  src/minio/

packages/authority-store/
  src/port.ts
  src/sqlite/
  src/postgres/
  migrations/
  src/events/
  src/connectors/

packages/job-queue/
  src/port.ts
  src/inprocess/
  src/bullmq/
```

The layout describes ownership boundaries, not a requirement to create every package immediately. Start with one vertical slice. Extract a package when at least two implementations exercise its boundary or an accepted RFC already mandates the port.

## 15. Delivery Slices

### 15.1 Contract Fixtures

- Define `IngestBatch`, outcomes, error codes, and canonicalization fixtures.
- Test duplicate create, conflicting duplicate, revision, tombstone, unresolved ACL, and out-of-order delivery.
- Establish a connector conformance test harness.

Exit: native and external adapters can reuse the same contract tests.

### 15.2 Local Personal Ingestion

- Add minimum SQLite migrations for Event, Blob metadata, personal boundary, ingest attempt, quarantine, and durable job records.
- Implement an in-memory BlobStore for tests and the local filesystem driver.
- Implement the ingestion service and `/v1/me` batch endpoint.
- Add transactional integration tests with the in-process job queue.

Exit: submitting the same text twice returns one Event with stable provenance and local ownership.

### 15.3 Reliable Operations

- Add outbox publishing, retries, metrics, audit, and quarantine inspection.
- Add revision, tombstone, and pending tombstone behavior.
- Add content download authorized through Event.

Exit: failure injection demonstrates no missing Blob references, cursor loss, or boundary widening.

### 15.4 Connector Conformance

- Provide a fake connector and conformance suite.
- Validate capabilities, deterministic external IDs, batch limits, membership mapping, retries, and cursor rules.

Exit: a new connector can prove core compatibility without a third-party service.

### 15.5 First Real Connector

- Implement only the source capabilities required by the first real workflow.
- Run the conformance suite and a sandbox end-to-end test.

Exit: one person can ingest a real channel locally through webhook or polling, and its data converges with native input through the same ingestion service.

## 16. Acceptance Criteria

1. Replaying the same native request, webhook, poll page, or backfill page does not duplicate Events or Blobs.
2. Two Personal authority stores, or two organizations, may use identical source identifiers without collision.
3. A connector installation cannot write outside its local owner or organization boundary.
4. Personal imports remain local; unknown Org actor or scope data is quarantined and never becomes organization-visible.
5. A caller outside the active authority boundary cannot read an Event preview or Blob.
6. A valid edit creates a linked revision without changing historical evidence.
7. A recall hides content according to policy and retains evidence-required bytes for GC.
8. A tombstone received before a create produces a tombstoned Event when the create arrives.
9. AuthorityStore failure does not advance the connector cursor.
10. Queue or outbox failure does not lose the committed Event.
11. Blob write followed by database failure leaves no broken Event reference and remains GC-eligible.
12. One failing or rate-limited connector does not block other installations.
13. Logs, metrics, quarantine rows, and outbox messages contain no content or secrets.
14. Native, fake, and the first real connector adapters pass the connector conformance suite.
