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
  const acquireLease = store.acquireLease.bind(store);
  store.acquireLease = async (input) => {
    const lease = await acquireLease(input);
    if (lease) {
      leaseInput.claim_token = lease.claim_token;
    }
    return lease;
  };
  return store;
}

describe("SQLite connector runtime", () => {
  it("does not settle a legacy attempt owned by a different organization", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const db = new Database(join(root, "authority.db"));
    try {
      await store.acquireLease(leaseInput);
      db.prepare(`INSERT INTO ingest_attempts
        (id, org_id, connector_installation_id, stream_key, delivery_id, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'running')`)
        .run("legacy-attempt", "other-org", installation.id, "personal", "page", leaseInput.now);
      await assert.rejects(store.settleAttempt({ attempt_id: "legacy-attempt",
        installation_id: installation.id, stream_key: "personal", lease_owner: "worker-a",
        claim_token: leaseInput.claim_token,
        finished_at: leaseInput.now, accepted_count: 1, duplicate_count: 0, quarantined_count: 0,
        retryable_failure_count: 0, next_cursor: "next", quarantines: [] }), /installation.*organization/i);
      assert.equal((await store.latestAttempt(installation.id)).status, "running");
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, undefined);
      assert.deepEqual(await store.listQuarantines(installation.id), []);
    } finally {
      db.close();
      store.close();
    }
  });

  it("atomically audits generic policy visibility changes without recording no-ops", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const db = new Database(join(root, "authority.db"));
    const now = leaseInput.now;
    const input = { org_id: installation.org_id, thread_id: "generic-policy",
      expected_visibility_version: 0, updated_at: now };
    try {
      db.exec(`CREATE TRIGGER reject_policy_visibility BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'policy audit unavailable'); END`);
      await assert.rejects(store.setConversationPolicyHidden(input), /policy audit unavailable/);
      assert.equal(await store.getConversationPref(input.org_id, input.thread_id), null);
      db.exec("DROP TRIGGER reject_policy_visibility");
      assert.equal((await store.setConversationPolicyHidden(input)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyHidden(input), { outcome: "unchanged" });
      db.exec(`CREATE TRIGGER reject_policy_unfold BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'policy audit unavailable'); END`);
      await assert.rejects(store.setConversationPolicyVisibility({ ...input, hidden: false }), /policy audit unavailable/);
      assert.equal((await store.getConversationPref(input.org_id, input.thread_id)).hidden_reason, "policy");
      db.exec("DROP TRIGGER reject_policy_unfold");
      assert.equal((await store.setConversationPolicyVisibility({ ...input, hidden: false })).outcome, "applied");
      assert.equal((await store.setConversationPolicyHidden(input)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyVisibility({ ...input, hidden: false,
        expected_visibility_version: 1 }), { outcome: "conflict", current_version: 0 });
      await store.setConversationVisibility({ org_id: input.org_id, thread_id: input.thread_id,
        hidden: true, expected_version: 0, updated_at: now });
      assert.deepEqual(await store.setConversationPolicyVisibility({ ...input, hidden: false,
        expected_visibility_version: 1 }), { outcome: "unchanged" });
      const rows = db.prepare(`SELECT aggregate_version, dedupe_key, payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed' ORDER BY rowid`)
        .all(input.org_id, input.thread_id);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((row) => row.aggregate_version), [0, 0, 0]);
      assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, 3);
      assert.deepEqual(rows.map((row) => JSON.parse(row.payload_json)), [
        { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" },
        { hidden: false, hidden_reason: null, cause: "policy_visibility_applied" },
        { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" },
      ]);
    } finally {
      db.close();
      store.close();
    }
  });

  it("rolls back a sync page when generic policy audit fails", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const db = new Database(join(root, "authority.db"));
    const now = leaseInput.now;
    await store.acquireLease(leaseInput);
    db.exec(`CREATE TRIGGER reject_page_policy BEFORE INSERT ON conversation_lifecycle_events
      WHEN NEW.event_type = 'visibility_changed'
      BEGIN SELECT RAISE(ABORT, 'page policy audit unavailable'); END`);
    const page = {
      attempt: { id: "page-policy", org_id: installation.org_id, connector_installation_id: installation.id,
        stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ id: "page-policy-event", org_id: installation.org_id, source: "fake",
        external_id: "page-policy-event", thread_id: "page-policy-thread", content_hash: "hash-policy",
        content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: null }],
        dispositions: [] },
      prefs: [{ org_id: installation.org_id, thread_id: "page-policy-thread", hidden: true,
        expected_visibility_version: 0, updated_at: now }],
      settle: { attempt_id: "page-policy", installation_id: installation.id, stream_key: "personal",
        lease_owner: leaseInput.lease_owner, claim_token: leaseInput.claim_token,
        finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "next", quarantines: [] },
    };
    try {
      await assert.rejects(store.commitSyncPage(page), /page policy audit unavailable/);
      assert.equal(await store.getEvent(installation.org_id, "page-policy-event"), null);
      assert.equal(await store.latestAttempt(installation.id), null);
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, undefined);
      assert.equal(await store.getConversationPref(installation.org_id, "page-policy-thread"), null);
      db.exec("DROP TRIGGER reject_page_policy");
      assert.equal((await store.commitSyncPage(page)).attempt.status, "succeeded");
      assert.equal((await store.getConversationPref(installation.org_id, "page-policy-thread")).hidden_reason, "policy");
      const row = db.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`)
        .get(installation.org_id, "page-policy-thread");
      assert.deepEqual(JSON.parse(row.payload_json),
        { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" });
    } finally {
      db.close();
      store.close();
    }
  });

  it("atomically commits and audits a sync-page tombstone fold", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const now = leaseInput.now;
    const base = { org_id: installation.org_id, source: "fake", external_id: "fold-source",
      thread_id: "fold-thread", content_hash: "hash-fold", content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now };
    await store.append({ ...base, id: "fold-original", expected_head_id: null });
    await store.acquireLease(leaseInput);
    const db = new Database(join(root, "authority.db"));
    db.exec(`CREATE TRIGGER reject_tombstone_fold BEFORE INSERT ON conversation_lifecycle_events
      WHEN NEW.event_type = 'visibility_changed'
      BEGIN SELECT RAISE(ABORT, 'tombstone audit unavailable'); END`);
    const page = {
      attempt: { id: "fold-attempt", org_id: installation.org_id,
        connector_installation_id: installation.id, stream_key: "personal", delivery_id: "fold", started_at: now },
      ingest: { appends: [{ ...base, id: "fold-deleted", operation: "tombstone",
        expected_head_id: "fold-original" }], dispositions: [] },
      prefs: [{ org_id: installation.org_id, thread_id: base.thread_id, hidden: true,
        expected_visibility_version: 0, updated_at: now, fold_current_tombstone_event_ids: ["fold-deleted"] }],
      settle: { attempt_id: "fold-attempt", installation_id: installation.id, stream_key: "personal",
        lease_owner: leaseInput.lease_owner, claim_token: leaseInput.claim_token,
        finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "fold-cursor", quarantines: [] },
    };
    try {
      await assert.rejects(store.commitSyncPage(page), /tombstone audit unavailable/);
      assert.equal(await store.getEvent(installation.org_id, "fold-deleted"), null);
      assert.equal((await store.findBySourceIdentity(base)).id, "fold-original");
      assert.equal(await store.latestAttempt(installation.id), null);
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, undefined);
      assert.notEqual((await store.getConversationPref(installation.org_id, base.thread_id))?.hidden, true);
      db.exec("DROP TRIGGER reject_tombstone_fold");
      assert.equal((await store.commitSyncPage(page)).attempt.status, "succeeded");
      assert.equal((await store.findBySourceIdentity(base)).id, "fold-deleted");
      assert.equal((await store.getConversationPref(installation.org_id, base.thread_id)).hidden_reason, "policy");
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, "fold-cursor");
      const rows = db.prepare(`SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).all(installation.org_id, base.thread_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].aggregate_version, 0);
      assert.deepEqual(JSON.parse(rows[0].payload_json), {
        hidden: true, hidden_reason: "policy", cause: "tombstone_visibility_reconciled", event_id: "fold-deleted",
      });
      await store.setConversationPolicyVisibility({
        org_id: installation.org_id, thread_id: base.thread_id, hidden: false,
        expected_visibility_version: 0, updated_at: now,
      });
      const other = { ...base, external_id: "fold-other" };
      await store.append({ ...other, id: "fold-other-original", expected_head_id: null });
      await store.markTombstone({ ...other, id: "fold-other-deleted", expected_head_id: "fold-other-original" });
      const orderedGuard = { ...page.prefs[0],
        fold_current_tombstone_event_ids: ["missing", "fold-other-deleted", "fold-deleted"] };
      assert.equal((await store.setConversationPolicyVisibility(orderedGuard)).outcome, "applied");
      const ordered = db.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'
        AND json_extract(payload_json, '$.cause') = 'tombstone_visibility_reconciled'
        ORDER BY rowid`).all(installation.org_id, base.thread_id);
      assert.equal(ordered.length, 2);
      assert.equal(JSON.parse(ordered[1].payload_json).event_id, "fold-other-deleted");
    } finally {
      db.close();
      store.close();
    }
  });

  it("rechecks guarded page unfolds and still repairs valid legacy preferences", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const now = leaseInput.now;
    const event = {
      id: "page-current", org_id: installation.org_id, source: "fake", external_id: "page-current",
      thread_id: "page-thread", content_hash: "hash-page-current", content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    const decision = {
      event_id: event.id, org_id: event.org_id, disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    };
    await store.commitIngest({ appends: [event], dispositions: [decision] });
    await store.putConversationPref({ org_id: event.org_id, thread_id: event.thread_id, updated_at: now });
    const db = new Database(join(root, "authority.db"));
    db.prepare("UPDATE conversation_prefs SET hidden = 1, hidden_reason = 'policy' WHERE org_id = ? AND thread_id = ?")
      .run(event.org_id, event.thread_id);
    const guard = {
      org_id: event.org_id, thread_id: event.thread_id, hidden: false,
      expected_visibility_version: 0, updated_at: now,
      unfold_current_work_event_ids: ["missing", event.id],
    };
    db.exec(`CREATE TRIGGER reject_compatibility_unfold
      BEFORE INSERT ON conversation_lifecycle_events
      WHEN NEW.event_type = 'visibility_changed'
      BEGIN SELECT RAISE(ABORT, 'reconciliation audit unavailable'); END`);
    await assert.rejects(store.setConversationPolicyVisibility(guard), /reconciliation audit unavailable/);
    assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden_reason, "policy");
    db.exec("DROP TRIGGER reject_compatibility_unfold");
    assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
    assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
    const audit = db.prepare(`SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
      WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).all(event.org_id, event.thread_id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].aggregate_version, 0);
    assert.deepEqual(JSON.parse(audit[0].payload_json), {
      hidden: false, hidden_reason: null, cause: "current_work_visibility_reconciled", event_id: event.id,
    });
    db.prepare("UPDATE conversation_prefs SET hidden = 1, hidden_reason = 'policy' WHERE org_id = ? AND thread_id = ?")
      .run(event.org_id, event.thread_id);
    assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
    const keys = db.prepare(`SELECT dedupe_key FROM conversation_lifecycle_events
      WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).all(event.org_id, event.thread_id);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0].dedupe_key, keys[1].dedupe_key);
    db.close();
    const expected = await store.getDisposition(event.id);
    const next = { ...expected, disposition: "outside_current_work" };
    await store.transitionDisposition({
      expected, decision: next,
      command: { org_id: event.org_id, event_id: event.id, action: "triage",
        disposition: next.disposition, command_id: "page-close", issued_at: now },
    });
    await store.setConversationPolicyHidden({
      org_id: event.org_id, thread_id: event.thread_id, expected_visibility_version: 0, updated_at: now,
    });
    await store.acquireLease(leaseInput);
    await store.commitSyncPage({
      attempt: { id: "page-guard", org_id: event.org_id, connector_installation_id: installation.id,
        stream_key: "personal", delivery_id: "guard", started_at: now },
      prefs: [guard],
      settle: { attempt_id: "page-guard", installation_id: installation.id, stream_key: "personal",
        lease_owner: leaseInput.lease_owner, claim_token: leaseInput.claim_token, finished_at: now, accepted_count: 0,
        duplicate_count: 1, quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    });
    assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden_reason, "policy");
    const first = { ...event, id: "ordered-first", external_id: "ordered-first", thread_id: "ordered-thread" };
    const second = { ...event, id: "ordered-second", external_id: "ordered-second", thread_id: "ordered-thread" };
    await store.commitIngest({ appends: [first, second], dispositions: [first, second].map((item) => ({
      ...decision, event_id: item.id,
    })) });
    await store.putConversationPref({ org_id: event.org_id, thread_id: first.thread_id, updated_at: now });
    const inspect = new Database(join(root, "authority.db"));
    inspect.prepare("UPDATE conversation_prefs SET hidden = 1, hidden_reason = 'policy' WHERE org_id = ? AND thread_id = ?")
      .run(event.org_id, first.thread_id);
    assert.equal((await store.setConversationPolicyVisibility({
      ...guard, thread_id: first.thread_id, unfold_current_work_event_ids: ["missing", second.id, first.id],
    })).outcome, "applied");
    const ordered = inspect.prepare(`SELECT payload_json FROM conversation_lifecycle_events
      WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).get(event.org_id, first.thread_id);
    assert.equal(JSON.parse(ordered.payload_json).event_id, second.id);
    inspect.close();
    store.close();
  });

  it("rolls back sync-page ingest and settlement if reconciliation audit fails", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const now = leaseInput.now;
    const event = {
      id: "page-existing", org_id: installation.org_id, source: "fake", external_id: "page-existing",
      thread_id: "page-existing-thread", content_hash: "hash-existing", content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    await store.commitIngest({ appends: [event], dispositions: [{
      event_id: event.id, org_id: event.org_id, disposition: "current_work", layer: "L1_event",
      reason_codes: [], score: 1, decided_at: now,
    }] });
    await store.putConversationPref({ org_id: event.org_id, thread_id: event.thread_id, updated_at: now });
    await store.acquireLease(leaseInput);
    const db = new Database(join(root, "authority.db"));
    db.prepare("UPDATE conversation_prefs SET hidden = 1, hidden_reason = 'policy' WHERE org_id = ? AND thread_id = ?")
      .run(event.org_id, event.thread_id);
    db.exec(`CREATE TRIGGER reject_page_reconciliation
      BEFORE INSERT ON conversation_lifecycle_events
      WHEN NEW.event_type = 'visibility_changed'
      BEGIN SELECT RAISE(ABORT, 'page audit unavailable'); END`);
    const page = {
      attempt: { id: "page-audit-attempt", org_id: event.org_id,
        connector_installation_id: installation.id, stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ ...event, id: "page-new", external_id: "page-new",
        thread_id: "page-new-thread" }], dispositions: [] },
      prefs: [{ org_id: event.org_id, thread_id: event.thread_id, hidden: false,
        expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [event.id] }],
      settle: { attempt_id: "page-audit-attempt", installation_id: installation.id,
        stream_key: "personal", lease_owner: leaseInput.lease_owner,
        claim_token: leaseInput.claim_token, finished_at: now,
        accepted_count: 1, duplicate_count: 0, quarantined_count: 0, retryable_failure_count: 0,
        next_cursor: "page-next", quarantines: [] },
    };
    try {
      await assert.rejects(store.commitSyncPage(page), /page audit unavailable/);
      assert.equal(await store.getEvent(event.org_id, "page-new"), null);
      assert.equal(await store.latestAttempt(installation.id), null);
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, undefined);
      assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden_reason, "policy");
      db.exec("DROP TRIGGER reject_page_reconciliation");
      const result = await store.commitSyncPage(page);
      assert.equal(result.attempt.status, "succeeded");
      assert.equal((await store.getEvent(event.org_id, "page-new")).id, "page-new");
      assert.equal((await store.getCursor(installation.id, "personal")).cursor, "page-next");
      assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden, false);
      const audit = db.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).all(event.org_id, event.thread_id);
      assert.deepEqual(audit.map((row) => JSON.parse(row.payload_json)), [{
        hidden: false, hidden_reason: null, cause: "current_work_visibility_reconciled", event_id: event.id,
      }]);
    } finally {
      db.close();
      store.close();
    }
  });

  it("rolls back a sync page when its guarded unfold is malformed", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    await store.acquireLease(leaseInput);
    const now = leaseInput.now;
    await assert.rejects(store.commitSyncPage({
      attempt: { id: "page-invalid", org_id: installation.org_id,
        connector_installation_id: installation.id, stream_key: "personal",
        delivery_id: "invalid", started_at: now },
      ingest: { appends: [{
        id: "page-invalid-event", org_id: installation.org_id, source: "fake",
        external_id: "page-invalid-event", thread_id: "page-invalid-thread",
        content_hash: "hash-invalid", content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      }], dispositions: [] },
      prefs: [{ org_id: installation.org_id, thread_id: "page-invalid-thread", hidden: false,
        expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [] }],
      settle: { attempt_id: "page-invalid", installation_id: installation.id, stream_key: "personal",
        lease_owner: leaseInput.lease_owner, claim_token: leaseInput.claim_token,
        finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    }), /non-empty current-work event IDs/);
    assert.equal(await store.getEvent(installation.org_id, "page-invalid-event"), null);
    assert.equal(await store.latestAttempt(installation.id), null);
    store.close();
  });

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
      claim_token: leaseInput.claim_token,
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
      claim_token: leaseInput.claim_token,
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
    await store.acquireLease({ ...leaseInput, lease_duration_ms: 20 });
    const rejected = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const expired = await store.acquireLease({
      ...leaseInput,
      lease_owner: "worker-b",
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
        claim_token: leaseInput.claim_token,
        now: "2026-08-12T00:00:01.000Z",
      }),
      false,
    );
    assert.equal(
      await store.releaseLease({
        ...leaseInput,
        claim_token: leaseInput.claim_token,
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
    const db = new Database(join(root, "authority.db"));
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
    db.prepare(`UPDATE connector_cursors SET lease_expires_at = ?
      WHERE installation_id = ? AND stream_key = ?`)
      .run("2000-01-01T00:00:00.000Z", installation.id, "personal");
    const reset = await store.resetCursor({
      installation_id: installation.id,
      stream_key: "personal",
      now: "2026-08-12T00:00:03.000Z",
    });

    assert.equal(reset.cursor, undefined);
    assert.equal(reset.cursor_version, 2);
    db.close();
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
        claim_token: leaseInput.claim_token,
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

  it("rolls back a sync page when its lease expires before settlement", async () => {
    const root = await createRoot();
    const store = await createStore(root);
    const now = new Date().toISOString();
    const lease = await store.acquireLease({ ...leaseInput, now, lease_duration_ms: 20 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await assert.rejects(store.commitSyncPage({
      attempt: {
        id: "attempt-expired-page",
        org_id: installation.org_id,
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: "expired-page",
        started_at: now,
      },
      ingest: {
        appends: [{
          id: "event-expired-page",
          org_id: installation.org_id,
          source: "fake",
          external_id: "message-expired-page",
          content_hash: "hash-expired-page",
          content_media_type: "text/plain",
          content_byte_size: 1,
          occurred_at: now,
          expected_head_id: null,
        }],
        dispositions: [],
      },
      settle: {
        attempt_id: "attempt-expired-page",
        installation_id: installation.id,
        stream_key: "personal",
        lease_owner: lease.lease_owner,
        claim_token: lease.claim_token,
        finished_at: now,
        accepted_count: 1,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 0,
        next_cursor: "expired-cursor",
        quarantines: [],
      },
    }), /lease is not held/);

    assert.equal(await store.getEvent(installation.org_id, "event-expired-page"), null);
    assert.equal(await store.latestAttempt(installation.id), null);
    assert.equal((await store.getCursor(installation.id, "personal")).cursor, undefined);
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
            claim_token: leaseInput.claim_token,
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
    await store.setConversationPolicyVisibility({
      org_id: installation.org_id,
      thread_id: "fake:message-keep",
      hidden: true,
      expected_visibility_version: 0,
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
              expected_visibility_version: 0,
              updated_at: "2026-08-12T00:00:01.000Z",
            },
          ],
          settle: {
            attempt_id: "attempt-pref",
            installation_id: installation.id,
            stream_key: "personal",
            lease_owner: "other-worker",
            claim_token: leaseInput.claim_token,
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
