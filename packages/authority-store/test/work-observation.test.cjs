const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { MemoryWorkStore, enqueueWriteBack } = require("@regenic/domain");
const { SqliteAuthorityStore, SqliteSplitAuthorityStore } = require("../dist/sqlite");
const { PostgresAuthorityStore } = require("../dist/postgres");
const { Client } = require("pg");

const NOW = "2026-11-09T08:00:00.000Z";
const LATER = "2026-11-09T08:01:00.000Z";
const ORG = "owner";

const drivers = [
  { name: "memory", open: async () => ({ store: new MemoryWorkStore() }) },
  { name: "sqlite", open: async (path) => ({ store: new SqliteAuthorityStore(path) }) },
  { name: "sqlite writer RPC", open: async (path) => ({ store: await SqliteSplitAuthorityStore.open(path) }) },
];
drivers.push({
    name: "postgres",
    skip: !process.env.TEST_DATABASE_URL?.trim(),
    async open() {
      const base = process.env.TEST_DATABASE_URL.trim();
      const schema = `s${randomUUID().replaceAll("-", "")}`;
      const admin = new Client({ connectionString: base });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(base);
      url.searchParams.set("options", `-csearch_path=${schema}`);
      try {
        const store = await PostgresAuthorityStore.open(url.toString());
        return {
          store,
          async cleanup() {
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
          },
        };
      } catch (error) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
        throw error;
      }
    },
});

async function fixture(t, driver) {
  const root = await mkdtemp(join(tmpdir(), "regenic-work-observation-"));
  const path = join(root, "authority.db");
  let binding;
  t.after(async () => {
    try {
      await binding?.store.close?.();
    } finally {
      try {
        await binding?.cleanup?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  binding = await driver.open(path);
  const { store } = binding;
  const recipe = {
    id: "recipe-1", org_id: ORG, name: "Handle work",
    match: { record_class: "task" }, trigger: { kind: "push" },
    executor_type: "test", executor_config: {}, can_write_back: true,
    include_context: false, enabled: true, created_at: NOW, updated_at: NOW,
  };
  await store.putRecipe(recipe);
  await store.putWorkItem({
    id: "work-1", org_id: ORG, thread_id: "source:conversation", unit_key: "unit-1",
    record_class: "task", thread_facet: "ticket", status: "running",
    recipe_id: recipe.id, created_at: NOW, updated_at: NOW,
  });
  await store.putWorkRun({
    id: "run-1", org_id: ORG, work_item_id: "work-1", recipe_id: recipe.id,
    executor_type: "test", external_run_id: "external-1", status: "running",
    start_state: "submitted", created_at: NOW, updated_at: NOW,
  });
  const item = await store.getWorkItem(ORG, "work-1");
  const run = await store.getWorkRun(ORG, "run-1");
  const input = {
    expected_item: item,
    expected_run: run,
    handle: {
      status: "completed", external_run_id: "external-1",
      agent_thread_id: "executor:conversation", result: { summary: "Handled" },
    },
    can_write_back: true, trigger_kind: "push", now: LATER,
  };
  return { store, path, recipe, item, run, input };
}

for (const driver of drivers) {
  describe(`${driver.name} atomic work observation`, { skip: driver.skip }, () => {
    it("commits the completed run, work status and queued delivery together", async (t) => {
      const f = await fixture(t, driver);
      const result = await f.store.commitWorkObservation(f.input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.changed, true);
      assert.equal(result.transition.settled, true);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).status, "completed");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "done");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.status, "queued");
      assert.equal(delivery.payload.summary, "Handled");
      assert.equal(delivery.recipe_id, f.recipe.id);
    });

    it("does not apply an observation whose item snapshot was superseded", async (t) => {
      const f = await fixture(t, driver);
      const changed = { ...f.item, status: "waiting_human" };
      await f.store.putWorkItem(changed);
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "conflict", reason: "stale_observation",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), changed);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("does not retain mutable request or returned plan content in persisted state", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result.content = [
        { role: "body", media_type: "text/plain", text: "Original result" },
      ];
      const result = await f.store.commitWorkObservation(f.input);
      assert.equal(result.outcome, "applied");
      f.input.handle.result.content[0].text = "Changed input";
      result.transition.run.result.content[0].text = "Changed plan";
      assert.equal(
        (await f.store.getWorkRun(ORG, f.run.id)).result.content[0].text, "Original result",
      );
      assert.equal(
        (await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload.content[0].text, "Original result",
      );
    });

    it("fences stale run results even when timestamps have not changed", async (t) => {
      const f = await fixture(t, driver);
      const changed = { ...f.run, result: { summary: "A newer observation" } };
      await f.store.putWorkRun(changed);
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "conflict", reason: "stale_observation",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), changed);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("does not revive a terminal attempt even if its latest snapshot is supplied", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { status: "running", external_run_id: run.external_run_id },
      }), { outcome: "conflict", reason: "stale_observation" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
    });

    it("ignores locally skipped work without fabricating a remote cancellation", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkItem({ ...f.item, status: "skipped" });
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "ignored", reason: "work_skipped",
      });
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("permits only one of two competing completion observations", async (t) => {
      const f = await fixture(t, driver);
      const results = await Promise.all([
        f.store.commitWorkObservation(f.input),
        f.store.commitWorkObservation({
          ...f.input, handle: { ...f.input.handle, result: { summary: "Other result" } },
        }),
      ]);
      assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
      assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.payload.summary, run.result.summary);
    });

    it("keeps a pending delivery untouched on active observations", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        kind: "push", unit_key: f.item.unit_key, payload: { summary: "Earlier result" }, now: NOW,
      }));
      const result = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, status: "waiting_human" },
      });
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.settled, false);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "waiting_human");
      assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
    });

    it("atomically abandons an old delivery when a completed trial disables send-back", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        kind: "push", unit_key: f.item.unit_key, payload: { summary: "Earlier result" }, now: NOW,
      }));
      const result = await f.store.commitWorkObservation({ ...f.input, can_write_back: false });
      assert.equal(result.outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.status, "acked");
      assert.equal(delivery.write_back, "skipped");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "done");
    });

    it("does not resolve another tenant's work identities", async (t) => {
      const f = await fixture(t, driver);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: { ...f.item, org_id: "another-owner" },
        expected_run: { ...f.run, org_id: "another-owner" },
      }), { outcome: "conflict", reason: "missing_work" });
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("rejects a run belonging to another work item without changing either row", async (t) => {
      const f = await fixture(t, driver);
      await assert.rejects(f.store.commitWorkObservation({
        ...f.input, expected_run: { ...f.run, work_item_id: "work-2" },
      }), /same organization and work item/);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });
  });
}

for (const driver of drivers.filter((d) => d.name.startsWith("sqlite"))) {
  describe(`${driver.name} observation rollback`, () => {
    for (const [table, operation] of [["work_deliveries", "INSERT"], ["work_items", "UPDATE"]]) {
      it(`rolls back every write when ${table} fails after the run update`, async (t) => {
        const f = await fixture(t, driver);
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_observation BEFORE ${operation} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'observation write rejected'); END`);
          await assert.rejects(f.store.commitWorkObservation(f.input), /observation write rejected/);
          assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
          assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
          db.exec("DROP TRIGGER reject_observation");
          assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
        } finally {
          db.close();
        }
      });
    }
  });
}

it("fences competing observations from two SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([
    f.store.commitWorkObservation(f.input),
    second.commitWorkObservation(f.input),
  ]);
  assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
  assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
  assert.equal((await second.listWorkDeliveries(ORG)).length, 1);
});
