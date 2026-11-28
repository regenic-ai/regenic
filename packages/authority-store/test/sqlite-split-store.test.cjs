const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { FsBlobStore } = require("@regenic/blob-store");
const { createHash } = require("node:crypto");
const {
  AuthorityConflictError,
  CONTENT_PARTS_MEDIA_TYPE,
  ConnectorRunner,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  channelRecord,
  compactEmbeddedContent,
  parseStoredContentParts,
  processSyncMetrics,
} = require("@regenic/domain");
const {
  SqliteAuthorityStore,
  SqliteSplitAuthorityStore,
} = require("../dist/sqlite");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-split-store-"));
  roots.push(root);
  return root;
}

function createBatch(externalId = "source-event-1") {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: `delivery-${externalId}`,
    received_at: "2026-08-24T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: externalId,
        occurred_at: "2026-08-24T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          { role: "body", media_type: "text/plain", text: "Split body." },
        ],
      },
    ],
  };
}

describe("sqlite read/write split", () => {
  it("fences an old same-owner poll through the writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = new Date().toISOString();
    try {
      await store.createInstallation({ id: "split-poll-lease", org_id: "org", connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now });
      const firstStarted = Promise.withResolvers();
      const secondStarted = Promise.withResolvers();
      const firstPage = Promise.withResolvers();
      const secondPage = Promise.withResolvers();
      const renewalFailed = Promise.withResolvers();
      const renewalTimeout = setTimeout(
        () => renewalFailed.reject(new Error("lease renewal was not attempted")),
        1000,
      );
      const renewLease = store.renewLease.bind(store);
      let rejectFirstRenewal = true;
      store.renewLease = async (lease) => {
        if (rejectFirstRenewal) {
          rejectFirstRenewal = false;
          renewalFailed.resolve();
          clearTimeout(renewalTimeout);
          return null;
        }
        return renewLease(lease);
      };
      let calls = 0;
      const runner = new ConnectorRunner({
        poll() {
          if (++calls === 1) { firstStarted.resolve(); return firstPage.promise; }
          secondStarted.resolve();
          return secondPage.promise;
        },
      }, { async ingest() { throw new Error("unexpected ingest"); } }, store, () => now);
      const request = { installation_id: "split-poll-lease", stream_key: "personal",
        lease_owner: "same-worker", lease_duration_ms: 20 };
      const batch = { schema_version: INGEST_SCHEMA_VERSION, connector_id: "fake-poll", org_id: "org",
        delivery_id: "page", received_at: now, records: [] };
      const first = runner.poll(request);
      await firstStarted.promise;
      await renewalFailed.promise;
      assert.equal((await first).status, "lease_unavailable");
      request.lease_duration_ms = 30000;
      const second = runner.poll(request);
      await secondStarted.promise;
      firstPage.resolve({ batch, next_cursor: "old" });
      assert.equal((await store.getCursor("split-poll-lease", "personal")).cursor, undefined);
      secondPage.resolve({ batch, next_cursor: "new" });
      assert.equal((await second).status, "completed");
      assert.equal((await store.getCursor("split-poll-lease", "personal")).cursor, "new");
    } finally {
      await store.close();
    }
  });

  it("renews only the current active lease claim through the writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = new Date().toISOString();
    try {
      await store.createInstallation({
        id: "split-renew-lease", org_id: "org", connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const request = {
        installation_id: "split-renew-lease",
        stream_key: "personal",
        lease_owner: "worker",
        now,
        lease_duration_ms: 1000,
      };
      const lease = await store.acquireLease(request);
      assert.ok(lease);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const renewed = await store.renewLease({
        ...request, claim_token: lease.claim_token, now: new Date().toISOString(),
      });
      assert.ok(renewed);
      assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(lease.lease_expires_at));
      assert.equal(await store.renewLease({
        ...request, claim_token: "stale-token", now: new Date().toISOString(),
      }), null);
      assert.equal(await store.releaseLease({
        ...request, claim_token: lease.claim_token, now: new Date().toISOString(),
      }), true);
      assert.equal(await store.renewLease({
        ...request, claim_token: lease.claim_token, now: new Date().toISOString(),
      }), null);
    } finally {
      await store.close();
    }
  });

  it("enforces attempt identity and settlement fencing through the writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({ id: "split-identity", org_id: "org", connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now });
      const lease = { installation_id: "split-identity", stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30000 };
      const acquiredLease = await store.acquireLease(lease);
      const attempt = { id: "split-attempt", org_id: "org", connector_installation_id: "split-identity",
        stream_key: "personal", delivery_id: "page", started_at: now };
      const settle = { attempt_id: attempt.id, installation_id: "split-identity", stream_key: "personal",
        lease_owner: "worker", claim_token: acquiredLease.claim_token,
        finished_at: now, accepted_count: 0, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "next", quarantines: [] };
      await assert.rejects(store.commitSyncPage({ attempt: { ...attempt, org_id: "other" }, settle }),
        /installation.*organization/i);
      await assert.rejects(store.commitSyncPage({ attempt, settle,
        prefs: [{ org_id: "other", thread_id: "foreign", hidden: true,
          expected_visibility_version: 0, updated_at: now }] }), /organization/i);
      assert.equal(await store.getConversationPref("other", "foreign"), null);
      await assert.rejects(store.commitSyncPage({ attempt, settle: { ...settle, stream_key: "other" } }),
        /Sync page attempt identity/);
      assert.equal(await store.latestAttempt("split-identity"), null);
      await store.beginAttempt(attempt);
      await assert.rejects(store.settleAttempt({ ...settle, stream_key: "other" }), /attempt.*installation.*stream/i);
      assert.equal((await store.latestAttempt("split-identity")).status, "running");
      await store.settleAttempt(settle);
      await store.acquireLease(lease);
      await assert.rejects(store.settleAttempt(settle), /attempt.*running/i);
      assert.equal((await store.getCursor("split-identity", "personal")).cursor, "next");
    } finally {
      await store.close();
    }
  });

  it("persists generic policy audit atomically through the writer RPC", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const db = new Database(path);
    const input = { org_id: "local-owner", thread_id: "split-generic-policy",
      expected_visibility_version: 0, updated_at: "2026-08-24T00:00:00.000Z" };
    try {
      db.exec(`CREATE TRIGGER reject_split_policy BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'split policy audit unavailable'); END`);
      await assert.rejects(store.setConversationPolicyHidden(input), /split policy audit unavailable/);
      assert.equal(await store.getConversationPref(input.org_id, input.thread_id), null);
      db.exec("DROP TRIGGER reject_split_policy");
      assert.equal((await store.setConversationPolicyHidden(input)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyHidden(input), { outcome: "unchanged" });
      assert.equal((await store.setConversationPolicyVisibility({ ...input, hidden: false })).outcome, "applied");
    } finally {
      db.close();
      await store.close();
    }
    const persisted = new Database(path, { readonly: true });
    try {
      const rows = persisted.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed' ORDER BY rowid`)
        .all(input.org_id, input.thread_id);
      assert.deepEqual(rows.map((row) => JSON.parse(row.payload_json)), [
        { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" },
        { hidden: false, hidden_reason: null, cause: "policy_visibility_applied" },
      ]);
    } finally {
      persisted.close();
    }
  });

  it("audits current tombstone folds and rejects stale sync-page folds through the writer RPC", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const db = new Database(path);
    const now = "2026-08-24T00:00:00.000Z";
    const base = { org_id: "local-owner", source: "synthetic", external_id: "fold",
      thread_id: "split-fold", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now };
    const guard = { org_id: base.org_id, thread_id: base.thread_id, hidden: true,
      expected_visibility_version: 0, updated_at: now, fold_current_tombstone_event_ids: ["split-deleted"] };
    try {
      await store.append({ ...base, id: "split-original", expected_head_id: null });
      await store.markTombstone({ ...base, id: "split-deleted", expected_head_id: "split-original" });
      db.exec(`CREATE TRIGGER reject_split_fold BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'split fold audit unavailable'); END`);
      await assert.rejects(store.setConversationPolicyVisibility(guard), /split fold audit unavailable/);
      assert.notEqual((await store.getConversationPref(base.org_id, base.thread_id))?.hidden, true);
      db.exec("DROP TRIGGER reject_split_fold");
      assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
      await store.setConversationPolicyVisibility({ ...guard, hidden: false, fold_current_tombstone_event_ids: undefined });
      await store.appendRevision({
        ...base, id: "split-replacement", parent_event_id: "split-deleted", expected_head_id: "split-deleted",
        disposition: { event_id: "split-replacement", org_id: base.org_id,
          disposition: "outside_current_work", layer: "L1_event", reason_codes: [], score: 1, decided_at: now },
      });
      await store.createInstallation({
        id: "split-fold-installation", org_id: base.org_id, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({ installation_id: "split-fold-installation", stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30_000 });
      await store.commitSyncPage({
        attempt: { id: "split-fold-attempt", org_id: base.org_id,
          connector_installation_id: "split-fold-installation", stream_key: "personal",
          delivery_id: "page", started_at: now },
        prefs: [guard],
        settle: { attempt_id: "split-fold-attempt", installation_id: "split-fold-installation",
          stream_key: "personal", lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 0,
          duplicate_count: 1, quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
      });
      assert.equal((await store.getConversationPref(base.org_id, base.thread_id)).hidden, false);
      const rows = db.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'
          AND json_extract(payload_json, '$.cause') = 'tombstone_visibility_reconciled'`).all(base.org_id, base.thread_id);
      assert.deepEqual(rows.map((row) => JSON.parse(row.payload_json)), [{
        hidden: true, hidden_reason: "policy", cause: "tombstone_visibility_reconciled", event_id: "split-deleted",
      }]);
    } finally {
      db.close();
      await store.close();
    }
  });

  it("atomically audits a guarded compatibility unfold through the writer RPC", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    const event = {
      id: "split-audit-event", org_id: "local-owner", source: "synthetic", external_id: "split-audit",
      thread_id: "split-audit-thread", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    const guard = { org_id: event.org_id, thread_id: event.thread_id, hidden: false,
      expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [event.id] };
    const db = new Database(path);
    try {
      await store.commitIngest({ appends: [event], dispositions: [{
        event_id: event.id, org_id: event.org_id, disposition: "current_work", layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      }] });
      await store.putConversationPref({ org_id: event.org_id, thread_id: event.thread_id, updated_at: now });
      db.prepare("UPDATE conversation_prefs SET hidden = 1, hidden_reason = 'policy' WHERE org_id = ? AND thread_id = ?")
        .run(event.org_id, event.thread_id);
      db.exec(`CREATE TRIGGER reject_split_reconciliation BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'split audit unavailable'); END`);
      await assert.rejects(store.setConversationPolicyVisibility(guard), /split audit unavailable/);
      assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden_reason, "policy");
      db.exec("DROP TRIGGER reject_split_reconciliation");
      assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
    } finally {
      await store.close();
      db.close();
    }
    const persisted = new Database(path, { readonly: true });
    try {
      const rows = persisted.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'`).all(event.org_id, event.thread_id);
      assert.deepEqual(rows.map((row) => JSON.parse(row.payload_json)), [{
        hidden: false, hidden_reason: null, cause: "current_work_visibility_reconciled", event_id: event.id,
      }]);
    } finally {
      persisted.close();
    }
  });

  it("rechecks stale ingest-derived unfolds through the writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    const event = {
      id: "split-unfold", org_id: "local-owner", source: "synthetic", external_id: "split-unfold",
      thread_id: "split-unfold-thread", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    const decision = {
      event_id: event.id, org_id: event.org_id, disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    };
    try {
      await store.commitIngest({ appends: [event], dispositions: [decision] });
      const expected = await store.getDisposition(event.id);
      const next = { ...expected, disposition: "outside_current_work" };
      await store.transitionDisposition({
        expected, decision: next,
        command: { org_id: event.org_id, event_id: event.id, action: "triage",
          disposition: next.disposition, command_id: "split-close", issued_at: now },
      });
      await store.setConversationPolicyHidden({
        org_id: event.org_id, thread_id: event.thread_id, expected_visibility_version: 0, updated_at: now,
      });
      assert.deepEqual(await store.setConversationPolicyVisibility({
        org_id: event.org_id, thread_id: event.thread_id, hidden: false,
        expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [event.id],
      }), { outcome: "unchanged" });
      await store.createInstallation({
        id: "split-unfold-installation", org_id: event.org_id, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: "split-unfold-installation", stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30_000,
      });
      await store.commitSyncPage({
        attempt: { id: "split-unfold-attempt", org_id: event.org_id,
          connector_installation_id: "split-unfold-installation", stream_key: "personal",
          delivery_id: "page", started_at: now },
        prefs: [{ org_id: event.org_id, thread_id: event.thread_id, hidden: false,
          expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [event.id] }],
        settle: { attempt_id: "split-unfold-attempt", installation_id: "split-unfold-installation",
          stream_key: "personal", lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 0,
          duplicate_count: 1, quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
      });
      assert.equal((await store.getConversationPref(event.org_id, event.thread_id)).hidden_reason, "policy");
    } finally {
      await store.close();
    }
  });

  it("does not expose tombstones as current work through the writer RPC", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    const input = {
      id: "split-live", org_id: "local-owner", source: "synthetic", external_id: "split-source",
      thread_id: "split-thread", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    const decision = (id) => ({
      event_id: id, org_id: input.org_id, disposition: "current_work", layer: "L1_event",
      reason_codes: [], score: 1, decided_at: now,
    });
    try {
      await store.commitIngest({ appends: [input], dispositions: [decision(input.id)] });
      await store.markTombstone({
        id: "split-deleted", org_id: input.org_id, source: input.source, external_id: input.external_id,
        thread_id: input.thread_id, expected_head_id: input.id, occurred_at: now,
        disposition: decision("split-deleted"),
      });
      assert.deepEqual(await store.listInbox(input.org_id, { heads: true }), []);
      assert.equal((await store.summarizeInbox(input.org_id)).count, 0);
    } finally {
      await store.close();
    }
    const reopened = await SqliteSplitAuthorityStore.open(path);
    try {
      assert.deepEqual(await reopened.listInbox(input.org_id), []);
      assert.equal((await reopened.summarizeInbox(input.org_id)).count, 0);
      assert.equal((await reopened.getDisposition("split-deleted")).disposition, "current_work");
    } finally {
      await reopened.close();
    }
  });

  it("persists both conversation projections when a source head moves", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    const first = {
      id: "split-projection-first", org_id: "local-owner", source: "synthetic",
      external_id: "split-projection-source", thread_id: "split-projection-old",
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: now, expected_head_id: null,
    };
    const decision = (id) => ({
      event_id: id, org_id: first.org_id, disposition: "current_work", layer: "L1_event",
      reason_codes: [], score: 1, decided_at: now,
    });
    try {
      await store.commitIngest({ appends: [first], dispositions: [decision(first.id)] });
      await store.commitIngest({
        appends: [{
          ...first, id: "split-projection-next", thread_id: "split-projection-new",
          operation: "revise", parent_event_id: first.id, expected_head_id: first.id,
        }],
        dispositions: [decision("split-projection-next")],
      });
      assert.equal((await store.summarizeInbox(first.org_id)).count, 1);
      assert.deepEqual((await store.listInbox(first.org_id, { heads: true })).map((row) => row.event.id),
        ["split-projection-next"]);
    } finally {
      await store.close();
    }
    const reopened = await SqliteSplitAuthorityStore.open(path);
    try {
      assert.equal((await reopened.summarizeInbox(first.org_id)).count, 1);
      assert.deepEqual((await reopened.listInbox(first.org_id, { heads: true })).map((row) => row.event.id),
        ["split-projection-next"]);
    } finally {
      await reopened.close();
    }
  });

  it("rolls back a sync page with an unrelated disposition", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "installation-binding", org_id: "local-owner", connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: "installation-binding", stream_key: "personal", lease_owner: "worker",
        now, lease_duration_ms: 30_000,
      });
      const current = await store.append({
        id: "old-binding", org_id: "local-owner", source: "synthetic", external_id: "old-binding",
        content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      });
      const initial = {
        event_id: current.id, org_id: "local-owner", disposition: "outside_current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      };
      await store.putDispositionIfAbsent(initial);
      const expected = await store.getDisposition(current.id);
      const cursor = await store.getCursor("installation-binding", "personal");
      await assert.rejects(store.commitSyncPage({
        attempt: {
          id: "attempt-binding", org_id: "local-owner", connector_installation_id: "installation-binding",
          stream_key: "personal", delivery_id: "page-binding", started_at: now,
        },
        settle: {
          attempt_id: "attempt-binding", installation_id: "installation-binding", stream_key: "personal",
          lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 1, duplicate_count: 0,
          quarantined_count: 0, retryable_failure_count: 0, quarantines: [],
        },
        ingest: {
          appends: [{
            id: "new-binding", org_id: "local-owner", source: "synthetic", external_id: "new-binding",
            content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
            occurred_at: now, expected_head_id: null,
          }],
          dispositions: [{ ...initial, disposition: "current_work" }],
        },
      }), /Ingest dispositions must match/);
      assert.deepEqual(await store.getDisposition(current.id), expected);
      assert.equal(await store.getEvent("local-owner", "new-binding"), null);
      assert.deepEqual(await store.getCursor("installation-binding", "personal"), cursor);
      assert.deepEqual(await store.listAttempts("installation-binding"), []);
    } finally {
      await store.close();
    }
  });

  it("keeps reclassified and restored current work visible across competing writers", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = await SqliteSplitAuthorityStore.open(path);
    const second = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    try {
      for (const mode of ["transition", "restore"]) {
        const id = `event-disposition-${mode}`;
        const thread = `thread-disposition-${mode}`;
        await first.append({
          id, org_id: "local-owner", source: "synthetic", external_id: id, thread_id: thread,
          content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        });
        const initial = {
          event_id: id, org_id: "local-owner", disposition: "outside_current_work",
          layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
        };
        if (mode === "transition") await first.putDispositionIfAbsent(initial);
        const expected = await first.getDisposition(id);
        const decision = { ...initial, disposition: "current_work" };
        const [fold, changed] = await Promise.all([
          first.setConversationPolicyHidden({
            org_id: "local-owner", thread_id: thread, expected_visibility_version: 0, updated_at: now,
          }),
          mode === "transition"
            ? second.transitionDisposition({
                expected, decision, command: {
                  org_id: "local-owner", event_id: id, action: "triage", disposition: "current_work",
                  command_id: `command-${mode}`, issued_at: now,
                },
              })
            : second.putDispositionIfAbsent(decision),
        ]);
        assert.ok(["applied", "unchanged"].includes(fold.outcome));
        assert.equal(mode === "transition" ? changed.outcome : changed, mode === "transition" ? "applied" : true);
        assert.notEqual((await first.getConversationPref("local-owner", thread))?.hidden, true);
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const restarted = await SqliteSplitAuthorityStore.open(path);
    try {
      for (const mode of ["transition", "restore"]) {
        assert.notEqual((await restarted.getConversationPref("local-owner", `thread-disposition-${mode}`))?.hidden, true);
      }
    } finally {
      await restarted.close();
    }
  });

  it("unfolds new work within a sync-page commit even without a projected preference", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "installation-unfold", org_id: "local-owner", connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: "installation-unfold", stream_key: "personal", lease_owner: "worker",
        now, lease_duration_ms: 30_000,
      });
      await store.setConversationPolicyHidden({
        org_id: "local-owner", thread_id: "thread-unfold", expected_visibility_version: 0, updated_at: now,
      });
      await store.commitSyncPage({
        attempt: {
          id: "attempt-unfold", org_id: "local-owner", connector_installation_id: "installation-unfold",
          stream_key: "personal", delivery_id: "page-unfold", started_at: now,
        },
        settle: {
          attempt_id: "attempt-unfold", installation_id: "installation-unfold", stream_key: "personal",
          lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 1, duplicate_count: 0,
          quarantined_count: 0, retryable_failure_count: 0, quarantines: [],
        },
        ingest: {
          appends: [{
            id: "event-unfold", org_id: "local-owner", source: "synthetic", external_id: "event-unfold",
            thread_id: "thread-unfold", content_hash: "a".repeat(64), content_media_type: "text/plain",
            content_byte_size: 1, occurred_at: now, expected_head_id: null,
          }],
          dispositions: [{
            event_id: "event-unfold", org_id: "local-owner", disposition: "current_work",
            layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
          }],
        },
        prefs: [],
      });
      assert.equal((await store.getConversationPref("local-owner", "thread-unfold")).hidden, false);
    } finally {
      await store.close();
    }
  });

  it("keeps new current work visible when policy folding races across writers", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = await SqliteSplitAuthorityStore.open(path);
    const second = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    try {
      for (let index = 0; index < 8; index += 1) {
        const id = `event-race-${index}`;
        const thread = `thread-race-${index}`;
        const [fold, events] = await Promise.all([
          first.setConversationPolicyHidden({
            org_id: "local-owner", thread_id: thread, expected_visibility_version: 0, updated_at: now,
          }),
          second.commitIngest({
            appends: [{
              id, org_id: "local-owner", source: "synthetic", external_id: id, thread_id: thread,
              content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
              occurred_at: now, expected_head_id: null,
            }],
            dispositions: [{
              event_id: id, org_id: "local-owner", disposition: "current_work", layer: "L1_event",
              reason_codes: [], score: 1, decided_at: now,
            }],
          }),
        ]);
        assert.ok(["applied", "unchanged"].includes(fold.outcome));
        assert.equal(events[0].id, id);
        const pref = await first.getConversationPref("local-owner", thread);
        assert.notEqual(pref?.hidden, true);
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const restarted = await SqliteSplitAuthorityStore.open(path);
    try {
      for (let index = 0; index < 8; index += 1) {
        assert.notEqual((await restarted.getConversationPref("local-owner", `thread-race-${index}`))?.hidden, true);
      }
    } finally {
      await restarted.close();
    }
  });

  it("routes audited inbox disposition compare-and-set through the writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const blobStore = new FsBlobStore(join(root, "blobs"));
    try {
      const ingested = await new IngestionService(blobStore, store).ingest(createBatch());
      const eventId = ingested.records[0].event_id;
      const expected = await store.getDisposition(eventId);
      assert.ok(expected);
      const decision = {
        ...expected,
        version: (expected.version ?? 0) + 1,
        disposition: "pending",
        reason_codes: [...expected.reason_codes, "human_triage"],
        decided_at: "2026-08-26T00:01:00.000Z",
      };
      const input = {
        expected,
        decision,
        command: {
          org_id: expected.org_id,
          event_id: eventId,
          action: "triage",
          disposition: "pending",
          command_id: "inbox-triage-split-1",
          issued_at: "2026-08-26T00:01:00.000Z",
        },
      };

      assert.equal((await store.transitionDisposition(input)).outcome, "applied");
      assert.equal((await store.transitionDisposition(input)).outcome, "replayed");
      assert.deepEqual(await store.getDisposition(eventId), decision);
    } finally {
      await store.close();
    }
  });

  it("reclaims rejected replies once across writer workers and restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = await SqliteSplitAuthorityStore.open(path);
    const second = await SqliteSplitAuthorityStore.open(path);
    const input = {
      org_id: "local-owner", client_request_id: "retry-rejected", thread_id: "feishu:oc_1",
      recovery_hash: "a".repeat(64), now: "2026-08-24T00:00:00.000Z",
    };
    try {
      await first.putOutboundAttempt({ ...input, status: "rejected" });
      const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first : second).claimOutboundAttempt(input)));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal((await second.getOutboundAttempt(input.org_id, input.client_request_id)).status, "pending");
      await first.putOutboundAttempt({ ...input, status: "rejected" });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const restarted = await SqliteSplitAuthorityStore.open(path);
    try {
      assert.equal(await restarted.claimOutboundAttempt(input), true);
      assert.equal(await restarted.claimOutboundAttempt(input), false);
    } finally {
      await restarted.close();
    }
  });

  it("reserves executor starts across independent writers and restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = await SqliteSplitAuthorityStore.open(path);
    const second = await SqliteSplitAuthorityStore.open(path);
    const now = "2026-08-24T00:00:00.000Z";
    const recipe = {
      id: "r1", org_id: "local-owner", name: "Atomic starts", match: { record_class: "task" },
      trigger: { kind: "push" }, executor_type: "session", executor_config: {},
      include_context: false, can_write_back: false, enabled: true, created_at: now, updated_at: now,
    };
    let winner;
    try {
      await first.putRecipe(recipe);
      const savedRecipe = await first.getRecipe(recipe.org_id, recipe.id);
      const claims = [];
      for (let index = 0; index < 6; index += 1) {
        const id = `work-${index}`;
        const created = await first.createWorkItem({
          item: {
            id, org_id: recipe.org_id, recipe_id: recipe.id, thread_id: "feishu:oc_1",
            unit_key: id, record_class: "task", thread_facet: "ticket", status: "open",
            created_at: now, updated_at: now,
          },
          recipe: savedRecipe,
          expected_recipe: savedRecipe,
        });
        assert.equal(created.outcome, "applied");
        claims.push({
          run: {
            id: `run-${index}`, org_id: recipe.org_id, recipe_id: recipe.id, work_item_id: id,
            executor_type: "session", status: "running", start_state: "pending",
            created_at: now, updated_at: now,
          },
          max_concurrent: 1,
        });
      }
      const results = await Promise.all(claims.map((claim, index) =>
        (index % 2 ? first : second).claimWorkRunStart(claim)));
      assert.equal(results.filter(Boolean).length, 1);
      winner = claims[results.indexOf(true)];
      assert.equal((await second.getWorkRun(recipe.org_id, winner.run.id)).start_state, "pending");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const reopened = await SqliteSplitAuthorityStore.open(path);
    try {
      assert.equal(await reopened.claimWorkRunStart(winner), false);
      assert.equal((await reopened.getWorkItem(recipe.org_id, winner.run.work_item_id)).status, "running");
    } finally {
      await reopened.close();
    }
  });

  it("replays audited manual start commands through the read RPC after restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const now = "2026-08-24T00:00:00.000Z";
    const recipe = {
      id: "r1", org_id: "local-owner", name: "Audited starts", match: { record_class: "task" },
      trigger: { kind: "push" }, executor_type: "session", executor_config: {},
      include_context: false, can_write_back: false, enabled: true, created_at: now, updated_at: now,
    };
    const store = await SqliteSplitAuthorityStore.open(path);
    let command;
    let run;
    try {
      await store.putRecipe(recipe);
      const savedRecipe = await store.getRecipe(recipe.org_id, recipe.id);
      const created = await store.createWorkItem({
        item: {
          id: "work-start-command", org_id: recipe.org_id, recipe_id: recipe.id,
          thread_id: "feishu:oc_1", unit_key: "work-start-command", record_class: "task",
          thread_facet: "ticket", status: "open", created_at: now, updated_at: now,
        },
        recipe: savedRecipe,
        expected_recipe: savedRecipe,
      });
      assert.equal(created.outcome, "applied");
      const item = created.item;
      command = {
        org_id: recipe.org_id,
        work_item_id: item.id,
        expected_version: item.version,
        command_id: "manual-start-command",
        issued_at: now,
      };
      run = {
        id: "run-start-command", org_id: recipe.org_id, recipe_id: recipe.id,
        work_item_id: item.id, executor_type: "session", status: "running",
        start_state: "pending", created_at: now, updated_at: now,
      };
      assert.equal(await store.claimWorkRunStart({
        run, expected_item: item, expected_version: item.version,
        command_id: command.command_id, issued_at: command.issued_at,
      }), true);
      assert.equal((await store.getWorkRunStartReplay(command)).run.id, run.id);
    } finally {
      await store.close();
    }

    const reopened = await SqliteSplitAuthorityStore.open(path);
    try {
      const replay = await reopened.getWorkRunStartReplay(command);
      assert.equal(replay.outcome, "replayed");
      assert.equal(replay.run.id, run.id);
      assert.equal(await reopened.claimWorkRunStart({
        run: { ...run, id: "new-run" },
        expected_item: await reopened.getWorkItem(recipe.org_id, run.work_item_id),
        expected_version: command.expected_version,
        command_id: command.command_id,
        issued_at: command.issued_at,
      }), false);
    } finally {
      await reopened.close();
    }
  });

  it("allows only one outbound claim across independent writers and restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = await SqliteSplitAuthorityStore.open(path);
    const second = await SqliteSplitAuthorityStore.open(path);
    const input = {
      org_id: "local-owner", client_request_id: "shared-reply", thread_id: "feishu:oc_1",
      recovery_hash: "a".repeat(64), now: "2026-08-24T00:00:00.000Z",
    };
    try {
      const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first : second).claimOutboundAttempt(input)));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal((await second.getOutboundAttempt(input.org_id, input.client_request_id)).recovery_hash, input.recovery_hash);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const reopened = await SqliteSplitAuthorityStore.open(path);
    try {
      assert.equal(await reopened.claimOutboundAttempt(input), false);
    } finally {
      await reopened.close();
    }
  });

  it("routes snapshot index writes and reads through the RPC allowlists", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const entry = {
      org_id: "local-owner",
      thread_id: "thread-1",
      snapshot_id: "snapshot-1",
      principal: { actor_type: "human", actor_id: "local-owner" },
      consumer_id: "desktop-context-pilot",
      purpose: "display context",
      allowed_uses: ["display"],
      created_at: "2026-08-30T00:00:00.000Z",
    };
    await store.putSnapshotIndex(entry);
    assert.deepEqual(await store.listSnapshotIndex({
      org_id: entry.org_id,
      thread_id: entry.thread_id,
      principal: entry.principal,
      consumer_id: entry.consumer_id,
    }), [entry]);
    await store.close();
  });

  it("opens a readonly connection after the writer migrates", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const writer = new SqliteAuthorityStore(path);
    assert.equal(writer.readonly, false);
    writer.close();
    const reader = new SqliteAuthorityStore(path, { readonly: true });
    assert.equal(reader.readonly, true);
    await assert.rejects(
      () =>
        reader.append({
          org_id: "local-owner",
          source: "regenic",
          external_id: "blocked",
          content_hash: "a".repeat(64),
          content_media_type: "text/plain",
          content_byte_size: 1,
          occurred_at: "2026-08-24T00:00:00.000Z",
          expected_head_id: null,
        }),
      /read-only/,
    );
    reader.close();
  });

  it("ingests on the writer and lists inbox from the reader", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch());
    const inbox = await store.listInbox("local-owner");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "source-event-1");
    assert.equal(store.readonly, true);
    await store.close();
  });

  it("opens one complete context authority read with metadata and lifecycle heads", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch());
    const revision = createBatch();
    revision.delivery_id = "delivery-revision";
    revision.records[0].operation = "revise";
    revision.records[0].content[0].text = "Revised split body.";
    await service.ingest(revision);

    const read = await store.openContextRead("local-owner");
    assert.match(read.read_epoch, /^authority:[a-f0-9]{64}$/);
    assert.equal(read.events.length, 2);
    assert.equal(read.events[0].thread_id, "regenic:source-event-1");
    assert.equal(read.events[0].actor_id, "local-owner");
    assert.deepEqual(read.events[0].required_scope_ids, ["regenic:personal"]);
    assert.equal(read.events[0].content_media_type, "text/plain");
    assert.equal(read.events[1].parent_event_id, read.events[0].id);
    assert.deepEqual(read.lifecycle_heads, [{
      source: "regenic",
      external_id: "source-event-1",
      head_event_id: read.events[1].id,
    }]);
    assert.ok(read.events.every(
      (event) => Date.parse(event.ingested_at) <= Date.parse(read.recorded_at),
    ));
    await store.close();
  });

  it("scopes context reads to one thread without loading the org", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch("thread-a"));
    await service.ingest(createBatch("thread-b"));
    const full = await store.openContextRead("local-owner");
    const scoped = await store.openContextReadForThread(
      "local-owner",
      "regenic:thread-a",
    );
    assert.equal(full.events.length, 2);
    assert.equal(scoped.events.length, 1);
    assert.equal(scoped.events[0].thread_id, "regenic:thread-a");
    assert.deepEqual(scoped.lifecycle_heads, [{
      source: "regenic",
      external_id: "thread-a",
      head_event_id: scoped.events[0].id,
    }]);
    await store.close();
  });

  it("lets the reader see a full thread as soon as the writer commits", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    for (let index = 0; index < 23; index += 1) {
      await service.ingest(createBatch(`oc_yiki:om_${index}`));
    }
    const inbox = await store.listInbox("local-owner");
    assert.equal(inbox.length, 23);
    await store.close();
  });

  it("commits one page of creates in a single writer transaction", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    const result = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "page-23",
      received_at: "2026-08-24T00:00:00.000Z",
      records: Array.from({ length: 23 }, (_, index) => ({
        operation: "create",
        source: "regenic",
        external_id: `oc_yiki:om_${index}`,
        occurred_at: `2026-08-24T00:00:00.${String(index).padStart(3, "0")}Z`,
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: `Page body ${index}.`,
          },
        ],
      })),
    });
    const inbox = await store.listInbox("local-owner");
    const hashes = inbox.map((item) => item.event.content_hash).filter(Boolean);
    const blobs = await store.findBlobs(hashes);
    assert.equal(result.valid, true);
    assert.equal(result.records.filter((record) => record.status === "accepted").length, 23);
    assert.equal(inbox.length, 23);
    assert.equal(blobs.size, hashes.length);
    await store.close();
  });

  it("rolls back a page when one append conflicts", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const existing = {
      org_id: "local-owner",
      source: "regenic",
      external_id: "already-there",
      content_hash: "b".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    };
    await store.append(existing);
    await assert.rejects(
      () =>
        store.commitIngest({
          appends: [
            {
              id: "kept-if-committed",
              org_id: "local-owner",
              source: "regenic",
              external_id: "new-event",
              content_hash: "c".repeat(64),
              content_media_type: "text/plain",
              content_byte_size: 1,
              occurred_at: "2026-08-24T00:00:01.000Z",
              expected_head_id: null,
            },
            {
              ...existing,
              id: "conflict",
            },
          ],
          dispositions: [],
        }),
      AuthorityConflictError,
    );
    assert.equal((await store.listEvents("local-owner")).length, 1);
    assert.equal(await store.getEvent("local-owner", "kept-if-committed"), null);
    await store.close();
  });

  it("pages Blob inventory through the split-store reader", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    await store.append({
      org_id: "local-owner",
      source: "synthetic-chat",
      external_id: "blob-inventory-a",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    });
    await store.append({
      org_id: "local-owner",
      source: "synthetic-chat",
      external_id: "blob-inventory-b",
      content_hash: "b".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:01.000Z",
      expected_head_id: null,
    });

    const first = await store.listBlobInventoryPage({ limit: 1 });
    assert.deepEqual(first.entries.map((entry) => entry.content_hash), ["a".repeat(64)]);
    assert.equal(first.next_after_hash, "a".repeat(64));
    const second = await store.listBlobInventoryPage({
      after_hash: first.next_after_hash,
      limit: 1,
    });
    assert.deepEqual(second.entries.map((entry) => entry.content_hash), ["b".repeat(64)]);
    assert.equal(second.next_after_hash, null);
    await store.close();
  });

  it("does not make inbox wait when the writer is busy", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch());
    const held = store.stallWriter(120);
    const started = Date.now();
    const inbox = await store.listInbox("local-owner");
    const elapsed = Date.now() - started;
    assert.equal(inbox.length, 1);
    assert.ok(
      elapsed < 80,
      `inbox read waited ${elapsed}ms on the write thread`,
    );
    await held;
    await store.close();
  });

  it("reports the sqlite message when the write worker cannot open the database", async () => {
    const root = await createRoot();
    await assert.rejects(
      () => SqliteSplitAuthorityStore.open(root),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /\[object Object\]/);
        assert.match(error.message, /database|SQLITE|unable to open/i);
        return true;
      },
    );
  });

  it("revives an authority conflict from the write worker", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const event = {
      org_id: "local-owner",
      source: "regenic",
      external_id: "conflict-1",
      content_hash: "b".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    };
    await store.append(event);
    await assert.rejects(() => store.append(event), AuthorityConflictError);
    await store.close();
  });

  it("compacts inlined attachments through the write worker", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const blobs = new FsBlobStore(join(root, "blobs"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("see this", "utf8").toString("base64"),
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes_base64: png.toString("base64"),
        },
      ]),
      "utf8",
    );
    const oldHash = createHash("sha256").update(envelope).digest("hex");
    await blobs.put(oldHash, envelope, CONTENT_PARTS_MEDIA_TYPE);
    const event = await store.append({
      org_id: "local-owner",
      source: "feishu",
      external_id: "oc_1:om_1",
      content_hash: oldHash,
      content_media_type: CONTENT_PARTS_MEDIA_TYPE,
      content_byte_size: envelope.byteLength,
      occurred_at: "2026-08-27T00:00:00.000Z",
      expected_head_id: null,
    });

    const result = await compactEmbeddedContent(store, blobs, "local-owner");
    const updated = await store.getEvent("local-owner", event.id);
    const parts = parseStoredContentParts(await blobs.get(updated.content_hash));
    const attachment = parts.find((part) => part.role === "attachment");

    assert.equal(result.rewritten, 1);
    assert.notEqual(updated.content_hash, oldHash);
    assert.equal(await blobs.exists(oldHash), true);
    assert.equal(parts.find((part) => part.role === "body").text, "see this");
    assert.deepEqual(Buffer.from(await blobs.get(attachment.content_hash)), png);
    await store.close();
  });

  it("reads the latest ingest attempt without waiting on the writer", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const installation = await store.createInstallation({
      id: "installation-latest",
      org_id: "local-owner",
      connector_type: "native-local",
      status: "enabled",
      config: {},
      created_at: "2026-08-28T00:00:00.000Z",
    });
    for (const index of [1, 2, 3]) {
      await store.beginAttempt({
        id: `attempt-${index}`,
        org_id: "local-owner",
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: `page-${index}`,
        started_at: `2026-08-28T00:00:0${index}.000Z`,
      });
    }
    const held = store.stallWriter(120);
    const started = Date.now();
    const latest = await store.latestAttempt(installation.id);
    const elapsed = Date.now() - started;
    assert.equal(latest?.id, "attempt-3");
    assert.ok(
      elapsed < 80,
      `latestAttempt waited ${elapsed}ms on the write thread`,
    );
    await held;
    await store.close();
  });

  it("prunes old ingest attempts and checkpoints WAL on the writer", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const installation = await store.createInstallation({
      id: "installation-prune",
      org_id: "local-owner",
      connector_type: "native-local",
      status: "enabled",
      config: {},
      created_at: "2026-08-28T00:00:00.000Z",
    });
    for (let index = 0; index < 80; index += 1) {
      const stamp = `2026-08-28T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      await store.beginAttempt({
        id: `attempt-${index}`,
        org_id: "local-owner",
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: `page-${index}`,
        started_at: stamp,
      });
    }
    const result = await store.maintainStore();
    const remaining = await store.listAttempts(installation.id);
    const latest = await store.latestAttempt(installation.id);
    assert.equal(result.deleted, 16);
    assert.equal(remaining.length, 64);
    assert.equal(latest?.id, "attempt-79");
    await store.close();
  });

  it("prunes ingest attempts in bounded writer batches", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    const installation = await store.createInstallation({
      id: "installation-batch",
      org_id: "local-owner",
      connector_type: "native-local",
      status: "enabled",
      config: {},
      created_at: "2026-08-28T00:00:00.000Z",
    });
    for (let index = 0; index < 70; index += 1) {
      const stamp = `2026-08-28T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      await store.beginAttempt({
        id: `attempt-${index}`,
        org_id: "local-owner",
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: `page-${index}`,
        started_at: stamp,
      });
    }
    const first = await store.pruneIngestAttempts(64, 3, 1);
    const mid = await store.listAttempts(installation.id);
    const second = await store.pruneIngestAttempts(64, 3, 1);
    const remaining = await store.listAttempts(installation.id);
    assert.equal(first.deleted, 3);
    assert.equal(mid.length, 67);
    assert.equal(second.deleted, 3);
    assert.equal(remaining.length, 64);
    store.close();
  });

  it("commits a leased sync page through one writer RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    try {
      await store.createInstallation({
        id: "installation-page",
        org_id: "local-owner",
        connector_type: "fake-poll",
        status: "enabled",
        config: {},
        created_at: "2026-08-24T00:00:00.000Z",
      });
      const lease = await store.acquireLease({
        installation_id: "installation-page",
        stream_key: "personal",
        lease_owner: "worker-a",
        now: "2026-08-24T00:00:00.000Z",
        lease_duration_ms: 30_000,
      });
      await store.setConversationPolicyVisibility({
        org_id: "local-owner", thread_id: "regenic:source-event-1",
        hidden: true, expected_visibility_version: 0,
        updated_at: "2026-08-24T00:00:00.000Z",
      });
      const service = new IngestionService(
        new FsBlobStore(join(root, "blobs")),
        store,
      );
      processSyncMetrics.clear();
      const result = await service.ingest(createBatch(), {
        attempt: {
          id: "attempt-page",
          org_id: "local-owner",
          connector_installation_id: "installation-page",
          stream_key: "personal",
          delivery_id: "delivery-source-event-1",
          started_at: "2026-08-24T00:00:00.000Z",
        },
        settle: {
          attempt_id: "attempt-page",
          installation_id: "installation-page",
          stream_key: "personal",
          lease_owner: "worker-a",
          claim_token: lease.claim_token,
          finished_at: "2026-08-24T00:00:01.000Z",
          next_cursor: "cursor-2",
        },
      }, store);
      const cursor = await store.getCursor("installation-page", "personal");
      assert.equal(result.valid, true);
      assert.equal(result.page_committed, true);
      assert.equal(cursor.cursor, "cursor-2");
      assert.equal((await store.listInbox("local-owner")).length, 1);
      assert.equal((await store.getConversationPref("local-owner", "regenic:source-event-1")).hidden, false);
      const snapshot = processSyncMetrics.snapshot();
      const pageTx = snapshot.find(
        (row) =>
          row.name === "database_transaction_ms" &&
          row.labels.operation === "commit_sync_page",
      );
      const pageWait = snapshot.find(
        (row) =>
          row.name === "writer_wait_ms" &&
          row.labels.operation === "commitSyncPage",
      );
      assert.equal(pageTx?.count, 1);
      assert.ok(pageWait);
      assert.ok(
        pageWait.last < (pageTx?.last ?? 0) + 50,
        `writer_wait_ms ${pageWait.last} included the transaction ${pageTx?.last}`,
      );
    } finally {
      await store.close();
    }
  });

  it("rolls back a sync page when its inbox projection write fails", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const db = new Database(path);
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "installation-projection-failure", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: "installation-projection-failure", stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30_000,
      });
      db.exec(`CREATE TRIGGER reject_sync_projection BEFORE INSERT ON thread_heads
        BEGIN SELECT RAISE(ABORT, 'sync projection unavailable'); END`);

      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      await assert.rejects(service.ingest(createBatch(), {
        attempt: {
          id: "attempt-projection-failure", org_id: "local-owner",
          connector_installation_id: "installation-projection-failure",
          stream_key: "personal", delivery_id: "delivery-source-event-1", started_at: now,
        },
        settle: {
          attempt_id: "attempt-projection-failure",
          installation_id: "installation-projection-failure", stream_key: "personal",
          lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, next_cursor: "cursor-after",
        },
      }, store), /sync projection unavailable/);

      assert.equal(await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      }), null);
      assert.equal((await store.listAttempts("installation-projection-failure")).length, 0);
      assert.equal((await store.listInbox("local-owner")).length, 0);
      const cursor = await store.getCursor("installation-projection-failure", "personal");
      assert.equal(cursor.cursor, undefined);
    } finally {
      db.close();
      await store.close();
    }
  });

  it("rolls back sync-page disposition repair, attempt, and cursor on a repair write failure", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const db = new Database(path);
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "installation-repair-failure", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: "installation-repair-failure", stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30_000,
      });
      const event = await store.append({
        id: "repair-failure-event", org_id: "local-owner", source: "synthetic",
        external_id: "repair-failure-event", thread_id: "repair-failure-thread",
        content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      });
      db.exec(`CREATE TRIGGER reject_sync_repair BEFORE INSERT ON message_dispositions
        BEGIN SELECT RAISE(ABORT, 'sync disposition repair unavailable'); END`);

      await assert.rejects(store.commitSyncPage({
        attempt: {
          id: "attempt-repair-failure", org_id: "local-owner",
          connector_installation_id: "installation-repair-failure",
          stream_key: "personal", delivery_id: "repair-page", started_at: now,
        },
        disposition_repairs: [{
          identities: [{
            org_id: "local-owner", source: "synthetic", external_id: "repair-failure-event",
          }],
          decision: {
            event_id: event.id, org_id: "local-owner", disposition: "current_work",
            layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
          },
        }],
        settle: {
          attempt_id: "attempt-repair-failure", installation_id: "installation-repair-failure",
          stream_key: "personal", lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 0, duplicate_count: 1,
          quarantined_count: 0, retryable_failure_count: 0, next_cursor: "cursor-after",
          quarantines: [],
        },
      }), /sync disposition repair unavailable/);

      assert.equal(await store.getDisposition(event.id), null);
      assert.equal(await store.latestAttempt("installation-repair-failure"), null);
      const cursor = await store.getCursor("installation-repair-failure", "personal");
      assert.equal(cursor.cursor, undefined);
    } finally {
      db.close();
      await store.close();
    }
  });

  it("rolls back a sync-page tombstone fold when its visibility audit fails", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = await SqliteSplitAuthorityStore.open(path);
    const db = new Database(path);
    const orgId = "local-owner";
    const installationId = "installation-tombstone-audit-failure";
    const eventId = "tombstone-audit-original";
    const tombstoneId = "tombstone-audit-next";
    const thread = "tombstone-audit-thread";
    const now = "2026-08-24T00:00:00.000Z";
    const base = {
      org_id: orgId, source: "synthetic", external_id: eventId, thread_id: thread,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: now,
    };
    try {
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      await store.append({ ...base, id: eventId, expected_head_id: null });
      const lease = await store.acquireLease({
        installation_id: installationId, stream_key: "personal", lease_owner: "worker",
        now, lease_duration_ms: 30_000,
      });
      const page = {
        attempt: {
          id: "attempt-tombstone-audit-failure", org_id: orgId,
          connector_installation_id: installationId, stream_key: "personal",
          delivery_id: "tombstone-fold", started_at: now,
        },
        ingest: {
          appends: [{
            ...base, id: tombstoneId, operation: "tombstone", expected_head_id: eventId,
          }],
          dispositions: [],
        },
        prefs: [{
          org_id: orgId, thread_id: thread, hidden: true, expected_visibility_version: 0,
          updated_at: now, fold_current_tombstone_event_ids: [tombstoneId],
        }],
        settle: {
          attempt_id: "attempt-tombstone-audit-failure", installation_id: installationId,
          stream_key: "personal", lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 1, duplicate_count: 0,
          quarantined_count: 0, retryable_failure_count: 0, next_cursor: "tombstone-cursor",
          quarantines: [],
        },
      };
      db.exec(`CREATE TRIGGER reject_sync_tombstone_audit BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'sync tombstone audit unavailable'); END`);
      await assert.rejects(store.commitSyncPage(page), /sync tombstone audit unavailable/);
      assert.equal(await store.getEvent(orgId, tombstoneId), null);
      assert.equal((await store.findBySourceIdentity({
        org_id: orgId, source: "synthetic", external_id: eventId,
      })).id, eventId);
      assert.equal(await store.latestAttempt(installationId), null);
      assert.equal((await store.getCursor(installationId, "personal")).cursor, undefined);
      assert.notEqual((await store.getConversationPref(orgId, thread))?.hidden, true);

      db.exec("DROP TRIGGER reject_sync_tombstone_audit");
      assert.equal((await store.commitSyncPage(page)).attempt.status, "succeeded");
      assert.equal((await store.getConversationPref(orgId, thread)).hidden_reason, "policy");
      assert.equal((await store.getCursor(installationId, "personal")).cursor, "tombstone-cursor");
    } finally {
      db.close();
      await store.close();
    }
  });

  it("uses the shared atomic store when Runner submits a create page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "shared-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      store.commitIngest = async () => { throw new Error("unexpected separate ingest"); };
      store.commitConversationIntake = async () => {
        throw new Error("unexpected separate intake");
      };
      const runner = new ConnectorRunner({
        async poll() { return { batch: createBatch(), next_cursor: "next" }; },
      }, new IngestionService(new FsBlobStore(join(root, "blobs")), store), store, () => now);
      const result = await runner.poll({
        installation_id: "shared-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal((await store.latestAttempt("shared-installation")).status, "succeeded");
      assert.equal((await store.getCursor("shared-installation", "personal")).cursor, "next");
      assert.ok(await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      }));
    } finally {
      await store.close();
    }
  });

  for (const mode of ["create", "tombstone", "mixed", "echo", "alias", "multi-alias",
    "already-arranged"]) {
    it(`handles a ${mode} replay with the correct page commit boundary`, async () => {
      const root = await createRoot();
      const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
      const now = "2026-08-24T00:00:00.000Z";
      try {
        await store.createInstallation({
          id: "repair-installation", org_id: "local-owner", connector_type: "native-local",
          status: "enabled", config: {}, created_at: now,
        });
        const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
        const batch = createBatch();
        let eventId;
        if (mode === "echo") {
          batch.records[0] = channelRecord({
            channel: "example", kind: "user", direction: "outbound",
            external_id: "thread:out:send-1", occurred_at: now,
            actor_id: "local-owner", scope_id: "thread", text: "echo",
          });
        }
        if (mode === "alias" || mode === "multi-alias") {
          const record = batch.records[0];
          const event = await store.append({
            id: "legacy-alias-event", org_id: batch.org_id, source: "local",
            external_id: "local-outbound", content_hash: "a".repeat(64),
            content_media_type: "text/plain", content_byte_size: 1,
            occurred_at: now, expected_head_id: null,
          });
          await store.bindSourceIdentityAliases({
            org_id: batch.org_id,
            event_id: event.id,
            aliases: [
              { source: record.source, external_id: record.external_id },
              ...(mode === "multi-alias"
                ? [{ source: record.source, external_id: "second-alias" }]
                : []),
            ],
          });
          eventId = event.id;
          if (mode === "multi-alias") {
            batch.records.push({ ...record, external_id: "second-alias" });
          }
        }
        if (mode === "tombstone") {
          batch.records[0].operation = "tombstone";
          delete batch.records[0].content;
          const [event] = await store.commitIngest({
            appends: [{
              id: "legacy-tombstone", org_id: batch.org_id, source: batch.records[0].source,
              external_id: batch.records[0].external_id, operation: "tombstone",
              occurred_at: now, expected_head_id: null,
            }],
            dispositions: [],
          });
          eventId = event.id;
        } else if (mode !== "alias" && mode !== "multi-alias") {
          const commitIntake = store.commitConversationIntake.bind(store);
          if (mode !== "already-arranged") {
            store.commitConversationIntake = (request) => commitIntake({
              ...request,
              ingest: { ...request.ingest, dispositions: [] },
            });
          }
          if (mode !== "alias" && mode !== "multi-alias") {
            const created = await service.ingest(batch);
            eventId = created.records[0].event_id;
          }
          store.commitConversationIntake = commitIntake;
        }
        if (mode === "already-arranged") {
          assert.ok(await store.getDisposition(eventId));
        } else {
          assert.equal(await store.getDisposition(eventId), null);
        }
        if (mode === "echo") {
          batch.records[0] = channelRecord({
            channel: "example", kind: "user", direction: "outbound",
            external_id: "thread:remote-1", occurred_at: now,
            actor_id: "user", scope_id: "thread", text: "echo",
          });
        }
        if (mode === "mixed") {
          const newRecord = createBatch("new-event").records[0];
          batch.records = [newRecord, batch.records[0], newRecord];
        }
        const runner = new ConnectorRunner({
          async poll() { return { batch, next_cursor: "next" }; },
        }, service, store, () => now);
        const result = await runner.poll({
          installation_id: "repair-installation", stream_key: "personal",
          lease_owner: "worker", lease_duration_ms: 30000,
        });
        assert.equal(result.status, "completed");
        assert.equal(
          result.result.page_committed,
          true,
        );
        const replay = result.result.records[mode === "mixed" ? 1 : 0];
        assert.equal(replay.status, "duplicate");
        assert.equal(replay.event_id, eventId);
        if (mode === "multi-alias") {
          assert.equal(result.result.records[1].status, "duplicate");
          assert.equal(result.result.records[1].event_id, eventId);
        }
        assert.ok(await store.getDisposition(eventId));
        if (mode === "mixed") {
          assert.equal(result.result.records[0].status, "accepted");
          assert.equal(result.result.records[2].status, "duplicate");
          assert.equal(result.result.records[2].event_id, result.result.records[0].event_id);
        }
        assert.equal((await store.latestAttempt("repair-installation")).status, "succeeded");
        assert.equal((await store.getCursor("repair-installation", "personal")).cursor, "next");
      } finally {
        await store.close();
      }
    });
  }

  for (const mode of ["head", "echo-head", "disposition", "lease", "mixed-lease"]) {
    it(`does not settle a stale disposition repair after ${mode} changes`, async () => {
      const root = await createRoot();
      const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
      const now = "2026-08-24T00:00:00.000Z";
      try {
        await store.createInstallation({
          id: "repair-race", org_id: "local-owner", connector_type: "native-local",
          status: "enabled", config: {}, created_at: now,
        });
        const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
        const batch = createBatch();
        if (mode === "echo-head") {
          batch.records[0] = channelRecord({
            channel: "example", kind: "user", direction: "outbound",
            external_id: "thread:out:send-1", occurred_at: now,
            actor_id: "local-owner", scope_id: "thread", text: "Split body.",
          });
        }
        const commitIntake = store.commitConversationIntake.bind(store);
        store.commitConversationIntake = (request) => commitIntake({
          ...request,
          ingest: { ...request.ingest, dispositions: [] },
        });
        const original = await service.ingest(batch);
        store.commitConversationIntake = commitIntake;
        if (mode === "echo-head") {
          batch.records[0] = channelRecord({
            channel: "example", kind: "user", direction: "outbound",
            external_id: "thread:remote-1", occurred_at: now,
            actor_id: "user", scope_id: "thread", text: "Split body.",
          });
        }
        if (mode === "mixed-lease") batch.records.push(createBatch("new-event").records[0]);
        const eventId = original.records[0].event_id;
        const commitPage = store.commitSyncPage.bind(store);
        let repairAttempts = 0;
        store.commitSyncPage = async (page) => {
          if (page.disposition_repairs?.length) {
            repairAttempts += 1;
            if (mode === "head") {
              await store.markTombstone({
                org_id: batch.org_id, source: batch.records[0].source,
                external_id: batch.records[0].external_id, expected_head_id: eventId, occurred_at: now,
              });
            } else if (mode === "echo-head") {
              await store.markTombstone({
                org_id: batch.org_id, source: "example", external_id: "thread:out:send-1",
                expected_head_id: eventId, occurred_at: now,
              });
            } else if (mode === "disposition") {
              await store.putDispositionIfAbsent({
                event_id: eventId, org_id: batch.org_id, disposition: "outside_current_work",
                layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
              });
            } else {
              await store.acquireLease({
                installation_id: "repair-race", stream_key: "personal", lease_owner: "other",
                now, lease_duration_ms: 30000, preempt: true,
              });
            }
          }
          return commitPage(page);
        };
        const runner = new ConnectorRunner({
          async poll() { return { batch, next_cursor: "stale" }; },
        }, service, store, () => now);
        const run = runner.poll({
          installation_id: "repair-race", stream_key: "personal",
          lease_owner: "worker", lease_duration_ms: 30000,
        });
        if (mode === "lease" || mode === "mixed-lease") {
          assert.equal((await run).status, "lease_unavailable");
          assert.equal(await store.latestAttempt("repair-race"), null);
        } else {
          const result = await run;
          assert.equal(result.status, "retryable_failure");
          assert.equal(result.result.records[0].status, "retryable_failure");
          assert.equal((await store.latestAttempt("repair-race")).status, "failed");
        }
        assert.equal(repairAttempts, 1);
        assert.equal((await store.getCursor("repair-race", "personal")).cursor, undefined);
        assert.equal((await store.getDisposition(eventId))?.disposition,
          mode === "disposition" ? "outside_current_work" : undefined);
        if (mode === "mixed-lease") {
          assert.equal(await store.findBySourceIdentity({
            org_id: batch.org_id, source: "regenic", external_id: "new-event",
          }), null);
        }
      } finally {
        await store.close();
      }
    });
  }

  it("commits create, revise, and tombstone records together in one sync page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "mixed-events-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const revisedSeed = await service.ingest(createBatch("mixed-revised"));
      const deletedSeed = await service.ingest(createBatch("mixed-deleted"));
      const batch = createBatch("mixed-created");
      const revise = createBatch("mixed-revised").records[0];
      revise.operation = "revise";
      revise.content[0].text = "Revised mixed page.";
      const tombstone = createBatch("mixed-deleted").records[0];
      tombstone.operation = "tombstone";
      delete tombstone.content;
      batch.records.push(revise, tombstone);
      store.commitIngest = async () => { throw new Error("unexpected separate ingest"); };
      store.commitConversationIntake = async () => {
        throw new Error("unexpected separate intake");
      };
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      store.markTombstone = async () => { throw new Error("unexpected separate tombstone"); };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "mixed-next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "mixed-events-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.page_committed, true);
      assert.deepEqual(result.result.records.map((record) => record.status),
        ["accepted", "accepted", "accepted"]);
      const revisedHead = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-revised",
      });
      const deletedHead = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-deleted",
      });
      assert.equal(revisedHead.id, result.result.records[1].event_id);
      assert.equal(revisedHead.parent_event_id, revisedSeed.records[0].event_id);
      assert.equal(revisedHead.operation, "revise");
      assert.equal(deletedHead.id, result.result.records[2].event_id);
      assert.equal(deletedHead.parent_event_id, deletedSeed.records[0].event_id);
      assert.equal(deletedHead.operation, "tombstone");
      assert.equal((await store.latestAttempt("mixed-events-installation")).status, "succeeded");
      assert.equal((await store.getCursor("mixed-events-installation", "personal")).cursor,
        "mixed-next");
    } finally {
      await store.close();
    }
  });

  it("commits create-after-tombstone and its replay in one sync page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "recreate-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const tombstoneBatch = createBatch("recreate-source");
      tombstoneBatch.records[0].operation = "tombstone";
      delete tombstoneBatch.records[0].content;
      const originalTombstone = await service.ingest(tombstoneBatch);
      const batch = createBatch("recreate-source");
      batch.records.push({ ...batch.records[0] });
      store.commitIngest = async () => { throw new Error("unexpected separate ingest"); };
      store.commitConversationIntake = async () => {
        throw new Error("unexpected separate intake");
      };
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      store.markTombstone = async () => { throw new Error("unexpected separate tombstone"); };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "recreate-next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "recreate-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.page_committed, true);
      assert.deepEqual(result.result.records.map((record) => record.status), ["accepted", "duplicate"]);
      assert.equal(result.result.records[0].event_id, result.result.records[1].event_id);
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "recreate-source",
      });
      assert.equal(head.id, result.result.records[0].event_id);
      assert.equal(head.operation, "tombstone");
      const recreated = await store.getEvent("local-owner", head.parent_event_id);
      assert.equal(recreated.operation, "create");
      assert.equal((await store.getEvent(
        "local-owner", originalTombstone.records[0].event_id,
      )).operation, "tombstone");
      assert.equal((await store.getDisposition(head.id)).disposition, "outside_current_work");
      assert.equal(await store.getDisposition(recreated.id), null);
      assert.equal((await store.latestAttempt("recreate-installation")).status, "succeeded");
      assert.equal((await store.getCursor("recreate-installation", "personal")).cursor,
        "recreate-next");
    } finally {
      await store.close();
    }
  });

  it("rolls back a mixed event page when its lease is taken over", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "mixed-lease-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const revisedSeed = await service.ingest(createBatch("mixed-lease-revised"));
      const deletedSeed = await service.ingest(createBatch("mixed-lease-deleted"));
      const previousRevisedDisposition = await store.getDisposition(revisedSeed.records[0].event_id);
      const previousRevisedPref = await store.getConversationPref(
        "local-owner", "regenic:mixed-lease-revised",
      );
      const previousDeletedPref = await store.getConversationPref(
        "local-owner", "regenic:mixed-lease-deleted",
      );
      const batch = createBatch("mixed-lease-created");
      const revise = createBatch("mixed-lease-revised").records[0];
      revise.operation = "revise";
      revise.content[0].text = "Revised mixed page.";
      const tombstone = createBatch("mixed-lease-deleted").records[0];
      tombstone.operation = "tombstone";
      delete tombstone.content;
      batch.records.push(revise, tombstone);
      const commitPage = store.commitSyncPage.bind(store);
      store.commitSyncPage = async (page) => {
        await store.acquireLease({
          installation_id: "mixed-lease-installation", stream_key: "personal",
          lease_owner: "other-worker", now, lease_duration_ms: 30000, preempt: true,
        });
        return commitPage(page);
      };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "mixed-next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "mixed-lease-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "lease_unavailable");
      assert.equal(await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-lease-created",
      }), null);
      assert.equal((await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-lease-revised",
      })).id, revisedSeed.records[0].event_id);
      assert.equal((await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-lease-deleted",
      })).id, deletedSeed.records[0].event_id);
      assert.deepEqual(
        await store.getDisposition(revisedSeed.records[0].event_id),
        previousRevisedDisposition,
      );
      assert.equal((await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-lease-deleted",
      })).operation, "create");
      assert.deepEqual(await store.getConversationPref(
        "local-owner", "regenic:mixed-lease-revised",
      ), previousRevisedPref);
      assert.deepEqual(await store.getConversationPref(
        "local-owner", "regenic:mixed-lease-deleted",
      ), previousDeletedPref);
      assert.equal(await store.latestAttempt("mixed-lease-installation"), null);
      assert.equal((await store.getCursor("mixed-lease-installation", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("rejects a mixed page after a source-head race without partial writes", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "mixed-race-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      await service.ingest(createBatch("mixed-race-revised"));
      const batch = createBatch("mixed-race-created");
      const revise = createBatch("mixed-race-revised").records[0];
      revise.operation = "revise";
      revise.content[0].text = "Page revision.";
      batch.records.push(revise);
      const commitPage = store.commitSyncPage.bind(store);
      let raced = false;
      let concurrentRevisionId;
      store.commitSyncPage = async (page) => {
        if (page.ingest && !raced) {
          raced = true;
          const concurrent = createBatch("mixed-race-revised");
          concurrent.records[0].operation = "revise";
          concurrent.records[0].content[0].text = "Concurrent revision.";
          concurrentRevisionId = (await service.ingest(concurrent)).records[0].event_id;
        }
        return commitPage(page);
      };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "mixed-next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "mixed-race-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.notEqual(result.result.page_committed, true);
      assert.deepEqual(result.result.records.map((record) => record.status),
        ["retryable_failure", "retryable_failure"]);
      assert.ok(result.result.records.every((record) => record.event_id === undefined));
      assert.equal(await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-race-created",
      }), null);
      const revisedHead = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "mixed-race-revised",
      });
      assert.equal(revisedHead.id, concurrentRevisionId);
      assert.equal((await store.latestAttempt("mixed-race-installation")).status, "failed");
      assert.equal((await store.getCursor("mixed-race-installation", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("rejects a same-identity revision chain after its page loses a source-head race", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "revision-chain-race-installation", org_id: "local-owner",
        connector_type: "native-local", status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const seed = await service.ingest(createBatch("revision-chain-race"));
      const firstRevision = createBatch("revision-chain-race").records[0];
      firstRevision.operation = "revise";
      firstRevision.content[0].text = "Page revision one.";
      const secondRevision = createBatch("revision-chain-race").records[0];
      secondRevision.operation = "revise";
      secondRevision.content[0].text = "Page revision two.";
      const batch = createBatch("revision-chain-race");
      batch.records = [firstRevision, secondRevision];
      const commitPage = store.commitSyncPage.bind(store);
      let concurrentRevisionId;
      store.commitSyncPage = async (page) => {
        if (page.ingest && !concurrentRevisionId) {
          const concurrent = createBatch("revision-chain-race");
          concurrent.records[0].operation = "revise";
          concurrent.records[0].content[0].text = "Concurrent revision.";
          concurrentRevisionId = (await service.ingest(concurrent)).records[0].event_id;
        }
        return commitPage(page);
      };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "revision-chain-next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "revision-chain-race-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.notEqual(result.result.page_committed, true);
      assert.deepEqual(result.result.records.map((record) => record.status),
        ["retryable_failure", "retryable_failure"]);
      assert.ok(result.result.records.every((record) => record.event_id === undefined));
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "revision-chain-race",
      });
      assert.equal(head.id, concurrentRevisionId);
      assert.equal(head.parent_event_id, seed.records[0].event_id);
      assert.equal((await store.latestAttempt("revision-chain-race-installation")).status, "failed");
      assert.equal((await store.getCursor(
        "revision-chain-race-installation", "personal",
      )).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("commits a single revision with its attempt and cursor in one page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "revision-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const seed = createBatch();
      seed.records[0].content = [
        { role: "body", media_type: "text/plain", text: "ok" },
        {
          role: "metadata",
          media_type: "application/vnd.regenic.surface+json",
          text: JSON.stringify({
            channel: "regenic",
            kind: "assistant",
            direction: "inbound",
          }),
        },
      ];
      const created = await service.ingest(seed);
      assert.equal((await store.getDisposition(created.records[0].event_id)).disposition, "outside_current_work");
      assert.equal((await store.setConversationPolicyVisibility({
        org_id: "local-owner", thread_id: "regenic:source-event-1",
        hidden: true, expected_visibility_version: 0, updated_at: now,
      })).outcome, "applied");
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      const batch = createBatch();
      batch.records[0].operation = "revise";
      batch.records[0].revision_id = "revision-1";
      batch.records[0].type = "task";
      batch.records[0].content[0].text = "Revised.";
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "revision-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.records[0].status, "accepted");
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.id, result.result.records[0].event_id);
      assert.equal(head.operation, "revise");
      assert.equal(head.parent_event_id, created.records[0].event_id);
      const reader = new Database(join(root, "authority.db"), { readonly: true });
      try {
        assert.equal(reader.prepare("SELECT revision_id FROM events WHERE id = ?").get(head.id).revision_id, "revision-1");
      } finally {
        reader.close();
      }
      assert.ok(await store.getDisposition(head.id));
      assert.equal((await store.getConversationPref("local-owner", "regenic:source-event-1")).hidden, false);
      assert.equal((await store.latestAttempt("revision-installation")).status, "succeeded");
      assert.equal((await store.getCursor("revision-installation", "personal")).cursor, "next");
    } finally {
      await store.close();
    }
  });

  it("rolls back a revision page when its lease is taken before settlement", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "revision-lease", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const created = await service.ingest(createBatch());
      const previousDisposition = await store.getDisposition(created.records[0].event_id);
      const previousPref = await store.getConversationPref("local-owner", "regenic:source-event-1");
      const commitPage = store.commitSyncPage.bind(store);
      let attemptedEventId;
      store.commitSyncPage = async (page) => {
        attemptedEventId = page.ingest.appends[0].id;
        await store.acquireLease({
          installation_id: "revision-lease", stream_key: "personal", lease_owner: "other-worker",
          now, lease_duration_ms: 30000, preempt: true,
        });
        return commitPage(page);
      };
      const batch = createBatch();
      batch.records[0].operation = "revise";
      batch.records[0].content[0].text = "Revised.";
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "stale" }; },
      }, service, store, () => now);
      assert.equal((await runner.poll({
        installation_id: "revision-lease", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      })).status, "lease_unavailable");
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.id, created.records[0].event_id);
      assert.ok(attemptedEventId);
      assert.equal(await store.getEvent("local-owner", attemptedEventId), null);
      assert.equal(await store.getDisposition(attemptedEventId), null);
      assert.deepEqual(await store.getDisposition(created.records[0].event_id), previousDisposition);
      assert.deepEqual(await store.getConversationPref("local-owner", "regenic:source-event-1"), previousPref);
      assert.equal(await store.latestAttempt("revision-lease"), null);
      assert.equal((await store.getCursor("revision-lease", "personal")).cursor, undefined);
      assert.equal(await store.acquireLease({
        installation_id: "revision-lease", stream_key: "personal", lease_owner: "third-worker",
        now, lease_duration_ms: 30000,
      }), null);
    } finally {
      await store.close();
    }
  });

  it("commits an attachment enrichment as a single revision page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "attachment-revision", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const pointer = createBatch();
      pointer.records[0].content = [{
        role: "attachment", media_type: "image/png", source_filename: "image.png",
        external_locator: "source://image/1",
      }];
      const created = await service.ingest(pointer);
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      const batch = createBatch();
      batch.records[0].content = [{
        ...pointer.records[0].content[0], bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      }];
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "attachment-revision", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.records[0].status, "accepted");
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.operation, "revise");
      assert.equal(head.parent_event_id, created.records[0].event_id);
      assert.equal((await store.latestAttempt("attachment-revision")).status, "succeeded");
      assert.equal((await store.getCursor("attachment-revision", "personal")).cursor, "next");
    } finally {
      await store.close();
    }
  });

  it("does not partially commit an atomic revision after a source-head conflict", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "revision-race", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const seed = await service.ingest(createBatch());
      const commitPage = store.commitSyncPage.bind(store);
      let concurrentId;
      store.commitSyncPage = async (page) => {
        if (page.ingest && !concurrentId) {
          const concurrent = createBatch();
          concurrent.records[0].operation = "revise";
          concurrent.records[0].content[0].text = "Concurrent.";
          concurrentId = (await service.ingest(concurrent)).records[0].event_id;
        }
        return commitPage(page);
      };
      const batch = createBatch();
      batch.records[0].operation = "revise";
      batch.records[0].content[0].text = "Revised.";
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "revision-race", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.ok(concurrentId);
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.id, concurrentId);
      assert.equal(head.parent_event_id, seed.records[0].event_id);
      assert.equal(result.result.records[0].status, "retryable_failure");
      assert.equal(result.result.records[0].event_id, undefined);
      assert.equal((await store.latestAttempt("revision-race")).status, "failed");
      assert.equal((await store.getCursor("revision-race", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  for (const hasHead of [true, false]) {
    it(`commits a single tombstone page ${hasHead ? "with" : "without"} a source head`, async () => {
      const root = await createRoot();
      const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
      const now = "2026-08-24T00:00:00.000Z";
      try {
        await store.createInstallation({
          id: "tombstone-installation", org_id: "local-owner", connector_type: "native-local",
          status: "enabled", config: {}, created_at: now,
        });
        const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
        const identity = { org_id: "local-owner", source: "regenic", external_id: "source-event-1" };
        if (hasHead) {
          const seed = createBatch();
          seed.records[0].type = "task";
          await service.ingest(seed);
        }
        const before = await store.findBySourceIdentity(identity);
        const blob = before?.content_hash ? await store.findBlob(before.content_hash) : null;
        store.markTombstone = async () => { throw new Error("unexpected separate tombstone"); };
        const batch = createBatch();
        batch.records[0].operation = "tombstone";
        delete batch.records[0].content;
        const runner = new ConnectorRunner({
          async poll() { return { batch, next_cursor: "next" }; },
        }, service, store, () => now);
        const result = await runner.poll({
          installation_id: "tombstone-installation", stream_key: "personal",
          lease_owner: "worker", lease_duration_ms: 30000,
        });
        assert.equal(result.status, "completed");
        assert.equal(result.result.records[0].status, "accepted");
        const head = await store.findBySourceIdentity(identity);
        assert.equal(head.id, result.result.records[0].event_id);
        assert.equal(head.operation, "tombstone");
        assert.equal(head.parent_event_id, before?.id);
        assert.equal(head.content_hash, before?.content_hash);
        if (blob) assert.deepEqual(await store.findBlob(blob.content_hash), blob);
        assert.ok(await store.getDisposition(head.id));
        if (before) {
          const reader = new Database(join(root, "authority.db"), { readonly: true });
          try {
            const row = reader.prepare(
              "SELECT payload_json FROM conversation_lifecycle_events WHERE aggregate_id = ? AND event_type = 'current_work_changed'",
            ).get(head.id);
            assert.equal(JSON.parse(row.payload_json).previous.event_id, before.id);
            assert.equal(JSON.parse(row.payload_json).previous.disposition, "current_work");
          } finally {
            reader.close();
          }
        }
        assert.equal((await store.latestAttempt("tombstone-installation")).status, "succeeded");
        assert.equal((await store.getCursor("tombstone-installation", "personal")).cursor, "next");
      } finally {
        await store.close();
      }
    });
  }

  it("rolls back a tombstone page when its lease is taken before settlement", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "tombstone-lease", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const created = await service.ingest(createBatch());
      const previousDisposition = await store.getDisposition(created.records[0].event_id);
      const previousPref = await store.getConversationPref("local-owner", "regenic:source-event-1");
      const commitPage = store.commitSyncPage.bind(store);
      let attemptedEventId;
      store.commitSyncPage = async (page) => {
        attemptedEventId = page.ingest.appends[0].id;
        await store.acquireLease({
          installation_id: "tombstone-lease", stream_key: "personal", lease_owner: "other-worker",
          now, lease_duration_ms: 30000, preempt: true,
        });
        return commitPage(page);
      };
      const batch = createBatch();
      batch.records[0].operation = "tombstone";
      delete batch.records[0].content;
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "stale" }; },
      }, service, store, () => now);
      assert.equal((await runner.poll({
        installation_id: "tombstone-lease", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      })).status, "lease_unavailable");
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.id, created.records[0].event_id);
      assert.ok(attemptedEventId);
      assert.equal(await store.getEvent("local-owner", attemptedEventId), null);
      assert.equal(await store.getDisposition(attemptedEventId), null);
      assert.deepEqual(await store.getDisposition(created.records[0].event_id), previousDisposition);
      assert.deepEqual(await store.getConversationPref("local-owner", "regenic:source-event-1"), previousPref);
      assert.equal(await store.latestAttempt("tombstone-lease"), null);
      assert.equal((await store.getCursor("tombstone-lease", "personal")).cursor, undefined);
      assert.equal(await store.acquireLease({
        installation_id: "tombstone-lease", stream_key: "personal", lease_owner: "third-worker",
        now, lease_duration_ms: 30000,
      }), null);
    } finally {
      await store.close();
    }
  });

  it("does not partially commit an atomic tombstone after a source-head conflict", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "tombstone-race", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(new FsBlobStore(join(root, "blobs")), store);
      const commitPage = store.commitSyncPage.bind(store);
      let concurrentId;
      store.commitSyncPage = async (page) => {
        if (page.ingest && !concurrentId) {
          concurrentId = (await service.ingest(createBatch())).records[0].event_id;
        }
        return commitPage(page);
      };
      const batch = createBatch();
      batch.records[0].operation = "tombstone";
      delete batch.records[0].content;
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, service, store, () => now);
      const result = await runner.poll({
        installation_id: "tombstone-race", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.ok(concurrentId);
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      });
      assert.equal(head.id, concurrentId);
      assert.equal(head.operation, "create");
      assert.equal(result.result.records[0].status, "retryable_failure");
      assert.equal(result.result.records[0].event_id, undefined);
      assert.equal((await store.latestAttempt("tombstone-race")).status, "failed");
      assert.equal((await store.getCursor("tombstone-race", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("retries a create page after a source-head race instead of settling partial duplicates", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "race-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const commitPage = store.commitSyncPage.bind(store);
      let injected = false;
      store.commitSyncPage = async (page) => {
        if (page.ingest && !injected) {
          injected = true;
          await store.commitIngest({
            appends: [{
              ...page.ingest.appends[0],
              id: "concurrent-event",
              content_hash: "f".repeat(64),
            }],
            dispositions: [{ ...page.ingest.dispositions[0], event_id: "concurrent-event" }],
          });
        }
        return commitPage(page);
      };
      const batch = createBatch();
      batch.records.push({ ...batch.records[0] });
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, new IngestionService(new FsBlobStore(join(root, "blobs")), store), store, () => now);
      const result = await runner.poll({
        installation_id: "race-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.deepEqual(result.result.records.map((record) => record.status),
        ["retryable_failure", "retryable_failure"]);
      assert.ok(result.result.records.every((record) => record.event_id === undefined));
      assert.equal((await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      })).id, "concurrent-event");
      assert.equal((await store.latestAttempt("race-installation")).retryable_failure_count, 2);
      assert.equal((await store.getCursor("race-installation", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("does not advance the cursor when a pending duplicate's create cannot be retried", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "retry-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const commitPage = store.commitSyncPage.bind(store);
      store.commitSyncPage = async (page) => {
        if (page.ingest) throw new AuthorityConflictError();
        return commitPage(page);
      };
      store.commitIngest = async () => { throw new AuthorityConflictError(); };
      store.commitConversationIntake = async () => { throw new AuthorityConflictError(); };
      const batch = createBatch();
      batch.records.push({ ...batch.records[0] });
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, new IngestionService(new FsBlobStore(join(root, "blobs")), store), store, () => now);
      const result = await runner.poll({
        installation_id: "retry-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "retryable_failure");
      assert.deepEqual(result.result.records.map((record) => record.status), ["retryable_failure", "retryable_failure"]);
      assert.ok(result.result.records.every((record) => record.event_id === undefined));
      assert.equal((await store.latestAttempt("retry-installation")).retryable_failure_count, 2);
      assert.equal((await store.getCursor("retry-installation", "personal")).cursor, undefined);
    } finally {
      await store.close();
    }
  });

  it("commits successive revisions and a tombstone of one pending source identity in one page", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await store.createInstallation({
        id: "mixed-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const batch = createBatch();
      const original = batch.records[0];
      const attachmentBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
      ]);
      const attachmentHash = createHash("sha256").update(attachmentBytes).digest("hex");
      const blobStore = new FsBlobStore(join(root, "blobs"));
      original.content = [
        { role: "body", media_type: "text/plain", text: "Original" },
        {
          role: "attachment", media_type: "image/png", source_filename: "image.png",
          external_locator: "source://image/1", bytes: attachmentBytes,
        },
      ];
      batch.records.push(
        {
          ...original,
          operation: "revise",
          content: [
            { role: "body", media_type: "text/plain", text: "Revised" },
            {
              role: "attachment", media_type: "image/png", source_filename: "image.png",
              external_locator: "source://image/1",
            },
          ],
        },
        {
          ...original,
          operation: "revise",
          content: [
            { role: "body", media_type: "text/plain", text: "Revised again" },
            {
              role: "attachment", media_type: "image/png", source_filename: "image.png",
              external_locator: "source://image/1",
            },
          ],
        },
        { ...original, operation: "tombstone", content: undefined },
      );
      store.commitIngest = async () => { throw new Error("unexpected separate ingest"); };
      store.commitConversationIntake = async () => {
        throw new Error("unexpected separate intake");
      };
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      store.markTombstone = async () => { throw new Error("unexpected separate tombstone"); };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "next" }; },
      }, new IngestionService(blobStore, store), store, () => now);
      const result = await runner.poll({
        installation_id: "mixed-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.page_committed, true);
      assert.deepEqual(result.result.records.map((record) => record.status),
        ["accepted", "accepted", "accepted", "accepted"]);
      const head = await store.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: original.external_id,
      });
      assert.equal(head.id, result.result.records[3].event_id);
      assert.equal(head.operation, "tombstone");
      assert.equal(head.parent_event_id, result.result.records[2].event_id);
      for (const [index, record] of result.result.records.slice(0, 3).entries()) {
        const event = await store.getEvent("local-owner", record.event_id);
        const content = await blobStore.get(event.content_hash);
        const parts = parseStoredContentParts(content);
        assert.ok(parts?.some((part) => part.content_hash === attachmentHash),
          `attachment missing from record ${index}, ${record.event_id} (${attachmentHash}): ${JSON.stringify(parts)}`);
      }
      assert.equal((await store.getDisposition(head.id)).disposition, "outside_current_work");
      assert.equal((await store.getCursor("mixed-installation", "personal")).cursor, "next");
    } finally {
      await store.close();
    }
  });

  it("rejects a page when Authority and runtime are different SQL stores", async () => {
    const root = await createRoot();
    const authority = new SqliteAuthorityStore(join(root, "authority.db"));
    const runtime = await SqliteSplitAuthorityStore.open(join(root, "runtime.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      await runtime.createInstallation({
        id: "separate-installation", org_id: "local-owner", connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const runner = new ConnectorRunner({
        async poll() { return { batch: createBatch(), next_cursor: "next" }; },
      }, new IngestionService(new FsBlobStore(join(root, "blobs")), authority), runtime, () => now);
      await assert.rejects(runner.poll({
        installation_id: "separate-installation", stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      }), /same atomic Authority and runtime store/);
      assert.equal(await authority.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      }), null);
      assert.equal((await runtime.latestAttempt("separate-installation")).status, "failed");
      assert.equal((await runtime.getCursor("separate-installation", "personal")).cursor, undefined);
    } finally {
      authority.close();
      await runtime.close();
    }
  });

  it("counts writer queue time separately from the page transaction", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    try {
      await store.createInstallation({
        id: "installation-wait",
        org_id: "local-owner",
        connector_type: "fake-poll",
        status: "enabled",
        config: {},
        created_at: "2026-08-24T00:00:00.000Z",
      });
      const lease = await store.acquireLease({
        installation_id: "installation-wait",
        stream_key: "personal",
        lease_owner: "worker-a",
        now: "2026-08-24T00:00:00.000Z",
        lease_duration_ms: 30_000,
      });
      processSyncMetrics.clear();
      const held = store.stallWriter(80);
      await store.commitSyncPage({
        attempt: {
          id: "attempt-wait",
          org_id: "local-owner",
          connector_installation_id: "installation-wait",
          stream_key: "personal",
          delivery_id: "page-wait",
          started_at: "2026-08-24T00:00:00.000Z",
        },
        settle: {
          attempt_id: "attempt-wait",
          installation_id: "installation-wait",
          stream_key: "personal",
          lease_owner: "worker-a",
          claim_token: lease.claim_token,
          finished_at: "2026-08-24T00:00:01.000Z",
          accepted_count: 0,
          duplicate_count: 0,
          quarantined_count: 0,
          retryable_failure_count: 0,
          quarantines: [],
        },
      });
      await held;
      const snapshot = processSyncMetrics.snapshot();
      const pageTx = snapshot.find(
        (row) =>
          row.name === "database_transaction_ms" &&
          row.labels.operation === "commit_sync_page",
      );
      const pageWait = snapshot.find(
        (row) =>
          row.name === "writer_wait_ms" &&
          row.labels.operation === "commitSyncPage",
      );
      assert.ok(pageTx && pageTx.last < 70, `transaction was ${pageTx?.last}ms`);
      assert.ok(
        pageWait && pageWait.last >= 70,
        `writer_wait_ms was ${pageWait?.last}`,
      );
    } finally {
      await store.close();
    }
  });
});
