const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  INGEST_SCHEMA_VERSION,
  IngestionService,
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

const baseConnectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = baseConnectionString ? describe : describe.skip;

async function isolatedPostgresUrl(base) {
  const schema = `s${randomUUID().replaceAll("-", "")}`;
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
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  async function openStore() {
    const store = await PostgresAuthorityStore.open(await isolatedUrl());
    stores.push(store);
    return store;
  }

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

  it("upgrades v23 outbox indexes to partial claim indexes", async () => {
    const connectionString = await isolatedPostgresUrl(baseConnectionString);
    const setup = new Client({ connectionString });
    await setup.connect();
    try {
      await setup.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO schema_migrations (version, applied_at) VALUES (23, now());
        CREATE TABLE context_projection_outbox (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          next_retry_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX context_projection_outbox_due_idx
          ON context_projection_outbox (status, next_retry_at, lease_expires_at, created_at);
      `);
    } finally {
      await setup.end();
    }

    const store = await PostgresAuthorityStore.open(connectionString);
    stores.push(store);

    const check = new Client({ connectionString });
    await check.connect();
    try {
      const versions = await check.query(
        `SELECT version FROM schema_migrations ORDER BY version`,
      );
      assert.deepEqual(
        versions.rows.map((row) => Number(row.version)),
        [23, 24],
      );
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
