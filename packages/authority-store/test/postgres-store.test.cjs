const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  hashStandardVersionBody,
} = require("@regenic/domain");
const { FsBlobStore } = require("@regenic/blob-store");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHost } = require("@regenic/plugin-host");
const { Client } = require("pg");
const {
  PostgresAuthorityStore,
  postgresAuthorityPlugin,
} = require("../dist/postgres");
const { PG_MIGRATIONS, PG_BASELINE_SQL } = require("../dist/postgres/schema");
const { renewLease, resetCursor, settleAttemptOn } = require("../dist/postgres/sync");

const baseConnectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = baseConnectionString ? describe : describe.skip;
const schemas = [];

it("opens a read-only PostgreSQL store without running migrations", async () => {
  await assert.rejects(
    PostgresAuthorityStore.open("postgres://operator:example@127.0.0.1:1/authority", {
      readOnly: true,
    }),
    /migrations to be disabled/,
  );
  const store = await PostgresAuthorityStore.open(
    "postgres://operator:example@127.0.0.1:1/authority",
    { migrate: false, readOnly: true },
  );
  assert.equal(store.readonly, true);
  await store.close();
});

describe("postgres cursor locking", () => {
  it("rechecks a competing lease after locking the cursor before reset", async () => {
    let updated = false;
    const client = {};
    const db = {
      async withTx(fn) { return fn(client); },
      async queryOne(sql, _params, actualClient) {
        assert.equal(actualClient, client);
        if (sql.includes("clock_timestamp()")) return { active: true };
        const locked = sql.includes("FOR UPDATE");
        return { installation_id: "installation", stream_key: "stream", cursor_value: "cursor",
          cursor_version: 1, lease_owner: locked ? "new-worker" : null,
          lease_expires_at: locked ? "2026-08-12T00:01:00.000Z" : null,
          updated_at: "2026-08-12T00:00:00.000Z" };
      },
      async execute() { updated = true; return 1; },
    };
    await assert.rejects(resetCursor(db, { installation_id: "installation", stream_key: "stream",
      now: "2026-08-12T00:00:01.000Z" }), /cursor is leased/);
    assert.equal(updated, false);
  });

  it("checks the locked cursor owner before settling an attempt", async () => {
    let updated = false;
    const client = {};
    const db = {
      async queryOne(sql, _params, actualClient) {
        assert.equal(actualClient, client);
        if (sql.includes("FROM connector_installations")) return { id: "installation", org_id: "org" };
        if (sql.includes("FROM ingest_attempts")) return {
          id: "attempt", org_id: "org", connector_installation_id: "installation", stream_key: "stream",
          delivery_id: "page", started_at: "2026-08-12T00:00:00.000Z", status: "running",
          accepted_count: 0, duplicate_count: 0, quarantined_count: 0, retryable_failure_count: 0,
        };
        if (sql.includes("FROM connector_cursors")) return {
          installation_id: "installation", stream_key: "stream", cursor_value: null, cursor_version: 1,
          lease_owner: sql.includes("FOR UPDATE") ? "new-worker" : "old-worker",
          lease_claim_token: sql.includes("FOR UPDATE") ? "new-token" : "old-token",
          lease_expires_at: "2026-08-12T00:01:00.000Z", updated_at: "2026-08-12T00:00:00.000Z",
        };
        throw new Error("Unexpected query");
      },
      async execute() { updated = true; return 1; },
    };
    await assert.rejects(settleAttemptOn(db, client, { attempt_id: "attempt", installation_id: "installation",
      stream_key: "stream", lease_owner: "old-worker", claim_token: "old-token",
      finished_at: "2026-08-12T00:00:01.000Z",
      accepted_count: 1, duplicate_count: 0, quarantined_count: 0, retryable_failure_count: 0,
      quarantines: [] }), /lease is not held/);
    assert.equal(updated, false);
  });

  it("renews only the matching active connector lease claim", async () => {
    const input = {
      installation_id: "installation",
      stream_key: "stream",
      lease_owner: "worker",
      claim_token: "claim-token",
      now: "2026-08-12T00:00:01.000Z",
      lease_duration_ms: 1000,
    };
    const row = {
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      cursor_value: "cursor",
      cursor_version: 2,
      lease_owner: input.lease_owner,
      lease_claim_token: input.claim_token,
      lease_expires_at: "2026-08-12T00:00:02.000Z",
      updated_at: input.now,
    };
    let queries = 0;
    const db = {
      async queryOne(sql, params) {
        queries += 1;
        const normalizedSql = sql.replace(/\s+/g, " ");
        assert.match(normalizedSql, /lease_expires_at = clock_timestamp\(\) \+ \(\$1 \* interval '1 millisecond'\)/);
        assert.match(normalizedSql, /lease_owner = \$5/);
        assert.match(normalizedSql, /lease_claim_token = \$6/);
        assert.match(normalizedSql, /lease_expires_at > clock_timestamp\(\)/);
        assert.deepEqual(params, [
          input.lease_duration_ms,
          input.now,
          input.installation_id,
          input.stream_key,
          input.lease_owner,
          input.claim_token,
        ]);
        return row;
      },
    };

    const renewed = await renewLease(db, input);
    assert.equal(queries, 1);
    assert.equal(renewed.claim_token, input.claim_token);
    assert.equal(renewed.lease_expires_at, row.lease_expires_at);

    const staleDb = {
      async queryOne() { return null; },
    };
    assert.equal(await renewLease(staleDb, input), null);
  });
});

async function isolatedPostgresUrl(base) {
  const schema = `s${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await client.end();
  }
  const url = new URL(base);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

describePg("postgres authority store", () => {
  const stores = [];
  const roots = [];
  let connectionStringPromise;

  function isolatedUrl() {
    connectionStringPromise ??= isolatedPostgresUrl(baseConnectionString);
    return connectionStringPromise;
  }

  after(async () => {
    try {
      await Promise.all(stores.splice(0).map((store) => store.close()));
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
    } finally {
      if (schemas.length) {
        const admin = new Client({ connectionString: baseConnectionString });
        await admin.connect();
        try {
          for (const schema of schemas.splice(0)) {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          }
        } finally {
          await admin.end();
        }
      }
    }
  });

  async function openStore() {
    const store = await PostgresAuthorityStore.open(await isolatedUrl());
    stores.push(store);
    return store;
  }

  it("enforces read-only transactions when migrations are disabled", async () => {
    await openStore();
    const reader = await PostgresAuthorityStore.open(await isolatedUrl(), {
      migrate: false,
      readOnly: true,
    });
    stores.push(reader);
    assert.equal(reader.readonly, true);
    assert.deepEqual(await reader.listBlobInventoryPage({ limit: 1 }), {
      entries: [],
      next_after_hash: null,
    });
    await assert.rejects(
      reader.putConversationPref({
        org_id: "read-only-check",
        thread_id: "read-only-check",
        updated_at: "2026-11-15T00:00:00.000Z",
      }),
      /read-only transaction/,
    );
  });

  async function waitForBlockedTransaction(client, blockerPid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { rows } = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
        [blockerPid],
      );
      if (rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("PostgreSQL operation did not block on the held cursor row");
  }

  it("does not reset a lease acquired while reset waits on the cursor", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const installationId = `installation-${randomUUID()}`;
    const now = new Date().toISOString();
    const futureLeaseExpiry = new Date(Date.now() + 60_000).toISOString();
    await store.createInstallation({ id: installationId, org_id: orgId, connector_type: "fake-poll",
      status: "enabled", config: {}, created_at: now });
    const lease = { installation_id: installationId, stream_key: "personal",
      lease_owner: "old-worker", now, lease_duration_ms: 30000 };
    const acquiredLease = await store.acquireLease(lease);
    await store.releaseLease({ ...lease, claim_token: acquiredLease.claim_token });
    const blocker = new Client({ connectionString: await isolatedUrl() });
    const monitor = new Client({ connectionString: await isolatedUrl() });
    await blocker.connect();
    await monitor.connect();
    let active = false;
    let pending;
    try {
      await blocker.query("BEGIN");
      active = true;
      const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query(`UPDATE connector_cursors SET lease_owner = $1, lease_expires_at = $2
        WHERE installation_id = $3 AND stream_key = $4`,
      ["new-worker", futureLeaseExpiry, installationId, "personal"]);
      pending = store.resetCursor({ installation_id: installationId, stream_key: "personal",
        now: "2026-08-24T00:00:01.000Z" }).then(() => null, (error) => error);
      await waitForBlockedTransaction(monitor, rows[0].pid);
      await blocker.query("COMMIT");
      active = false;
      const error = await pending;
      assert.match(error?.message ?? "", /cursor is leased/);
      assert.equal(await store.acquireLease({ ...lease, lease_owner: "third-worker",
        now: "2026-08-24T00:00:01.000Z" }), null);
      assert.equal((await store.getCursor(installationId, "personal")).cursor_version, 1);
    } finally {
      if (active) await blocker.query("ROLLBACK");
      if (pending) await pending;
      await monitor.end();
      await blocker.end();
    }
  });

  it("uses the current cursor after settlement waits for a concurrent cursor write", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const installationId = `installation-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    const now = "2026-08-24T00:00:00.000Z";
    await store.createInstallation({ id: installationId, org_id: orgId, connector_type: "fake-poll",
      status: "enabled", config: {}, created_at: now });
    const lease = await store.acquireLease({ installation_id: installationId, stream_key: "personal",
      lease_owner: "worker", now, lease_duration_ms: 30000 });
    await store.beginAttempt({ id: attemptId, org_id: orgId, connector_installation_id: installationId,
      stream_key: "personal", delivery_id: "page", started_at: now });
    const blocker = new Client({ connectionString: await isolatedUrl() });
    const monitor = new Client({ connectionString: await isolatedUrl() });
    await blocker.connect();
    await monitor.connect();
    let active = false;
    let pending;
    try {
      await blocker.query("BEGIN");
      active = true;
      const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query(`UPDATE connector_cursors SET cursor_value = $1, cursor_version = 2
        WHERE installation_id = $2 AND stream_key = $3`, ["concurrent", installationId, "personal"]);
      pending = store.settleAttempt({ attempt_id: attemptId, installation_id: installationId,
        stream_key: "personal", lease_owner: "worker", claim_token: lease.claim_token, finished_at: now,
        accepted_count: 0, duplicate_count: 0, quarantined_count: 0, retryable_failure_count: 1,
        quarantines: [] }).then((attempt) => ({ attempt }), (error) => ({ error }));
      await waitForBlockedTransaction(monitor, rows[0].pid);
      await blocker.query("COMMIT");
      active = false;
      const result = await pending;
      assert.ifError(result.error);
      assert.equal(result.attempt.status, "failed");
      const cursor = await store.getCursor(installationId, "personal");
      assert.equal(cursor.cursor, "concurrent");
      assert.equal(cursor.cursor_version, 2);
    } finally {
      if (active) await blocker.query("ROLLBACK");
      if (pending) await pending;
      await monitor.end();
      await blocker.end();
    }
  });

  async function ingestHarness() {
    const root = await mkdtemp(join(tmpdir(), "regenic-pg-blobs-"));
    roots.push(root);
    const authority = await openStore();
    const blobs = new FsBlobStore(join(root, "blobs"));
    return {
      authority,
      blobs,
      service: new IngestionService(blobs, authority),
      orgId: `org-${randomUUID()}`,
    };
  }

  function createBatch(orgId, externalId = "source-event-1") {
    return {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: orgId,
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
            { role: "body", media_type: "text/plain", text: "Postgres body." },
          ],
        },
      ],
    };
  }

  it("atomically audits generic policy visibility transitions", async () => {
    const store = await openStore();
    const input = { org_id: `org-${randomUUID()}`, thread_id: `thread-${randomUUID()}`,
      expected_visibility_version: 0, updated_at: "2026-08-24T00:00:00.000Z" };
    const client = new Client({ connectionString: await isolatedUrl() });
    await client.connect();
    try {
      await client.query(`CREATE FUNCTION reject_generic_policy_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'policy audit unavailable'; END $$`);
      await client.query(`CREATE TRIGGER reject_generic_policy_audit BEFORE INSERT ON conversation_lifecycle_events
        FOR EACH ROW WHEN (NEW.event_type = 'visibility_changed') EXECUTE FUNCTION reject_generic_policy_audit()`);
      try {
        await assert.rejects(store.setConversationPolicyHidden(input), /policy audit unavailable/);
        assert.equal(await store.getConversationPref(input.org_id, input.thread_id), null);
      } finally {
        await client.query("DROP TRIGGER reject_generic_policy_audit ON conversation_lifecycle_events");
        await client.query("DROP FUNCTION reject_generic_policy_audit()");
      }
      assert.equal((await store.setConversationPolicyHidden(input)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyHidden(input), { outcome: "unchanged" });
      assert.equal((await store.setConversationPolicyVisibility({ ...input, hidden: false })).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyVisibility({ ...input, hidden: false }), { outcome: "unchanged" });
      const { rows } = await client.query(`SELECT aggregate_version, dedupe_key, payload_json
        FROM conversation_lifecycle_events WHERE org_id = $1 AND thread_id = $2
          AND event_type = 'visibility_changed' ORDER BY created_at, id`, [input.org_id, input.thread_id]);
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
      assert.deepEqual(rows.map((row) => row.payload_json).sort((a, b) => Number(a.hidden) - Number(b.hidden)), [
        { hidden: false, hidden_reason: null, cause: "policy_visibility_applied" },
        { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" },
      ]);
      assert.deepEqual(rows.map((row) => Number(row.aggregate_version)), [0, 0]);
    } finally {
      await client.end();
    }
  });

  it("rolls back a sync-page tombstone fold if its audit fails", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const installationId = `installation-${randomUUID()}`;
    const eventId = `event-${randomUUID()}`;
    const tombstoneId = `tombstone-${randomUUID()}`;
    const thread = `thread-${randomUUID()}`;
    const now = "2026-08-24T00:00:00.000Z";
    const base = { org_id: orgId, source: "synthetic", external_id: eventId, thread_id: thread,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1, occurred_at: now };
    await store.createInstallation({ id: installationId, org_id: orgId, connector_type: "fake-poll",
      status: "enabled", config: {}, created_at: now });
    await store.append({ ...base, id: eventId, expected_head_id: null });
    const lease = await store.acquireLease({ installation_id: installationId, stream_key: "personal", lease_owner: "worker",
      now, lease_duration_ms: 30_000 });
    const page = {
      attempt: { id: `attempt-${eventId}`, org_id: orgId, connector_installation_id: installationId,
        stream_key: "personal", delivery_id: "fold", started_at: now },
      ingest: { appends: [{ ...base, id: tombstoneId, operation: "tombstone", expected_head_id: eventId }],
        dispositions: [] },
      prefs: [{ org_id: orgId, thread_id: thread, hidden: true, expected_visibility_version: 0,
        updated_at: now, fold_current_tombstone_event_ids: [tombstoneId] }],
      settle: { attempt_id: `attempt-${eventId}`, installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", claim_token: lease.claim_token, finished_at: now,
        accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "fold-cursor", quarantines: [] },
    };
    const client = new Client({ connectionString: await isolatedUrl() });
    await client.connect();
    try {
      await client.query(`CREATE FUNCTION reject_tombstone_fold() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'tombstone audit unavailable'; END $$`);
      await client.query(`CREATE TRIGGER reject_tombstone_fold BEFORE INSERT ON conversation_lifecycle_events
        FOR EACH ROW WHEN (NEW.event_type = 'visibility_changed') EXECUTE FUNCTION reject_tombstone_fold()`);
      try {
        await assert.rejects(store.commitSyncPage(page), /tombstone audit unavailable/);
        assert.equal(await store.getEvent(orgId, tombstoneId), null);
        assert.equal((await store.findBySourceIdentity(base)).id, eventId);
        assert.equal(await store.latestAttempt(installationId), null);
        assert.equal((await store.getCursor(installationId, "personal")).cursor, undefined);
        assert.notEqual((await store.getConversationPref(orgId, thread))?.hidden, true);
      } finally {
        await client.query("DROP TRIGGER reject_tombstone_fold ON conversation_lifecycle_events");
        await client.query("DROP FUNCTION reject_tombstone_fold()");
      }
      assert.equal((await store.commitSyncPage(page)).attempt.status, "succeeded");
      assert.equal((await store.getConversationPref(orgId, thread)).hidden_reason, "policy");
      const { rows } = await client.query(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE org_id = $1 AND thread_id = $2 AND event_type = 'visibility_changed'`, [orgId, thread]);
      assert.deepEqual(rows.map((row) => row.payload_json), [{
        hidden: true, hidden_reason: "policy", cause: "tombstone_visibility_reconciled", event_id: tombstoneId,
      }]);
    } finally {
      await client.end();
    }
  });

  it("rechecks sync-page unfold evidence and repairs a valid legacy preference", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const installationId = `installation-${randomUUID()}`;
    const eventId = `event-${randomUUID()}`;
    const thread = `thread-${randomUUID()}`;
    const now = "2026-08-24T00:00:00.000Z";
    await store.createInstallation({
      id: installationId, org_id: orgId, connector_type: "fake-poll",
      status: "enabled", config: {}, created_at: now,
    });
    await store.commitIngest({
      appends: [{
        id: eventId, org_id: orgId, source: "synthetic", external_id: eventId, thread_id: thread,
        content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      }],
      dispositions: [{
        event_id: eventId, org_id: orgId, disposition: "current_work", layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      }],
    });
    await store.putConversationPref({ org_id: orgId, thread_id: thread, updated_at: now });
    const client = new Client({ connectionString: await isolatedUrl() });
    const guard = {
      org_id: orgId, thread_id: thread, hidden: false, expected_visibility_version: 0,
      updated_at: now, unfold_current_work_event_ids: ["missing", eventId],
    };
    await client.connect();
    try {
      await client.query("UPDATE conversation_prefs SET hidden = TRUE, hidden_reason = 'policy' WHERE org_id = $1 AND thread_id = $2", [orgId, thread]);
      await client.query(`CREATE FUNCTION reject_compatibility_unfold() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reconciliation audit unavailable'; END $$`);
      await client.query(`CREATE TRIGGER reject_compatibility_unfold BEFORE INSERT ON conversation_lifecycle_events
        FOR EACH ROW WHEN (NEW.event_type = 'visibility_changed')
        EXECUTE FUNCTION reject_compatibility_unfold()`);
      try {
        await assert.rejects(store.setConversationPolicyVisibility(guard), /reconciliation audit unavailable/);
        assert.equal((await store.getConversationPref(orgId, thread)).hidden_reason, "policy");
      } finally {
        await client.query("DROP TRIGGER reject_compatibility_unfold ON conversation_lifecycle_events");
        await client.query("DROP FUNCTION reject_compatibility_unfold()");
      }
      assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
      assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
      const { rows } = await client.query(`SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
        WHERE org_id = $1 AND thread_id = $2 AND event_type = 'visibility_changed'`, [orgId, thread]);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].aggregate_version), 0);
      assert.deepEqual(rows[0].payload_json, {
        hidden: false, hidden_reason: null, cause: "current_work_visibility_reconciled", event_id: eventId,
      });
    } finally {
      await client.end();
    }
    const expected = await store.getDisposition(eventId);
    const next = { ...expected, disposition: "outside_current_work" };
    await store.transitionDisposition({
      expected, decision: next,
      command: { org_id: orgId, event_id: eventId, action: "triage",
        disposition: next.disposition, command_id: `close-${eventId}`, issued_at: now },
    });
    await store.setConversationPolicyHidden({
      org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
    });
    const lease = await store.acquireLease({
      installation_id: installationId, stream_key: "personal", lease_owner: "worker",
      now, lease_duration_ms: 30_000,
    });
    await store.commitSyncPage({
      attempt: { id: `attempt-${eventId}`, org_id: orgId, connector_installation_id: installationId,
        stream_key: "personal", delivery_id: "guard", started_at: now },
      prefs: [guard],
      settle: { attempt_id: `attempt-${eventId}`, installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", claim_token: lease.claim_token, finished_at: now,
        accepted_count: 0, duplicate_count: 1,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    });
    assert.equal((await store.getConversationPref(orgId, thread)).hidden_reason, "policy");
  });

  it("migrates, ingests, and lists inbox", async () => {
    const { authority, service, orgId } = await ingestHarness();
    const result = await service.ingest(createBatch(orgId));
    assert.equal(result.valid, true);
    assert.equal(
      result.records.filter((record) => record.status === "accepted").length,
      1,
    );
    const inbox = await authority.listInbox(orgId);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.org_id, orgId);
    const blobs = await authority.findBlobs([inbox[0].event.content_hash]);
    assert.equal(blobs.size, 1);
    await authority.ping();
  });

  it("serializes migration startup within each database schema", async () => {
    await openStore();
    const url = await isolatedUrl();
    const holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array('regenic-authority-migration', current_schema())::text, 0
      ))`);
      const blocked = new URL(url);
      blocked.searchParams.set("options", `${blocked.searchParams.get("options")} -clock_timeout=100ms`);
      await assert.rejects(PostgresAuthorityStore.open(blocked.toString()), (error) => error.code === "55P03");
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    const reopened = await PostgresAuthorityStore.open(url);
    await reopened.close();
  });

  it("repairs stale thread work flags without removing live alias work during migration", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const now = "2026-08-24T00:00:00.000Z";
    const decision = (id) => ({
      event_id: id, org_id: orgId, disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    });
    const base = (id, thread) => ({
      id, org_id: orgId, source: "synthetic", external_id: id, thread_id: thread,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: now, expected_head_id: null,
    });
    const stale = base(`stale-${randomUUID()}`, "migration-stale");
    const aliased = base(`aliased-${randomUUID()}`, "migration-aliased");
    for (const event of [stale, aliased]) {
      await store.commitIngest({ appends: [event], dispositions: [decision(event.id)] });
    }
    await store.bindSourceIdentityAliases({
      org_id: orgId, event_id: aliased.id,
      aliases: [{ source: "synthetic", external_id: `alias-${randomUUID()}` }],
    });
    for (const event of [stale, aliased]) {
      const deleted = `${event.id}-deleted`;
      await store.markTombstone({
        id: deleted, org_id: orgId, source: event.source, external_id: event.external_id,
        thread_id: event.thread_id, expected_head_id: event.id, occurred_at: now,
        disposition: decision(deleted),
      });
    }
    const client = new Client({ connectionString: await isolatedUrl() });
    const writer = new Client({ connectionString: await isolatedUrl() });
    await client.connect();
    await writer.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE thread_heads SET has_current_work = TRUE WHERE org_id = $1", [orgId]);
      await client.query(PG_MIGRATIONS.find((migration) => migration.version === 70).sql);
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        writer.query("UPDATE events SET occurred_at = occurred_at WHERE id = $1", [stale.id]),
        (error) => error.code === "55P03",
      );
      const { rows } = await client.query(
        "SELECT thread_id, has_current_work FROM thread_heads WHERE org_id = $1 ORDER BY thread_id", [orgId],
      );
      assert.deepEqual(rows, [
        { thread_id: "migration-aliased", has_current_work: true },
        { thread_id: "migration-stale", has_current_work: false },
      ]);
    } finally {
      try {
        await writer.query("ROLLBACK");
        await writer.end();
      } finally {
        await client.query("ROLLBACK");
        await client.end();
      }
    }
  });

  it("audits the persisted disposition including its version on ingestion", async () => {
    const { authority, service, orgId } = await ingestHarness();
    const batch = createBatch(orgId, `task-${randomUUID()}`);
    batch.records[0].type = "task";
    const thread = `regenic:${batch.records[0].external_id}`;
    await authority.setConversationPolicyHidden({
      org_id: orgId, thread_id: thread, expected_visibility_version: 0,
      updated_at: "2026-08-24T00:00:00.000Z",
    });
    const result = await service.ingest(batch);
    const eventId = result.records[0].event_id;
    const decision = await authority.getDisposition(eventId);
    assert.equal(decision.disposition, "current_work");
    const client = new Client({ connectionString: await isolatedUrl() });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT payload_json FROM conversation_lifecycle_events
         WHERE org_id = $1 AND aggregate_id = $2 AND event_type = 'current_work_changed'`,
        [orgId, eventId],
      );
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].payload_json.result, decision);
      const visibility = await client.query(
        `SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
         WHERE org_id = $1 AND thread_id = $2 AND event_type = 'visibility_changed'
           AND payload_json->>'cause' = 'current_work_ingested'`,
        [orgId, thread],
      );
      assert.equal(Number(visibility.rows[0].aggregate_version), 0);
      assert.deepEqual(visibility.rows[0].payload_json, {
        hidden: false, hidden_reason: null, cause: "current_work_ingested", event_id: eventId,
      });
    } finally {
      await client.end();
    }
  });

  it("audits policy unfolding when a current-head disposition becomes work", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const now = "2026-08-24T00:00:00.000Z";
    const client = new Client({ connectionString: await isolatedUrl() });
    await client.connect();
    try {
      for (const mode of ["transition", "restore"]) {
        const id = `event-${randomUUID()}`;
        const thread = `thread-${randomUUID()}`;
        await store.append({
          id, org_id: orgId, source: "synthetic", external_id: id, thread_id: thread,
          content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        });
        const initial = {
          event_id: id, org_id: orgId, disposition: "outside_current_work", layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        };
        if (mode === "transition") await store.putDispositionIfAbsent(initial);
        await store.setConversationPolicyHidden({
          org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
        });
        const decision = { ...initial, disposition: "current_work" };
        if (mode === "transition") {
          await store.transitionDisposition({
            expected: await store.getDisposition(id), decision,
            command: {
              org_id: orgId, event_id: id, action: "triage", disposition: "current_work",
              command_id: `command-${id}`, issued_at: now,
            },
          });
        } else {
          await store.putDispositionIfAbsent(decision);
        }
        assert.equal((await store.getConversationPref(orgId, thread)).hidden, false);
        const { rows } = await client.query(
          `SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
           WHERE org_id = $1 AND thread_id = $2 AND event_type = 'visibility_changed'
             AND payload_json->>'cause' = $3`,
          [orgId, thread, `current_work_disposition_${mode === "transition" ? "changed" : "restored"}`],
        );
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].aggregate_version), 0);
        assert.deepEqual(rows[0].payload_json, {
          hidden: false, hidden_reason: null,
          cause: `current_work_disposition_${mode === "transition" ? "changed" : "restored"}`,
          event_id: id,
        });
      }
    } finally {
      await client.end();
    }
  });

  it("stores immutable snapshot index entries with isolated stable queries", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const base = {
      org_id: orgId,
      thread_id: "thread-1",
      snapshot_id: "snapshot-old",
      principal: { actor_type: "human", actor_id: "person-1" },
      consumer_id: "desktop-context-pilot",
      purpose: "display context",
      allowed_uses: ["display"],
      created_at: "2026-08-30T00:00:00.000Z",
    };
    const newer = {
      ...base,
      snapshot_id: "snapshot-new",
      created_at: "2026-08-30T01:00:00.000Z",
    };
    await store.putSnapshotIndex(base);
    await Promise.all([
      store.putSnapshotIndex(newer),
      store.putSnapshotIndex(newer),
    ]);
    const query = {
      org_id: orgId,
      thread_id: "thread-1",
      principal: base.principal,
      consumer_id: base.consumer_id,
    };
    assert.deepEqual(
      (await store.listSnapshotIndex(query)).map(({ snapshot_id }) => snapshot_id),
      ["snapshot-new", "snapshot-old"],
    );
    assert.deepEqual(
      (await store.listSnapshotIndex({ ...query, limit: 1 })).map(({ snapshot_id }) => snapshot_id),
      ["snapshot-new"],
    );
    assert.deepEqual(await store.listSnapshotIndex({ ...query, thread_id: "thread-2" }), []);
    await assert.rejects(
      store.putSnapshotIndex({ ...newer, purpose: "changed purpose" }),
      /Cannot replace immutable context snapshot index entry/,
    );
  });

  it("rolls back a conflicting ingest page", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const first = await store.append({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-1",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    });
    await assert.rejects(
      () =>
        store.commitIngest({
          appends: [
            {
              org_id: orgId,
              source: "regenic",
              external_id: "conflict-2",
              content_hash: "b".repeat(64),
              content_media_type: "text/plain",
              content_byte_size: 1,
              occurred_at: "2026-08-24T00:00:01.000Z",
              expected_head_id: null,
            },
            {
              org_id: orgId,
              source: "regenic",
              external_id: "conflict-1",
              content_hash: "c".repeat(64),
              content_media_type: "text/plain",
              content_byte_size: 1,
              occurred_at: "2026-08-24T00:00:02.000Z",
              expected_head_id: null,
            },
          ],
          dispositions: [],
        }),
      (error) => error instanceof AuthorityConflictError,
    );
    assert.equal(await store.findBySourceIdentity({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-2",
    }), null);
    const head = await store.findBySourceIdentity({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-1",
    });
    assert.equal(head.id, first.id);
  });

  it("converges concurrent identical Decision commits", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const proposal = {
      schema_version: "1.0", id: `proposal-${randomUUID()}`, org_id: orgId,
      kind: "decision", title: "Approve release", summary: "Approve the bounded release.",
      status: "draft", author: { actor_type: "human", actor_id: "person-1" },
      rights_level: "coach", boundary: "Release decision only",
      context_snapshot_id: "snapshot-1", standard_bindings: [],
      evidence: [{ kind: "document", uri_or_ref: "event:event-1" }],
      created_at: "2026-09-15T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z",
    };
    await writerA.putProposal(proposal);
    await writerA.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "submitted", updated_at: "2026-09-15T01:00:00.000Z" });
    await writerA.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "in_review", updated_at: "2026-09-15T02:00:00.000Z" });
    const decision = {
      schema_version: "1.0", id: `decision-${randomUUID()}`, org_id: orgId,
      proposal_id: proposal.id, summary: "Proceed with the release.",
      rationale: "The pinned evidence supports the bounded release.",
      decided_by: proposal.author, co_deciders: [], rights_level: "coach",
      context_snapshot_id: proposal.context_snapshot_id, standard_bindings: [],
      status: "committed", committed_at: "2026-09-15T03:00:00.000Z",
    };
    const [committedA, committedB] = await Promise.all([
      writerA.commitProposalDecision({ org_id: orgId, proposal_id: proposal.id, decision }),
      writerB.commitProposalDecision({ org_id: orgId, proposal_id: proposal.id, decision }),
    ]);
    assert.equal(committedA.decision.id, decision.id);
    assert.equal(committedB.decision.id, decision.id);
    assert.equal(committedB.proposal.status, "accepted");
  });

  it("does not let two claimers take the same projection job", async () => {
    const writer = await openStore();
    const orgId = `org-${randomUUID()}`;
    await writer.append({
      org_id: orgId,
      source: "regenic",
      external_id: `job-${randomUUID()}`,
      content_hash: "d".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    });
    const now = new Date().toISOString();
    const claimerA = await openStore();
    const claimerB = await openStore();
    const [first, second] = await Promise.all([
      claimerA.claimContextProjectionJobs({
        owner: "worker-a",
        now,
        lease_ms: 60_000,
        limit: 100,
      }),
      claimerB.claimContextProjectionJobs({
        owner: "worker-b",
        now,
        lease_ms: 60_000,
        limit: 100,
      }),
    ]);
    const ids = [...first, ...second].filter((job) => job.org_id === orgId).map((job) => job.id);
    assert.equal(ids.length, 1);
    assert.equal(new Set(ids).size, 1);
  });

  it("persists idempotent Handoffs and transitions them under row lock", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const handoff = {
      schema_version: "1.0", id: `handoff-${randomUUID()}`, org_id: orgId,
      direction: "human_to_agent",
      from: { actor_type: "human", actor_id: "person-1" },
      to: { actor_type: "agent", actor_id: "agent-1" },
      reason: "set_boundary", context_snapshot_id: "snapshot-1",
      standard_bindings: [], payload: { boundary: "Release only" },
      status: "open", created_at: "2026-09-17T00:00:00.000Z",
    };
    const [first, repeated] = await Promise.all([
      writerA.putHandoff(handoff),
      writerB.putHandoff({ ...handoff, created_at: "2026-09-17T00:00:01.000Z" }),
    ]);
    assert.equal(first.id, repeated.id);
    assert.equal(first.created_at, repeated.created_at);
    await assert.rejects(
      writerB.putHandoff({ ...handoff, payload: { boundary: "Changed" } }),
      /Cannot replace immutable Handoff/,
    );
    assert.equal((await writerA.transitionHandoff({
      org_id: orgId, handoff_id: handoff.id, status: "acked",
      transitioned_at: "2026-09-17T01:00:00.000Z",
    })).status, "acked");
    const resolved = await writerB.transitionHandoff({
      org_id: orgId, handoff_id: handoff.id, status: "resolved",
      transitioned_at: "2026-09-17T02:00:00.000Z",
    });
    assert.equal(resolved.resolved_at, "2026-09-17T02:00:00.000Z");
    assert.equal((await writerA.listHandoffs({
      org_id: orgId, status: "resolved", direction: "human_to_agent",
    })).length, 1);
  });

  it("atomically commits and promotes a Standard Proposal", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const proposal = {
      schema_version: "1.0", id: `proposal-${randomUUID()}`, org_id: orgId,
      kind: "new_standard", title: "Create release safety standard",
      summary: "Create a bounded release safety standard.", status: "draft",
      author: { actor_type: "human", actor_id: "person-1" }, rights_level: "coach",
      boundary: "Release governance only", context_snapshot_id: "snapshot-1",
      standard_bindings: [], single_uncertainty: "Can this prevent regressions?",
      evidence: [{ kind: "document", uri_or_ref: "event:event-1" }],
      created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z",
    };
    const standard = {
      schema_version: "1.0", id: `standard-${randomUUID()}`, org_id: orgId,
      slug: `release-safety-${randomUUID()}`, title: "Release safety", layer: "adjacent",
      scope: { org_id: orgId, team_ids: [], roles: [], decision_kinds: ["release"] },
      created_at: "2026-09-18T03:00:00.000Z", created_by: proposal.author,
      citation_count: 0,
    };
    const body = {
      condition: "A release changes production behavior.",
      action: "Run the bounded release check.",
      acceptance: "No severe regression escapes.",
      boundary: "Escalate when rollback is unavailable.",
      revision_trigger: "A severe regression escapes.",
    };
    const version = {
      schema_version: "1.0", id: `standard-version-${randomUUID()}`, org_id: orgId,
      standard_id: standard.id, proposal_id: proposal.id, version: "1.0.0", status: "draft",
      ...body,
      gate: {
        single_uncertainty: proposal.single_uncertainty, target_user_tier: "early_adopter",
        consensus_hypothesis: "Teams need a bounded release check.",
        value_metric: "Escaped regressions", cost_budget: "Two engineer-days",
        validation_window: "14 days", stop_condition: "Stop after one severe regression.",
        stable_core_preserved: true, compat_and_rollback: "Keep the previous path.",
        learning_output: "new_standard",
      },
      body_hash: hashStandardVersionBody(body), created_at: "2026-09-18T03:00:00.000Z",
    };
    await store.putProposal(proposal);
    await store.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "submitted", updated_at: "2026-09-18T01:00:00.000Z" });
    await store.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "in_review", updated_at: "2026-09-18T02:00:00.000Z" });
    const committed = await store.commitProposalStandardVersion({ org_id: orgId, proposal_id: proposal.id, standard, version });
    assert.equal(committed.proposal.status, "accepted");
    assert.deepEqual(committed.proposal.outcome_ref, { outcome_kind: "standard_version", ref_id: version.id });
    const active = await store.transitionStandardVersion({
      org_id: orgId, version_id: version.id, status: "active", actor: proposal.author,
      transitioned_at: "2026-09-19T00:00:00.000Z",
      upgrade_evidence: {
        core_value_revalidated: true, delivery_standardized: true,
        unit_economics_or_roi_ok: true, next_tier_behavioral_evidence: true,
        rollback_safe: true,
      },
    });
    assert.equal(active.status, "active");
    assert.equal((await store.getStandard(orgId, standard.id)).current_version_id, version.id);
    assert.equal((await store.listStandardVersions({ org_id: orgId, standard_id: standard.id })).length, 1);
    const run = {
      schema_version: "1.0", id: `run-${randomUUID()}`, org_id: orgId,
      agent: { actor_type: "agent", actor_id: "agent-1" },
      intent: "Apply the release standard.", status: "queued",
      context_snapshot_id: "snapshot-usage-1",
      standard_bindings: [{ standard_id: standard.id, version_id: version.id }],
      input: { release_id: "release-1" }, created_at: "2026-09-20T00:00:00.000Z",
    };
    const secondStore = await openStore();
    const secondRun = { ...run, id: `run-${randomUUID()}`, input: { release_id: "release-2" } };
    await store.putAgentRun(run);
    await secondStore.putAgentRun(secondRun);
    const [firstUsage, secondUsage] = await Promise.all([
      store.projectStandardUsage({ org_id: orgId, source_kind: "agent_run", source_id: run.id }),
      secondStore.projectStandardUsage({ org_id: orgId, source_kind: "agent_run", source_id: secondRun.id }),
    ]);
    assert.equal(firstUsage[0].version_id, version.id);
    assert.equal(secondUsage[0].version_id, version.id);
    assert.equal((await store.projectStandardUsage({
      org_id: orgId, source_kind: "agent_run", source_id: run.id,
    })).length, 1);
    assert.equal((await store.listStandardUsage({
      org_id: orgId, standard_id: standard.id, version_id: version.id,
    })).length, 2);
    assert.equal(await store.countStandardUsage({
      org_id: orgId, standard_id: standard.id,
    }), 2);
    assert.equal(await store.countStandardUsage({
      org_id: orgId, standard_id: standard.id, version_id: version.id,
    }), 2);
    assert.equal((await store.getStandard(orgId, standard.id)).citation_count, 2);
  });

  it("converges concurrent StandardGap intake and Proposal conversion", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const baseGap = {
      schema_version: "1.0", org_id: orgId,
      summary: "Release safety is not covered.", source_kind: "manual", source_ref: "manual-gap-1",
      proposed_uncertainty: "Can a release gate prevent regressions?", status: "open",
      created_by: { actor_type: "human", actor_id: "person-1" },
    };
    const [gapA, gapB] = await Promise.all([
      writerA.putStandardGap({
        ...baseGap, id: `gap-${randomUUID()}`,
        created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
      }),
      writerB.putStandardGap({
        ...baseGap, id: `gap-${randomUUID()}`,
        created_at: "2026-09-20T00:00:01.000Z", updated_at: "2026-09-20T00:00:01.000Z",
      }),
    ]);
    assert.equal(gapA.id, gapB.id);
    const proposal = {
      schema_version: "1.0", id: `proposal-${randomUUID()}`, org_id: orgId,
      kind: "new_standard", title: "Create release safety standard",
      summary: "Create a bounded release safety standard.", status: "draft",
      author: baseGap.created_by, rights_level: "coach", boundary: "Release governance only",
      context_snapshot_id: "snapshot-1", standard_bindings: [],
      single_uncertainty: baseGap.proposed_uncertainty,
      evidence: [{ kind: "document", uri_or_ref: `standard-gap:${gapA.id}` }], gap_id: gapA.id,
      created_at: "2026-09-20T01:00:00.000Z", updated_at: "2026-09-20T01:00:00.000Z",
    };
    const [convertedA, convertedB] = await Promise.all([
      writerA.convertStandardGap({ org_id: orgId, gap_id: gapA.id, proposal }),
      writerB.convertStandardGap({
        org_id: orgId, gap_id: gapA.id,
        proposal: { ...proposal, created_at: "2026-09-20T01:00:01.000Z", updated_at: "2026-09-20T01:00:01.000Z" },
      }),
    ]);
    assert.equal(convertedA.gap.converted_proposal_id, proposal.id);
    assert.equal(convertedB.proposal.id, proposal.id);
    assert.equal((await writerA.listStandardGaps({ org_id: orgId, status: "converted" })).length, 1);
  });

  it("serializes AgentRun transitions and commits Handoff atomically", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const run = {
      schema_version: "1.0", id: `run-${randomUUID()}`, org_id: orgId,
      agent: { actor_type: "agent", actor_id: "agent-1" },
      on_behalf_of: { actor_type: "human", actor_id: "person-1" },
      intent: "Apply the release standard.", status: "queued",
      context_snapshot_id: "snapshot-1",
      standard_bindings: [{ standard_id: "standard-1", version_id: "version-1" }],
      input: { release_id: "release-1" }, created_at: "2026-09-21T00:00:00.000Z",
    };
    await writerA.putAgentRun(run);
    const [startedA, startedB] = await Promise.all([
      writerA.startAgentRun({ org_id: orgId, run_id: run.id, started_at: "2026-09-21T01:00:00.000Z" }),
      writerB.startAgentRun({ org_id: orgId, run_id: run.id, started_at: "2026-09-21T01:01:00.000Z" }),
    ]);
    assert.equal(startedA.status, "running");
    assert.equal(startedB.started_at, startedA.started_at);
    const output = {
      summary: "The release check passed.", artifacts: [],
      applied_standard_version_ids: ["version-1"], context_snapshot_id: "snapshot-1",
      acceptance_check: "pass", exceptions: [],
    };
    assert.equal((await writerA.settleAgentRun({
      org_id: orgId, run_id: run.id, status: "succeeded", output,
      finished_at: "2026-09-21T02:00:00.000Z",
    })).status, "succeeded");
    assert.equal((await writerB.settleAgentRun({
      org_id: orgId, run_id: run.id, status: "succeeded", output,
      finished_at: "2026-09-21T02:01:00.000Z",
    })).finished_at, "2026-09-21T02:00:00.000Z");

    const handoffRun = { ...run, id: `run-${randomUUID()}`, input: { release_id: "release-2" } };
    await writerA.putAgentRun(handoffRun);
    await writerA.startAgentRun({ org_id: orgId, run_id: handoffRun.id, started_at: "2026-09-21T01:00:00.000Z" });
    const handoff = {
      schema_version: "1.0", id: `handoff-${randomUUID()}`, org_id: orgId,
      direction: "agent_to_human", from: handoffRun.agent,
      to: { actor_type: "human", actor_id: "person-1" }, reason: "evidence_conflict",
      agent_run_id: handoffRun.id, context_snapshot_id: handoffRun.context_snapshot_id,
      standard_bindings: handoffRun.standard_bindings,
      payload: { summary: "Two claims disagree." }, status: "open",
      created_at: "2026-09-21T02:00:00.000Z",
    };
    const handedOff = await writerB.handoffAgentRun({
      org_id: orgId, run_id: handoffRun.id, handoff, handed_off_at: handoff.created_at,
    });
    assert.equal(handedOff.run.status, "handed_off");
    assert.equal((await writerA.getHandoff(orgId, handoff.id)).agent_run_id, handoffRun.id);
  });

  it("serves the store through the postgres plugin", async () => {
    const host = await createHost();
    try {
      const handle = await host.plugin(postgresAuthorityPlugin, {
        connectionString: await isolatedUrl(),
      });
      await handle.ready();
      const store = host.get("authority");
      const orgId = `org-${randomUUID()}`;
      const event = await store.append({
        org_id: orgId,
        source: "regenic",
        external_id: "plugin-1",
        content_hash: "e".repeat(64),
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-24T00:00:00.000Z",
        expected_head_id: null,
      });
      assert.equal((await store.getEvent(orgId, event.id))?.id, event.id);
    } finally {
      await host.dispose();
    }
  });

  it("replaces the outbox index with partial claim indexes", async () => {
    const connectionString = await isolatedPostgresUrl(baseConnectionString);
    const setup = new Client({ connectionString });
    await setup.connect();
    try {
      await setup.query(PG_BASELINE_SQL);
      await setup.query(`
        DROP INDEX context_projection_outbox_pending_idx;
        DROP INDEX context_projection_outbox_failed_due_idx;
        DROP INDEX context_projection_outbox_running_expired_idx;
        CREATE INDEX context_projection_outbox_due_idx
          ON context_projection_outbox (status, next_retry_at, lease_expires_at, created_at);
      `);
      await setup.query(PG_MIGRATIONS.find((migration) => migration.version === 24).sql);
    } finally {
      await setup.end();
    }

    const check = new Client({ connectionString });
    await check.connect();
    try {
      const indexes = await check.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'context_projection_outbox'
         ORDER BY indexname`,
      );
      const names = indexes.rows.map((row) => row.indexname);
      assert.equal(names.includes("context_projection_outbox_due_idx"), false);
      assert.equal(names.includes("context_projection_outbox_pending_idx"), true);
      assert.equal(names.includes("context_projection_outbox_failed_due_idx"), true);
      assert.equal(
        names.includes("context_projection_outbox_running_expired_idx"),
        true,
      );
    } finally {
      await check.end();
    }
  });
});
