const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, afterEach, describe, it } = require("node:test");
const { Client } = require("pg");
const {
  SqliteAuthorityStore,
  SqliteSplitAuthorityStore,
} = require("../dist/sqlite");
const { PostgresAuthorityStore } = require("../dist/postgres");

const roots = [];
const installation = {
  id: "installation-1",
  org_id: "local-owner",
  connector_type: "fake-poll",
  status: "enabled",
  config: {},
  created_at: "2026-09-21T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-sync-work-"));
  roots.push(root);
  return root;
}

async function seedInstallation(store) {
  await store.createInstallation(installation);
}

async function seedRun(store, extras = {}) {
  await store.createSyncRun({
    id: extras.id ?? "run-1",
    org_id: installation.org_id,
    installation_id: installation.id,
    mode: extras.mode ?? "quick_start",
    now: extras.now ?? "2026-09-21T00:00:00.000Z",
  });
}

async function seedWork(store, extras = {}) {
  return store.enqueueSyncWork({
    id: extras.id ?? "work-1",
    run_id: extras.run_id ?? "run-1",
    installation_id: installation.id,
    stream_key: extras.stream_key ?? "s-live",
    lane: extras.lane ?? "live",
    next_due_at: extras.next_due_at ?? "2026-09-21T00:00:00.000Z",
    generation: extras.generation ?? 1,
    now: extras.now ?? "2026-09-21T00:00:00.000Z",
  });
}

describe("SQLite durable sync work", () => {
  it("claims by priority, completes a run, and survives restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    let store = new SqliteAuthorityStore(path);
    await seedInstallation(store);
    await seedRun(store);
    await seedWork(store, { id: "history-1", stream_key: "s-history", lane: "history" });
    await seedWork(store, { id: "live-1", stream_key: "s-live", lane: "live" });

    const claimed = await store.claimSyncWork({
      owner: "worker-a",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 30_000,
      limit: 2,
    });
    assert.deepEqual(
      claimed.map((work) => work.lane),
      ["live", "history"],
    );
    for (const work of claimed) {
      await store.settleSyncWork({
        id: work.id,
        owner: "worker-a",
        now: "2026-09-21T00:00:02.000Z",
        outcome: "succeeded",
        accepted_count: 2,
      });
    }
    store.close();

    store = new SqliteAuthorityStore(path);
    const run = await store.getSyncRun("run-1", installation.org_id);
    assert.equal(run.status, "succeeded");
    assert.equal(run.total_work, 2);
    assert.equal(run.completed_work, 2);
    assert.equal(run.accepted_count, 4);
    store.close();
  });

  it("reclaims expired work and respects pause and cancel", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await seedRun(store, { mode: "archive" });
    await seedWork(store, { stream_key: "s1", lane: "history" });
    await store.claimSyncWork({
      owner: "worker-a",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 1,
    });
    await store.commandSyncRun({
      id: "run-1",
      org_id: installation.org_id,
      command: "pause",
      now: "2026-09-21T00:00:02.000Z",
    });
    assert.deepEqual(
      await store.claimSyncWork({
        owner: "worker-b",
        now: "2026-09-21T00:00:03.000Z",
        lease_ms: 1_000,
        limit: 1,
      }),
      [],
    );
    await store.commandSyncRun({
      id: "run-1",
      org_id: installation.org_id,
      command: "resume",
      now: "2026-09-21T00:00:04.000Z",
    });
    const reclaimed = await store.claimSyncWork({
      owner: "worker-b",
      now: "2026-09-21T00:00:04.000Z",
      lease_ms: 1_000,
      limit: 1,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].attempts, 2);
    await store.commandSyncRun({
      id: "run-1",
      org_id: installation.org_id,
      command: "cancel",
      now: "2026-09-21T00:00:05.000Z",
    });
    assert.equal(
      (await store.getSyncRun("run-1", installation.org_id)).status,
      "cancelled",
    );
    store.close();
  });

  it("lists selected cursors in one read", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await store.acquireLease({
      installation_id: installation.id,
      stream_key: "alpha",
      lease_owner: "worker-a",
      now: "2026-09-21T00:00:00.000Z",
      lease_duration_ms: 1_000,
    });
    await store.acquireLease({
      installation_id: installation.id,
      stream_key: "beta",
      lease_owner: "worker-a",
      now: "2026-09-21T00:00:00.000Z",
      lease_duration_ms: 1_000,
    });
    const cursors = await store.listCursors(installation.id, ["beta"]);
    assert.deepEqual(
      cursors.map((cursor) => cursor.stream_key),
      ["beta"],
    );
    store.close();
  });

  it("uninstalls leftover sync work with the installation", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await seedRun(store);
    await seedWork(store);
    assert.equal(
      await store.deleteInstallation(installation.id, installation.org_id),
      true,
    );
    assert.equal(await store.getSyncRun("run-1", installation.org_id), null);
    store.close();
  });

  it("clears durable sync work with operational data", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await seedRun(store);
    await seedWork(store);
    const cleared = await store.clearOperationalData(
      installation.org_id,
      "2026-09-21T00:01:00.000Z",
    );
    assert.equal(cleared.kept.connectors, 1);
    assert.equal(await store.getSyncRun("run-1", installation.org_id), null);
    assert.deepEqual(
      await store.claimSyncWork({
        owner: "worker-a",
        now: "2026-09-21T00:01:01.000Z",
        lease_ms: 1_000,
        limit: 1,
      }),
      [],
    );
    store.close();
  });

  it("claims unassigned background work without taking a user run", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await seedRun(store);
    await seedWork(store, { id: "run-work", stream_key: "s-run" });
    await store.enqueueSyncWork({
      id: "due-work",
      installation_id: installation.id,
      stream_key: "s-due",
      lane: "live",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 8,
      unassigned: true,
    });
    assert.deepEqual(
      claimed.map((work) => work.id),
      ["due-work"],
    );
    store.close();
  });

  it("enqueues 10_000 unassigned rows in one batch without duplicating upserts", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    const now = "2026-09-21T00:00:00.000Z";
    const later = "2026-09-21T00:05:00.000Z";
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      id: `due-${index}`,
      installation_id: installation.id,
      stream_key: `channel:C${index}`,
      lane: "live",
      next_due_at: later,
      generation: 1,
      now,
    }));
    const started = Date.now();
    assert.equal(await store.enqueueSyncWorkMany(items), 10_000);
    const elapsed = Date.now() - started;
    assert.equal(
      await store.enqueueSyncWorkMany(
        items.map((item) => ({
          ...item,
          id: `${item.id}-again`,
          next_due_at: now,
        })),
      ),
      10_000,
    );
    const identities = await store.listUnassignedSyncWorkIdentities({
      installation_id: installation.id,
    });
    assert.equal(identities.length, 10_000);
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 8,
      unassigned: true,
    });
    assert.equal(claimed.length, 8);
    assert.ok(claimed.every((work) => work.next_due_at === now));
    assert.ok(elapsed < 1_000, `enqueueSyncWorkMany(10k) took ${elapsed}ms`);
    store.close();
  });

  it("wakes unassigned pending work by stream_key", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await seedInstallation(store);
    await store.enqueueSyncWork({
      id: "due-work",
      installation_id: installation.id,
      stream_key: "channel:C123",
      lane: "live",
      next_due_at: "2026-09-21T00:05:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    assert.equal(
      await store.hasUnassignedSyncWork({
        installation_id: installation.id,
        lanes: ["interactive", "live", "media"],
      }),
      true,
    );
    const woken = await store.wakeUnassignedSyncWork({
      installation_id: installation.id,
      stream_keys: ["channel:C123"],
      now: "2026-09-21T00:00:02.000Z",
    });
    assert.equal(woken, 1);
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:02.000Z",
      lease_ms: 1_000,
      limit: 1,
      unassigned: true,
    });
    assert.equal(claimed[0].next_due_at, "2026-09-21T00:00:02.000Z");
    store.close();
  });
});

describe("SQLite split durable sync work", () => {
  it("claims through the write worker and reads the run from the reader", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    try {
      await seedInstallation(store);
      await seedRun(store);
      await seedWork(store);
      const claimed = await store.claimSyncWork({
        owner: "split-worker",
        now: "2026-09-21T00:00:01.000Z",
        lease_ms: 30_000,
        limit: 1,
      });
      assert.equal(claimed.length, 1);
      const run = await store.getSyncRun("run-1", installation.org_id);
      assert.equal(run.status, "running");
      const batched = await store.enqueueSyncWorkMany([
        {
          id: "split-batch-1",
          installation_id: installation.id,
          stream_key: "s-live-2",
          lane: "live",
          next_due_at: "2026-09-21T00:00:00.000Z",
          generation: 1,
          now: "2026-09-21T00:00:02.000Z",
        },
      ]);
      assert.equal(batched, 1);
      assert.equal(
        (
          await store.listUnassignedSyncWorkIdentities({
            installation_id: installation.id,
          })
        ).length,
        1,
      );
    } finally {
      await store.close();
    }
  });

  it("batches 10_000 unassigned rows through the write worker", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    try {
      await seedInstallation(store);
      const now = "2026-09-21T00:00:00.000Z";
      const items = Array.from({ length: 10_000 }, (_, index) => ({
        id: `due-${index}`,
        installation_id: installation.id,
        stream_key: `channel:C${index}`,
        lane: "live",
        next_due_at: now,
        generation: 1,
        now,
      }));
      const started = Date.now();
      assert.equal(await store.enqueueSyncWorkMany(items), 10_000);
      const elapsed = Date.now() - started;
      assert.equal(
        (
          await store.listUnassignedSyncWorkIdentities({
            installation_id: installation.id,
          })
        ).length,
        10_000,
      );
      assert.ok(
        elapsed < 2_000,
        `split enqueueSyncWorkMany(10k) took ${elapsed}ms`,
      );
    } finally {
      await store.close();
    }
  });
});

const describePg = process.env.TEST_DATABASE_URL?.trim() ? describe : describe.skip;

describePg("postgres concurrent sync work claim", () => {
  const stores = [];

  after(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  async function isolatedUrl() {
    const schema = `s${randomUUID().replaceAll("-", "")}`;
    const client = new Client({
      connectionString: process.env.TEST_DATABASE_URL.trim(),
    });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await client.end();
    }
    const url = new URL(process.env.TEST_DATABASE_URL.trim());
    url.searchParams.set("options", `-csearch_path=${schema}`);
    return url.toString();
  }

  it("does not let two claimers take the same work row", async () => {
    const connectionString = await isolatedUrl();
    const writer = await PostgresAuthorityStore.open(connectionString);
    const first = await PostgresAuthorityStore.open(connectionString);
    const second = await PostgresAuthorityStore.open(connectionString);
    stores.push(writer, first, second);
    await writer.createInstallation(installation);
    await writer.createSyncRun({
      id: "run-1",
      org_id: installation.org_id,
      installation_id: installation.id,
      mode: "quick_start",
      now: "2026-09-21T00:00:00.000Z",
    });
    await writer.enqueueSyncWork({
      id: "work-1",
      run_id: "run-1",
      installation_id: installation.id,
      stream_key: "s-live",
      lane: "live",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    const now = "2026-09-21T00:00:01.000Z";
    const [left, right] = await Promise.all([
      first.claimSyncWork({
        owner: "worker-a",
        now,
        lease_ms: 60_000,
        limit: 10,
      }),
      second.claimSyncWork({
        owner: "worker-b",
        now,
        lease_ms: 60_000,
        limit: 10,
      }),
    ]);
    const ids = [...left, ...right].map((work) => work.id);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "work-1");
  });
});
