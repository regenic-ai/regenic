# Sync scalability acceptance

This checklist is the release gate for the large-scale sync architecture. It
targets one installation with 10,000 streams and 10 million ingested records.
It supplements, rather than weakens, the cursor and ingestion invariants in
[Ingestion architecture](INGESTION_ARCHITECTURE.md).

## Architecture gates

- Core packages and applications do not import concrete `*-connector`
  packages. Connectors depend only on the connector contract/SDK and cannot
  access Authority, Blob, Ingest, Recipe, or UI services.
- Core invokes sources through a versioned, serializable `ConnectorInvoker`
  contract. The embedded and remote adapters pass the same conformance suite.
- The API is a control plane. Long-running catalog, live, history, media, and
  projection work runs through a durable work claim.
- SQLite has exactly one writer. PostgreSQL workers claim rows with
  `FOR UPDATE SKIP LOCKED`. Redis/BullMQ may wake workers but is not the source
  of truth.
- Cloud blobs use a shared object-store implementation. A local filesystem
  blob root is valid only for the single-instance Personal profile.

## Product gates

- A manual sync returns a run identifier and can be queried, paused, resumed,
  and cancelled. Cancelling stops future polls and does not roll back accepted
  records.
- The product distinguishes quick start, continuous freshness, and archive
  backfill. Unknown totals never produce a fake percentage.
- Progress exposes catalog coverage, recent readiness, archive coverage,
  freshness, throughput, throttling/error reason, and an ETA range when one can
  be estimated.
- Quarantined records are visible and retryable without resetting unrelated
  cursors.

## Performance gates

- Opening an eligible thread completes its interactive refresh in under
  3 seconds at p95 when the source is healthy.
- Webhook/delta-capable hot streams have freshness under 60 seconds at p95.
  Poll-only sources publish their effective freshness instead of claiming the
  same SLO.
- API latency remains under 300 ms at p95 while archive backfill is active.
- Planning 10,000 steady streams uses an indexed due-work query and does not
  load every catalog member, state, or cursor on each tick.
- The load harness records queue lag, freshness, source latency, ingest
  throughput, database transaction time, writer wait, lease conflicts,
  throttles/429s, retries, API latency, process memory, and SQLite WAL size.

## Recovery gates

- Killing a worker after claim and before settle does not advance the cursor;
  the expired lease is reclaimed and the page can be replayed safely.
- Two PostgreSQL workers never settle the same work lease concurrently.
- Replayed webhook deliveries and poll pages remain idempotent.
- Pause, resume, cancellation, connector-host timeout, protocol mismatch,
  database delay, source 429, and process restart have automated coverage.
- The SQLite deployment refuses a replica count above one. Cloud deployments
  run multiple API replicas without starting duplicate in-process timers.

## Removal gate

The legacy timer/full-scan path and direct connector imports may be removed
only after typecheck, the full test suite, dependency-boundary checks,
SQLite/PostgreSQL port contracts, connector conformance, failure injection,
and the 10,000-stream load scenario pass.
