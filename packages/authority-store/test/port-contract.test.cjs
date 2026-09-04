const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  hashContextSnapshot,
} = require("@regenic/domain");
const { FsBlobStore } = require("@regenic/blob-store");
const { createHost } = require("@regenic/plugin-host");
const { sqliteAuthorityPlugin } = require("../dist/sqlite");
const { postgresAuthorityPlugin } = require("../dist/postgres");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const KEEP = 64;

const drivers = [
  {
    name: "sqlite",
    async setup() {
      const root = await mkdtemp(join(tmpdir(), "regenic-port-sqlite-"));
      return {
        plugin: sqliteAuthorityPlugin,
        config: { path: join(root, "authority.db") },
        blobRoot: join(root, "blobs"),
        async teardown() {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

if (process.env.TEST_DATABASE_URL?.trim()) {
  drivers.push({
    name: "postgres",
    async setup() {
      const root = await mkdtemp(join(tmpdir(), "regenic-port-pg-"));
      return {
        plugin: postgresAuthorityPlugin,
        config: { connectionString: process.env.TEST_DATABASE_URL.trim() },
        blobRoot: join(root, "blobs"),
        async teardown() {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
}

function createBatch(orgId, externalId) {
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
          { role: "body", media_type: "text/plain", text: "Port contract body." },
        ],
      },
    ],
  };
}

function snapshotFor(orgId) {
  const value = {
    schema_version: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: "pending",
    org_id: orgId,
    request_hash: HASH_A,
    principal_policy_hash: HASH_B,
    read_epoch: "authority:42",
    retrieval_profile_version: "deterministic-v1",
    assembly_profile_version: "event-evidence-v1",
    bundle_payload_hash: HASH_A,
    selected: [
      {
        candidate_id: "event:event-1",
        resource_id: "event-1",
        kind: "event",
        content_hash: HASH_A,
      },
    ],
    budget_ledger: {
      profile: "test",
      max_tokens: 10,
      max_items: 1,
      max_raw_evidence: 1,
      requested_tokens: 1,
      selected_tokens: 1,
      reserved_tokens: 0,
      selected_items: 1,
      truncated_items: 0,
      sections: [
        {
          kind: "evidence",
          requested_tokens: 1,
          selected_tokens: 1,
          reserved_tokens: 0,
          selected_items: 1,
          truncated_items: 0,
        },
      ],
    },
    degradation_flags: ["model_absent"],
    content_hash: "",
    created_at: "2026-08-30T00:02:00.000Z",
  };
  value.content_hash = hashContextSnapshot(value);
  value.id = `context-snapshot:${value.content_hash}`;
  return value;
}

for (const driver of drivers) {
  describe(`${driver.name} authority port contract`, () => {
    const teardowns = [];

    after(async () => {
      for (const fn of teardowns.splice(0).reverse()) {
        await fn();
      }
    });

    async function openBoundStore() {
      const binding = await driver.setup();
      teardowns.push(binding.teardown);
      const host = await createHost();
      const handle = await host.plugin(binding.plugin, binding.config);
      await handle.ready();
      teardowns.push(() => host.dispose());
      return {
        store: host.get("authority"),
        blobs: new FsBlobStore(binding.blobRoot),
        orgId: `org-${randomUUID()}`,
      };
    }

    it("commits an ingest page and lists inbox", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const service = new IngestionService(blobs, store);
      const result = await service.ingest(createBatch(orgId, "page-1"));
      assert.equal(result.valid, true);
      assert.equal(
        result.records.filter((record) => record.status === "accepted").length,
        1,
      );
      const inbox = await store.listInbox(orgId);
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].event.org_id, orgId);
    });

    it("rolls back a conflicting ingest page", async () => {
      const { store, orgId } = await openBoundStore();
      const first = await store.append({
        org_id: orgId,
        source: "regenic",
        external_id: "conflict-1",
        content_hash: HASH_A,
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
                content_hash: HASH_B,
                content_media_type: "text/plain",
                content_byte_size: 1,
                occurred_at: "2026-08-24T00:00:01.000Z",
                expected_head_id: null,
              },
              {
                org_id: orgId,
                source: "regenic",
                external_id: "conflict-1",
                content_hash: HASH_C,
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
      assert.equal(
        await store.findBySourceIdentity({
          org_id: orgId,
          source: "regenic",
          external_id: "conflict-2",
        }),
        null,
      );
      assert.equal(
        (
          await store.findBySourceIdentity({
            org_id: orgId,
            source: "regenic",
            external_id: "conflict-1",
          })
        ).id,
        first.id,
      );
    });

    it("acquires and releases a connector lease atomically", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId,
        org_id: orgId,
        connector_type: "fake-poll",
        status: "enabled",
        config: { scope: "personal" },
        created_at: "2026-08-12T00:00:00.000Z",
      });
      const first = await store.acquireLease({
        installation_id: installationId,
        stream_key: "personal",
        lease_owner: "worker-a",
        now: "2026-08-12T00:00:00.000Z",
        lease_duration_ms: 30_000,
      });
      assert.equal(first.lease_owner, "worker-a");
      assert.equal(
        await store.acquireLease({
          installation_id: installationId,
          stream_key: "personal",
          lease_owner: "worker-b",
          now: "2026-08-12T00:00:01.000Z",
          lease_duration_ms: 30_000,
        }),
        null,
      );
      assert.equal(
        await store.releaseLease({
          installation_id: installationId,
          stream_key: "personal",
          lease_owner: "worker-a",
          now: "2026-08-12T00:00:02.000Z",
        }),
        true,
      );
      const second = await store.acquireLease({
        installation_id: installationId,
        stream_key: "personal",
        lease_owner: "worker-b",
        now: "2026-08-12T00:00:03.000Z",
        lease_duration_ms: 30_000,
      });
      assert.equal(second.lease_owner, "worker-b");
    });

    it("claims, fails, retries, and completes a projection job", async () => {
      const { store, orgId } = await openBoundStore();
      await store.append({
        org_id: orgId,
        source: "synthetic",
        external_id: `outbox-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      const [claimed] = await store.claimContextProjectionJobs({
        owner: "worker-1",
        now: "2026-08-30T00:01:00.000Z",
        lease_ms: 60_000,
        limit: 50,
      });
      assert.equal(claimed.org_id, orgId);
      assert.equal(claimed.attempts, 1);
      assert.equal(
        (
          await store.claimContextProjectionJobs({
            owner: "worker-2",
            now: "2026-08-30T00:01:30.000Z",
            lease_ms: 60_000,
            limit: 50,
          })
        ).some((job) => job.id === claimed.id),
        false,
      );
      assert.equal(
        await store.completeContextProjectionJob({
          id: claimed.id,
          owner: "worker-2",
          completed_at: "2026-08-30T00:01:30.000Z",
        }),
        false,
      );
      assert.equal(
        await store.failContextProjectionJob({
          id: claimed.id,
          owner: "worker-1",
          failed_at: "2026-08-30T00:01:40.000Z",
          next_retry_at: "2026-08-30T00:02:00.000Z",
          error_code: "projection_failed",
        }),
        true,
      );
      const [retried] = (
        await store.claimContextProjectionJobs({
          owner: "worker-2",
          now: "2026-08-30T00:02:00.000Z",
          lease_ms: 60_000,
          limit: 50,
        })
      ).filter((job) => job.id === claimed.id);
      assert.equal(retried.attempts, 2);
      assert.equal(
        await store.completeContextProjectionJob({
          id: retried.id,
          owner: "worker-2",
          completed_at: "2026-08-30T00:02:01.000Z",
        }),
        true,
      );
      assert.equal(
        (await store.listContextProjectionJobs(orgId)).find(
          (job) => job.id === claimed.id,
        ).status,
        "succeeded",
      );
    });

    it("opens a repeatable context read and stores an immutable snapshot", async () => {
      const { store, orgId } = await openBoundStore();
      const event = await store.append({
        org_id: orgId,
        source: "synthetic",
        external_id: `read-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      const read = await store.openContextRead(orgId);
      assert.equal(read.events.some((item) => item.id === event.id), true);
      assert.ok(read.read_epoch.startsWith("authority:"));
      const snapshot = snapshotFor(orgId);
      await store.putSnapshot(snapshot);
      assert.deepEqual(await store.getSnapshot(orgId, snapshot.id), snapshot);
    });

    it("prunes extra ingest attempts per installation", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId,
        org_id: orgId,
        connector_type: "fake-poll",
        status: "enabled",
        config: {},
        created_at: "2026-08-12T00:00:00.000Z",
      });
      for (let index = 0; index < KEEP + 6; index += 1) {
        const started = new Date(Date.parse("2026-08-12T00:00:00.000Z") + index * 1000)
          .toISOString();
        await store.beginAttempt({
          id: `${installationId}-attempt-${index}`,
          org_id: orgId,
          connector_installation_id: installationId,
          stream_key: "personal",
          delivery_id: `page-${index}`,
          started_at: started,
        });
      }
      const pruned = await store.maintainStore();
      assert.ok(pruned.deleted >= 6);
      const remaining = await store.listAttempts(installationId, KEEP + 10);
      assert.equal(remaining.length, KEEP);
    });
  });
}

const describePg = process.env.TEST_DATABASE_URL?.trim() ? describe : describe.skip;

describePg("postgres concurrent claim", () => {
  it("does not let two claimers take the same projection job", async () => {
    const connectionString = process.env.TEST_DATABASE_URL.trim();
    const hostA = await createHost();
    const hostB = await createHost();
    const hostWriter = await createHost();
    try {
      await (await hostWriter.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      await (await hostA.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      await (await hostB.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      const writer = hostWriter.get("authority");
      const orgId = `org-${randomUUID()}`;
      await writer.append({
        org_id: orgId,
        source: "regenic",
        external_id: `job-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-24T00:00:00.000Z",
        expected_head_id: null,
      });
      const now = new Date().toISOString();
      const [first, second] = await Promise.all([
        hostA.get("authority").claimContextProjectionJobs({
          owner: "worker-a",
          now,
          lease_ms: 60_000,
          limit: 10_000,
        }),
        hostB.get("authority").claimContextProjectionJobs({
          owner: "worker-b",
          now,
          lease_ms: 60_000,
          limit: 10_000,
        }),
      ]);
      const ids = [...first, ...second]
        .filter((job) => job.org_id === orgId)
        .map((job) => job.id);
      assert.equal(ids.length, 1);
      assert.equal(new Set(ids).size, 1);
    } finally {
      await Promise.all([hostA.dispose(), hostB.dispose(), hostWriter.dispose()]);
    }
  });
});
