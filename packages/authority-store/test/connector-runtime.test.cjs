const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { SqliteAuthorityStore } = require("../dist");

const roots = [];
const installation = {
  id: "installation-1",
  org_id: "local-owner",
  connector_type: "fake-poll",
  status: "enabled",
  config: { scope: "personal" },
  created_at: "2026-08-12T00:00:00.000Z",
};
const leaseInput = {
  installation_id: installation.id,
  stream_key: "personal",
  lease_owner: "worker-a",
  now: "2026-08-12T00:00:00.000Z",
  lease_duration_ms: 30_000,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-runtime-store-"));
  roots.push(root);
  return root;
}

async function createStore(root) {
  const store = new SqliteAuthorityStore(join(root, "authority.db"));
  await store.createInstallation(installation);
  return store;
}

describe("SQLite connector runtime", () => {
  it("persists a settled quarantine and advances its cursor after restart", async () => {
    const root = await createRoot();
    let store = await createStore(root);
    await store.acquireLease(leaseInput);
    await store.beginAttempt({
      id: "attempt-1",
      org_id: installation.org_id,
      connector_installation_id: installation.id,
      stream_key: "personal",
      delivery_id: "page-1",
      started_at: leaseInput.now,
    });
    const attempt = await store.settleAttempt({
      attempt_id: "attempt-1",
      installation_id: installation.id,
      stream_key: "personal",
      lease_owner: "worker-a",
      finished_at: "2026-08-12T00:00:01.000Z",
      accepted_count: 0,
      duplicate_count: 0,
      quarantined_count: 1,
      retryable_failure_count: 0,
      next_cursor: "cursor-2",
      quarantines: [
        {
          id: "quarantine-1",
          record_external_id: "bad-message",
          reason_code: "content_unavailable",
          safe_metadata: { locator_kind: "external" },
          created_at: "2026-08-12T00:00:01.000Z",
        },
      ],
    });
    assert.equal(attempt.status, "succeeded");
    store.close();

    store = new SqliteAuthorityStore(join(root, "authority.db"));
    const cursor = await store.getCursor(installation.id, "personal");
    assert.equal(cursor.cursor, "cursor-2");
    assert.equal(cursor.cursor_version, 2);
    store.close();

    const database = new Database(join(root, "authority.db"), { readonly: true });
    const quarantine = database
      .prepare(
        `SELECT record_external_id, reason_code, safe_metadata_json
         FROM ingest_quarantines WHERE id = ?`,
      )
      .get("quarantine-1");
    database.close();
    assert.deepEqual(quarantine, {
      record_external_id: "bad-message",
      reason_code: "content_unavailable",
      safe_metadata_json: '{"locator_kind":"external"}',
    });
  });

  it("keeps the cursor unchanged for retryable failures and releases its lease", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    await store.beginAttempt({
      id: "attempt-2",
      org_id: installation.org_id,
      connector_installation_id: installation.id,
      stream_key: "personal",
      delivery_id: "page-2",
      started_at: leaseInput.now,
    });
    const attempt = await store.settleAttempt({
      attempt_id: "attempt-2",
      installation_id: installation.id,
      stream_key: "personal",
      lease_owner: "worker-a",
      finished_at: "2026-08-12T00:00:01.000Z",
      accepted_count: 0,
      duplicate_count: 0,
      quarantined_count: 0,
      retryable_failure_count: 1,
      error_code: "concurrent_source_update",
      next_cursor: "cursor-2",
      quarantines: [],
    });
    const cursor = await store.getCursor(installation.id, "personal");
    const nextLease = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:02.000Z",
    });

    assert.equal(attempt.status, "failed");
    assert.equal(cursor.cursor, undefined);
    assert.equal(cursor.cursor_version, 1);
    assert.equal(nextLease.lease_owner, "worker-b");
    store.close();
  });

  it("rejects a live competing lease but permits takeover after expiration", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    const rejected = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });
    const expired = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
      now: "2026-08-12T00:01:00.000Z",
    });

    assert.equal(rejected, null);
    assert.equal(expired.lease_owner, "worker-b");
    store.close();
  });
});