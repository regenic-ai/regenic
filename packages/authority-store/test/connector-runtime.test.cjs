const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { SqliteAuthorityStore } = require("../dist/sqlite");
const { processSyncMetrics } = require("@regenic/domain");

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

    const quarantines = await store.listQuarantines(installation.id);
    const attempts = await store.listAttempts(installation.id);
    const latest = await store.latestAttempt(installation.id);
    const installations = await store.listInstallations(installation.org_id);
    assert.deepEqual(quarantines, [
      {
        id: "quarantine-1",
        attempt_id: "attempt-1",
        connector_installation_id: installation.id,
        stream_key: "personal",
        record_external_id: "bad-message",
        reason_code: "content_unavailable",
        safe_metadata: { locator_kind: "external" },
        created_at: "2026-08-12T00:00:01.000Z",
      },
    ]);
    assert.equal(attempts[0].id, "attempt-1");
    assert.equal(latest?.id, "attempt-1");
    assert.equal(installations[0].id, installation.id);
    store.close();
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

  it("releases a lease only for its current owner", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);

    assert.equal(
      await store.releaseLease({
        ...leaseInput,
        lease_owner: "worker-b",
        now: "2026-08-12T00:00:01.000Z",
      }),
      false,
    );
    assert.equal(
      await store.releaseLease({
        ...leaseInput,
        now: "2026-08-12T00:00:01.000Z",
      }),
      true,
    );
    const nextLease = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:02.000Z",
    });

    assert.equal(nextLease.lease_owner, "worker-b");
    store.close();
  });

  it("disables installations and resets only inactive stream cursors", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    const disabled = await store.setInstallationStatus({
      id: installation.id,
      org_id: installation.org_id,
      status: "disabled",
      updated_at: "2026-08-12T00:00:01.000Z",
    });

    assert.equal(disabled.status, "disabled");
    assert.equal(await store.acquireLease({ ...leaseInput, now: "2026-08-12T00:00:02.000Z" }), null);
    await assert.rejects(
      () => store.resetCursor({
        installation_id: installation.id,
        stream_key: "personal",
        now: "2026-08-12T00:00:02.000Z",
      }),
      /leased/,
    );
    const reset = await store.resetCursor({
      installation_id: installation.id,
      stream_key: "personal",
      now: "2026-08-12T00:01:00.000Z",
    });

    assert.equal(reset.cursor, undefined);
    assert.equal(reset.cursor_version, 2);
    store.close();
  });

  it("uninstalls an installation and its runtime rows", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    await store.beginAttempt({
      id: "attempt-uninstall",
      org_id: installation.org_id,
      connector_installation_id: installation.id,
      stream_key: "personal",
      delivery_id: "page-1",
      started_at: leaseInput.now,
    });

    assert.equal(
      await store.deleteInstallation(installation.id, "other-org"),
      false,
    );
    assert.equal(
      await store.deleteInstallation(installation.id, installation.org_id),
      true,
    );
    assert.equal(await store.findInstallation(installation.id), null);
    assert.equal((await store.listAttempts(installation.id)).length, 0);
    assert.equal(await store.getCursor(installation.id, "personal"), null);
    store.close();
  });

  it("updates installation config in place", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const updated = await store.updateInstallationConfig({
      id: installation.id,
      org_id: installation.org_id,
      config: { scope: "picked", chat_ids: ["oc_1"] },
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    assert.deepEqual(updated.config, { scope: "picked", chat_ids: ["oc_1"] });
    assert.equal(updated.updated_at, "2026-08-23T00:00:00.000Z");
    assert.equal(updated.status, "enabled");
    store.close();
  });

  it("persists a directory census and stream phase across restart", async () => {
    const root = await createRoot();
    let store = await createStore(root);
    const first = await store.applySyncCatalogPage({
      installation_id: installation.id,
      members: [{ stream_key: "chat:oc_1", thread_id: "feishu:oc_1", label: "Ada" }],
      now: "2026-08-31T00:00:00.000Z",
      next_cursor: "p2",
      complete: false,
    });
    assert.equal(first.catalog.complete, false);
    assert.equal(first.members[0].stream_key, "chat:oc_1");
    await store.putSyncState({
      installation_id: installation.id,
      stream_key: "chat:oc_1",
      phase: "unseeded",
      media_pending: false,
      generation: 1,
      updated_at: "2026-08-31T00:00:00.000Z",
    });
    store.close();

    store = new SqliteAuthorityStore(join(root, "authority.db"));
    const catalog = await store.getSyncCatalog(installation.id);
    assert.equal(catalog.members.length, 1);
    assert.equal(catalog.catalog.cursor, "p2");
    const state = await store.getSyncState(installation.id, "chat:oc_1");
    assert.equal(state.phase, "unseeded");
    store.close();
  });

  it("commits attempt, events, and cursor in one page", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    const txBefore =
      processSyncMetrics
        .snapshot()
        .find(
          (row) =>
            row.name === "database_transaction_ms" &&
            row.labels.operation === "commit_sync_page",
        )?.count ?? 0;
    const committed = await store.commitSyncPage({
      attempt: {
        id: "attempt-page",
        org_id: installation.org_id,
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: "page-1",
        started_at: leaseInput.now,
      },
      ingest: {
        appends: [
          {
            id: "event-page",
            org_id: installation.org_id,
            source: "fake",
            external_id: "message-1",
            content_hash: "hash-page",
            content_media_type: "text/plain",
            content_byte_size: 2,
            occurred_at: "2026-08-12T00:00:00.000Z",
            expected_head_id: null,
          },
        ],
        dispositions: [],
      },
      settle: {
        attempt_id: "attempt-page",
        installation_id: installation.id,
        stream_key: "personal",
        lease_owner: "worker-a",
        finished_at: "2026-08-12T00:00:01.000Z",
        accepted_count: 1,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 0,
        next_cursor: "cursor-2",
        quarantines: [],
      },
    });
    assert.equal(committed.attempt.status, "succeeded");
    assert.equal(committed.events[0].id, "event-page");
    const cursor = await store.getCursor(installation.id, "personal");
    assert.equal(cursor.cursor, "cursor-2");
    const event = await store.getEvent(installation.org_id, "event-page");
    assert.equal(event.external_id, "message-1");
    const txAfter =
      processSyncMetrics
        .snapshot()
        .find(
          (row) =>
            row.name === "database_transaction_ms" &&
            row.labels.operation === "commit_sync_page",
        )?.count ?? 0;
    assert.ok(txAfter > txBefore);
    store.close();
  });

  it("rolls back ingested events when the page cannot settle", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    await assert.rejects(
      () =>
        store.commitSyncPage({
          attempt: {
            id: "attempt-fail",
            org_id: installation.org_id,
            connector_installation_id: installation.id,
            stream_key: "personal",
            delivery_id: "page-1",
            started_at: leaseInput.now,
          },
          ingest: {
            appends: [
              {
                id: "event-fail",
                org_id: installation.org_id,
                source: "fake",
                external_id: "message-fail",
                content_hash: "hash-fail",
                content_media_type: "text/plain",
                content_byte_size: 2,
                occurred_at: "2026-08-12T00:00:00.000Z",
                expected_head_id: null,
              },
            ],
            dispositions: [],
          },
          settle: {
            attempt_id: "attempt-fail",
            installation_id: installation.id,
            stream_key: "personal",
            lease_owner: "other-worker",
            finished_at: "2026-08-12T00:00:01.000Z",
            accepted_count: 1,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            next_cursor: "cursor-2",
            quarantines: [],
          },
        }),
      /lease is not held/,
    );
    assert.equal(await store.getEvent(installation.org_id, "event-fail"), null);
    assert.equal(await store.latestAttempt(installation.id), null);
    const cursor = await store.getCursor(installation.id, "personal");
    assert.equal(cursor.cursor, undefined);
    assert.equal(
      await store.acquireLease({
        ...leaseInput,
        lease_owner: "other-worker",
        now: "2026-08-12T00:00:02.000Z",
      }),
      null,
    );
    store.close();
  });

  it("applies list-surface prefs in the same page and rolls them back with ingest", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    await store.putConversationPref({
      org_id: installation.org_id,
      thread_id: "fake:message-keep",
      hidden: true,
      hidden_reason: "policy",
      updated_at: leaseInput.now,
    });
    await assert.rejects(
      () =>
        store.commitSyncPage({
          attempt: {
            id: "attempt-pref",
            org_id: installation.org_id,
            connector_installation_id: installation.id,
            stream_key: "personal",
            delivery_id: "page-1",
            started_at: leaseInput.now,
          },
          ingest: {
            appends: [
              {
                id: "event-pref",
                org_id: installation.org_id,
                source: "fake",
                external_id: "message-keep",
                content_hash: "hash-pref",
                content_media_type: "text/plain",
                content_byte_size: 2,
                occurred_at: "2026-08-12T00:00:00.000Z",
                expected_head_id: null,
              },
            ],
            dispositions: [],
          },
          prefs: [
            {
              org_id: installation.org_id,
              thread_id: "fake:message-keep",
              hidden: false,
              hidden_reason: null,
              updated_at: "2026-08-12T00:00:01.000Z",
            },
          ],
          settle: {
            attempt_id: "attempt-pref",
            installation_id: installation.id,
            stream_key: "personal",
            lease_owner: "other-worker",
            finished_at: "2026-08-12T00:00:01.000Z",
            accepted_count: 1,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            next_cursor: "cursor-2",
            quarantines: [],
          },
        }),
      /lease is not held/,
    );
    const pref = await store.getConversationPref(
      installation.org_id,
      "fake:message-keep",
    );
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
    assert.equal(await store.getEvent(installation.org_id, "event-pref"), null);
    store.close();
  });
});
