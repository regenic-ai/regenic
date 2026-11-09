const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { MemoryWorkStore, enqueueWriteBack, conversationId } = require("@regenic/domain");
const { SqliteAuthorityStore, SqliteSplitAuthorityStore } = require("../dist/sqlite");
const { PostgresAuthorityStore } = require("../dist/postgres");
const { Client } = require("pg");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../dist/sqlite/migrations");

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

const TARGET = { installation_id: "sender-1", source: "source", target: "results" };

async function fixture(t, driver, runFields = {}) {
  const root = join(process.cwd(), `.test-work-observation-${randomUUID()}`);
  await mkdir(root, { recursive: true });
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
    record_class: "task", thread_facet: "ticket", status: "open",
    recipe_id: recipe.id, created_at: NOW, updated_at: NOW,
  });
  const initialRun = {
    id: "run-1", org_id: ORG, work_item_id: "work-1", recipe_id: recipe.id,
    executor_type: "test", status: "running", start_state: "pending",
    created_at: NOW, updated_at: NOW,
    ...runFields,
  };
  assert.equal(await store.claimWorkRunStart({ run: initialRun }), true);
  const item = await store.getWorkItem(ORG, "work-1");
  assert.equal(item.current_run_id, initialRun.id);
  assert.equal(item.version, 1);
  const pendingRun = await store.getWorkRun(ORG, "run-1");
  assert.equal(pendingRun.version, 0);
  const run = await store.putWorkRun({
    ...pendingRun, external_run_id: "external-1", start_state: "submitted",
    updated_at: NOW,
  });
  const input = {
    expected_item: item,
    expected_run: run,
    handle: {
      status: "completed", external_run_id: "external-1",
      agent_thread_id: "executor:conversation", result: { summary: "Handled" },
    },
    can_write_back: true, trigger_kind: "push", now: LATER,
  };
  return {
    get store() { return binding.store; },
    path, recipe, item, run, input,
    async reopen() {
      if (!driver.name.startsWith("sqlite")) return;
      await binding.store.close();
      binding = await driver.open(path);
    },
  };
}

async function startCheckpointFixture(t, driver) {
  const f = await fixture(t, driver, {
    write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
  });
  const run = await f.store.putWorkRun({
    ...f.run, external_run_id: undefined, agent_thread_id: undefined, start_state: "pending",
  });
  return { f, input: { expected_item: f.item, expected_run: run, now: LATER } };
}

async function timeoutFixture(t, driver) {
  const f = await fixture(t, driver);
  const record = await f.store.putSearchAnswer({
    id: "answer-1", org_id: ORG, work_item_id: f.item.id,
    query: "Question", event_ids: ["event-1"], created_at: NOW, updated_at: NOW,
  });
  const saved = await f.store.getSearchAnswer(ORG, record.id);
  return Object.assign(f, { record: saved, timeout: { expected_item: f.item, search_answer_timeout: saved, now: LATER } });
}

function creationInput(f, fields = {}) {
  const recipe = { ...f.recipe, id: "created-recipe", trigger: { kind: "manual" }, created_at: LATER, updated_at: LATER };
  return {
    item: {
      ...f.item, id: "created-work", unit_key: "created-unit", recipe_id: recipe.id,
      status: "open", version: 0, current_run_id: undefined, created_at: LATER, updated_at: LATER,
    },
    recipe, expected_recipe: null, ...fields,
  };
}

for (const driver of drivers) {
  describe(`${driver.name} atomic work observation`, { skip: driver.skip }, () => {
    it("atomically creates a work item and its recipe and returns saved snapshots", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const result = await f.store.createWorkItem(input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.version, 0);
      assert.equal(result.item.current_run_id, undefined);
      assert.deepEqual(result.item, await f.store.getWorkItem(ORG, input.item.id));
      assert.deepEqual(result.recipe, await f.store.getRecipe(ORG, input.recipe.id));
      const saved = structuredClone(result);
      result.recipe.executor_config.changed = true;
      result.item.status = "skipped";
      await f.reopen();
      assert.deepEqual(await f.store.getWorkItem(ORG, input.item.id), saved.item);
      assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), saved.recipe);
      assert.deepEqual(await f.store.listWorkRuns(ORG, input.item.id), []);
    });

    it("never overwrites existing work or its recipe when creation repeats", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f, {
        item: { ...f.item, status: "open", current_run_id: undefined, version: 0 },
      });
      input.recipe.id = f.recipe.id;
      input.expected_recipe = await f.store.getRecipe(ORG, f.recipe.id);
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getRecipe(ORG, f.recipe.id), input.expected_recipe);
    });

    it("compares the recipe snapshot before applying a configuration change", async (t) => {
      const f = await fixture(t, driver);
      const expected = await f.store.getRecipe(ORG, f.recipe.id);
      const input = creationInput(f, {
        recipe: { ...expected, executor_config: { prompt: "New instruction" }, created_at: LATER, updated_at: LATER },
        expected_recipe: expected,
      });
      input.item.recipe_id = f.recipe.id;
      const result = await f.store.createWorkItem(input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.recipe.created_at, expected.created_at);
      assert.equal(result.recipe.updated_at, LATER);
      assert.deepEqual(result.recipe.executor_config, { prompt: "New instruction" });
      assert.deepEqual(result.recipe, await f.store.getRecipe(ORG, f.recipe.id));
      const stale = { ...input, item: { ...input.item, id: "stale-work" } };
      stale.recipe = { ...input.recipe, executor_config: { prompt: "Stale update" } };
      assert.deepEqual(await f.store.createWorkItem(stale), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, stale.item.id), null);
      assert.deepEqual(await f.store.getRecipe(ORG, f.recipe.id), result.recipe);
    });

    it("does not create a replacement recipe when the requested item ID already exists", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      input.item.id = f.item.id;
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });

    it("reuses equivalent concurrent recipe creation without changing its timestamps", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const first = await f.store.createWorkItem(input);
      assert.equal(first.outcome, "applied");
      const second = await f.store.createWorkItem({
        ...input, item: { ...input.item, id: "another-created-work", unit_key: "another-created-unit" },
        recipe: { ...input.recipe, created_at: NOW, updated_at: NOW },
      });
      assert.equal(second.outcome, "applied");
      assert.deepEqual(second.recipe, first.recipe);
      assert.deepEqual(second.recipe, await f.store.getRecipe(ORG, input.recipe.id));
    });

    it("rejects a conflicting newly created or removed recipe without leaving work", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Competing config" } });
      const saved = await f.store.getRecipe(ORG, input.recipe.id);
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      await f.store.deleteRecipe(ORG, input.recipe.id);
      assert.deepEqual(await f.store.createWorkItem({ ...input, expected_recipe: saved }),
        { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
    });

    it("does not claim work or recipe IDs belonging to another organization", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      await f.store.putRecipe({ ...input.recipe, org_id: "other-org" });
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      await f.store.putWorkItem({
        ...input.item, recipe_id: undefined, org_id: "other-org",
      });
      const foreign = await f.store.getWorkItem("other-org", input.item.id);
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.deepEqual(await f.store.getWorkItem("other-org", input.item.id), foreign);
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
    });

    it("allows only one creation for the same item and keeps the winning recipe", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const results = await Promise.all([input, {
        ...input, recipe: { ...input.recipe, executor_config: { prompt: "Other instruction" } },
      }].map((candidate) => f.store.createWorkItem(candidate)));
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      const winner = results.find((result) => result.outcome === "applied");
      assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), winner.recipe);
      assert.deepEqual(await f.store.getWorkItem(ORG, input.item.id), winner.item);
    });

    it("atomically persists a timeout cause with local dismissal and delivery stops", async (t) => {
      const f = await timeoutFixture(t, driver);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const result = await f.store.dismissWorkItem(f.timeout);
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.version, f.item.version + 1);
      assert.equal(result.item.current_run_id, f.run.id);
      assert.deepEqual(result.run, f.run);
      assert.deepEqual(result.search_answer, { ...f.record, outcome: "timed_out", updated_at: LATER });
      assert.equal(result.deliveries[0].id, delivery.id);
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      const saved = structuredClone(result);
      result.search_answer.event_ids.push("mutated");
      result.item.status = "done";
      await f.reopen();
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), saved.search_answer);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), saved.deliveries[0]);
      assert.deepEqual(await f.store.dismissWorkItem({
        ...f.timeout, expected_item: saved.item,
      }), { outcome: "conflict", reason: "stale_search_answer" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
    });

    for (const change of ["deleted", "query", "events", "outcome", "binding"]) {
      it(`rejects a ${change} search answer snapshot without dismissing its work`, async (t) => {
        const f = await timeoutFixture(t, driver);
        if (change === "deleted") {
          await f.store.deleteSearchAnswer(ORG, f.record.id);
        } else {
          if (change === "binding") await f.store.putWorkItem({
            ...f.item, id: "another-item", unit_key: "another-unit", current_run_id: undefined, status: "open",
          });
          await f.store.putSearchAnswer({
            ...f.record,
            ...(change === "query" ? { query: "A new question" } : {}),
            ...(change === "events" ? { event_ids: ["event-2"] } : {}),
            ...(change === "outcome" ? { outcome: "timed_out" } : {}),
            ...(change === "binding" ? { work_item_id: "another-item" } : {}),
          });
        }
        const record = await f.store.getSearchAnswer(ORG, f.record.id);
        assert.deepEqual(await f.store.dismissWorkItem(f.timeout), { outcome: "conflict", reason: "stale_search_answer" });
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
        assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), record);
      });
    }

    it("rejects foreign timeout metadata before any local write", async (t) => {
      const f = await timeoutFixture(t, driver);
      await assert.rejects(f.store.dismissWorkItem({
        ...f.timeout, search_answer_timeout: { ...f.record, org_id: "other-org" },
      }), /must belong/);
      await assert.rejects(f.store.dismissWorkItem({
        ...f.timeout, search_answer_timeout: { ...f.record, work_item_id: "other-item" },
      }), /must belong/);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
    });

    for (const status of ["completed", "failed", "cancelled"]) {
      it(`does not timeout a current Run already observed as ${status}`, async (t) => {
        const f = await timeoutFixture(t, driver);
        const run = await f.store.putWorkRun({ ...f.run, status });
        assert.deepEqual(await f.store.dismissWorkItem(f.timeout),
          { outcome: "conflict", reason: "inactive_search_answer" });
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
        assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
      });
    }

    it("fences a timeout against a concurrent human cancellation without rewriting its cause", async (t) => {
      const f = await timeoutFixture(t, driver);
      const [timeout, cancel] = await Promise.all([
        f.store.dismissWorkItem(f.timeout),
        f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
      ]);
      assert.equal(Number(timeout.outcome === "applied") + Number(cancel.outcome === "applied"), 1);
      const answer = await f.store.getSearchAnswer(ORG, f.record.id);
      assert.equal(answer.outcome, timeout.outcome === "applied" ? "timed_out" : undefined);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    });

    it("atomically dismisses work and stops all unresolved deliveries without rewriting runs", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const result = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.version, f.item.version + 1);
      assert.equal(result.item.current_run_id, f.run.id);
      assert.deepEqual(result.run, f.run);
      assert.equal(result.deliveries[0].id, delivery.id);
      assert.equal(result.deliveries[0].status, "acked");
      assert.equal(result.deliveries[0].write_back, "skipped");
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      const saved = structuredClone(result);
      result.item.unit_key = "changed";
      result.run.result = { summary: "changed" };
      result.deliveries[0].payload.summary = "changed";
      await f.reopen();
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), saved.deliveries[0]);
    });

    it("preserves completed results while stopping both current and historical delivery attempts", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      const completed = await f.store.putWorkRun({
        ...f.run, status: "completed", result: { summary: "Completed result" },
      });
      const historical = await f.store.putWorkRun({
        ...completed, id: "historical-run", status: "failed", result: { summary: "Historical result" },
      });
      const item = await f.store.putWorkItem({ ...f.item, status: "done" });
      const rows = [];
      for (const run of [completed, historical]) {
        rows.push(await f.store.putWorkDelivery(enqueueWriteBack({
          org_id: ORG, work_item_id: item.id, recipe_id: f.recipe.id, kind: "push",
          unit_key: item.unit_key, run_id: run.id, target: TARGET,
          payload: { summary: run.result.summary }, now: NOW,
        })));
      }
      const result = await f.store.dismissWorkItem({ expected_item: item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.deliveries.length, 2);
      assert.equal(result.item.current_run_id, completed.id);
      assert.deepEqual(result.run, completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, completed.id), completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, historical.id), historical);
      for (const row of rows) {
        const stopped = await f.store.getWorkDelivery(ORG, row.id);
        assert.equal(stopped.status, "acked");
        assert.equal(stopped.write_back, "skipped");
        assert.deepEqual(stopped.payload, row.payload);
        assert.deepEqual(stopped.target, row.target);
        assert.equal(stopped.idempotency_key, row.idempotency_key);
        assert.equal(stopped.run_id, row.run_id);
      }
      assert.deepEqual(await f.store.dismissWorkItem({ expected_item: item, now: LATER }),
        { outcome: "conflict", reason: "stale_dismissal" });
    });

    it("preserves an in-flight claim and accepts its late receipt after dismissal", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const claim = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "sender", now: NOW,
      });
      assert.equal(claim.outcome, "applied");
      const result = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.deliveries[0].status, "write_back");
      assert.equal(result.deliveries[0].claim_token, claim.delivery.claim_token);
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      const receipt = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "receipt", owner: "sender",
        token: claim.delivery.claim_token, now: LATER, receipt: { accepted: true, rpc_id: "accepted" },
      });
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.delivery.channel_receipt.rpc_id, "accepted");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "skipped");
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    });

    it("does not dismiss a successor or change delivery when an old item snapshot is stale", async (t) => {
      const f = await fixture(t, driver);
      const current = await f.store.putWorkItem(f.item);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      assert.deepEqual(await f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
        { outcome: "conflict", reason: "stale_dismissal" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), current);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    });

    it("fences competing retry and dismissal and supports unstarted work", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const [dismissed, started] = await Promise.all([
        f.store.dismissWorkItem({ expected_item: item, now: LATER }),
        f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "successor", status: "running", start_state: "pending" },
        }),
      ]);
      assert.equal(Number(dismissed.outcome === "applied") + Number(started), 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      const unstarted = await f.store.putWorkItem({
        ...f.item, id: "unstarted", unit_key: "unstarted", status: "open",
      });
      const result = await f.store.dismissWorkItem({ expected_item: unstarted, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.run, null);
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.current_run_id, undefined);
      assert.deepEqual(result.deliveries, []);
    });

    for (const mode of ["automatic", "manual", "auxiliary"]) {
      it(`commits a ${mode} preflight failure and item version together`, async (t) => {
        const f = await fixture(t, driver);
        const oldRun = await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
        const item = await f.store.putWorkItem({ ...f.item, status: "open" });
        const run = {
          id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
          executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
          write_back_required: false, trigger_kind: "push", created_at: LATER, updated_at: LATER,
        };
        const result = await f.store.recordWorkRunStartFailure({ expected_item: item, run, mode });
        assert.equal(result.outcome, "applied");
        assert.equal(result.item.status, mode === "automatic" ? "failed" : item.status);
        assert.equal(result.item.current_run_id, mode === "automatic" ? run.id : item.current_run_id);
        assert.equal(result.item.version, item.version + 1);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), result.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), result.run);
        assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
        const saved = structuredClone(result);
        result.item.unit_key = "changed";
        result.run.result.summary = "changed";
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), saved.run);
        assert.deepEqual(await f.store.recordWorkRunStartFailure({ expected_item: item, run, mode }),
          { outcome: "conflict", reason: "stale_failure" });
      });
    }

    it("does not insert failure history over active runs, ignored work or unresolved delivery", async (t) => {
      const f = await fixture(t, driver);
      const item = await f.store.putWorkItem({ ...f.item, status: "open" });
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const input = { expected_item: item, run, mode: "automatic" };
      assert.deepEqual(await f.store.recordWorkRunStartFailure(input), { outcome: "conflict", reason: "active_run" });
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const ignored = await f.store.putWorkItem({ ...item, status: "skipped" });
      assert.deepEqual(await f.store.recordWorkRunStartFailure(input), { outcome: "conflict", reason: "stale_failure" });
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), ignored);
      const current = await f.store.putWorkItem({ ...ignored, status: "open" });
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id, kind: "push",
        unit_key: item.unit_key, payload: { summary: "Previous result" }, now: LATER,
      }));
      assert.deepEqual(await f.store.recordWorkRunStartFailure({ ...input, expected_item: current }),
        { outcome: "conflict", reason: "unresolved_delivery" });
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), current);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
    });

    it("allows only one failure or real start against a selected snapshot", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "open" });
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const [failure, started] = await Promise.all([
        f.store.recordWorkRunStartFailure({ expected_item: item, run, mode: "manual" }),
        f.store.claimWorkRunStart({
          expected_item: item, run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
        }),
      ]);
      assert.equal(Number(failure.outcome === "applied") + Number(started), 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      assert.equal((await f.store.listWorkRuns(ORG, item.id)).length, 2);
    });

    it("preserves a completed item and result when a trial's selected rule fails preflight", async (t) => {
      const f = await fixture(t, driver);
      const completed = await f.store.putWorkRun({
        ...f.run, status: "completed", start_state: undefined, result: { summary: "Original result" },
      });
      const item = await f.store.putWorkItem({ ...f.item, status: "done" });
      await f.store.putRecipe({ ...f.recipe, id: "trial-rule" });
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: "trial-rule",
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const result = await f.store.recordWorkRunStartFailure({
        expected_item: item, run, mode: "manual", rebind: "manual",
      });
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "done");
      assert.equal(result.item.recipe_id, f.recipe.id);
      assert.equal(result.item.current_run_id, completed.id);
      assert.equal(result.item.version, item.version + 1);
      assert.deepEqual(await f.store.getWorkRun(ORG, completed.id), completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), result.run);
    });

    it("rejects deleted rules and reused failure identities without touching work history", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "open" });
      const run = {
        id: f.run.id, org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const input = { expected_item: item, run, mode: "automatic" };
      await assert.rejects(f.store.recordWorkRunStartFailure(input), /already exists/);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      await f.store.deleteRecipe(ORG, f.recipe.id);
      const current = await f.store.getWorkItem(ORG, item.id);
      const result = await f.store.recordWorkRunStartFailure({
        ...input, expected_item: { ...current, recipe_id: f.recipe.id },
        run: { ...run, id: "new-failure" },
      });
      assert.equal(result.outcome, "conflict");
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), current);
      assert.equal(await f.store.getWorkRun(ORG, "new-failure"), null);
    });

    for (const [status, intent] of [
      ["failed", "manual"], ["done", "manual"], ["skipped", "manual"],
      ["open", "automatic"], ["failed", "automatic"],
    ]) {
      it(`binds the selected rule only when the ${intent} ${status} start is reserved`, async (t) => {
        const f = await fixture(t, driver);
        const oldRun = await f.store.putWorkRun({
          ...f.run, status: "failed", start_state: undefined,
        });
        const item = await f.store.putWorkItem({ ...f.item, status });
        const recipe = await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
        const run = { ...f.run, id: "trial-run", recipe_id: recipe.id, status: "running", start_state: "pending" };
        const input = { run, expected_item: item, retry: intent, rebind: intent };
        assert.equal(await f.store.claimWorkRunStart({ ...input, rebind: undefined }), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.claimWorkRunStart(input), true);
        const saved = await f.store.getWorkItem(ORG, item.id);
        assert.equal(saved.recipe_id, recipe.id);
        assert.equal(saved.status, "running");
        assert.equal(saved.current_run_id, run.id);
        assert.equal(saved.version, item.version + 1);
        assert.equal(saved.head_event_id, item.head_event_id);
        assert.equal((await f.store.getWorkRun(ORG, run.id)).recipe_id, recipe.id);
        assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved);
      });
    }

    it("does not rebind open work already owned by another rule through a manual trial", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const item = await f.store.putWorkItem({ ...f.item, status: "open" });
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: item, retry: "manual", rebind: "manual",
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      const unbound = await f.store.putWorkItem({ ...item, recipe_id: undefined });
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: unbound, retry: "manual", rebind: "manual",
      }), true);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).recipe_id, run.recipe_id);
    });

    it("checks capacity on the selected rule without changing the old binding", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      await f.store.putWorkItem({
        ...f.item, id: "occupied", unit_key: "occupied", recipe_id: "selected-rule",
      });
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: item, retry: "automatic", rebind: "automatic", max_concurrent: 1,
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
    });

    it("preserves the original binding on stale, active, missing-rule and unresolved-delivery conflicts", async (t) => {
      const f = await fixture(t, driver);
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      const input = { run, expected_item: item, retry: "manual", rebind: "manual" };
      assert.equal(await f.store.claimWorkRunStart(input), false, "Old live run blocks rebind");
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const newer = await f.store.putWorkItem(item);
      assert.equal(await f.store.claimWorkRunStart(input), false);
      const current = { ...input, expected_item: newer };
      assert.equal(await f.store.claimWorkRunStart({
        ...current, run: { ...run, recipe_id: "missing-rule" },
      }), false);
      await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: item.unit_key, payload: { summary: "Old pending result" }, now: LATER,
      }));
      assert.equal(await f.store.claimWorkRunStart(current), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), newer);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
      assert.equal((await f.store.listWorkDeliveries(ORG))[0].status, "queued");
    });

    for (const [status, retry] of [
      ["failed", "automatic"], ["failed", "manual"], ["done", "manual"], ["skipped", "manual"],
    ]) {
      it(`reserves a ${retry} retry directly from ${status} with one item version change`, async (t) => {
        const f = await fixture(t, driver);
        const terminal = await f.store.putWorkRun({
          ...f.run, status: status === "done" ? "completed" : status === "skipped" ? "cancelled" : "failed",
          start_state: undefined,
        });
        const item = await f.store.putWorkItem({ ...f.item, status });
        const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending", version: 0 };
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: item }), true);
        const saved = await f.store.getWorkItem(ORG, item.id);
        assert.equal(saved.status, "running");
        assert.equal(saved.version, item.version + 1);
        assert.equal(saved.current_run_id, run.id);
        assert.deepEqual(await f.store.getWorkRun(ORG, terminal.id), terminal);
        assert.equal((await f.store.getWorkRun(ORG, run.id)).version, 0);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved);
        assert.deepEqual(await f.store.getWorkRun(ORG, terminal.id), terminal);
      });
    }

    it("never revives ignored work from a stale failure or open snapshot", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const failed = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const skipped = await f.store.putWorkItem({ ...failed, status: "skipped" });
      const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending" };
      for (const retry of ["manual", "automatic"]) {
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: failed }), false);
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: f.item }), false);
      }
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), skipped);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
    });

    for (const status of ["open", "failed"]) {
      it(`rejects a stale ${status} version even with the same status, pointer and timestamp`, async (t) => {
        const f = await fixture(t, driver);
        await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
        const expected = await f.store.putWorkItem({ ...f.item, status });
        const newer = await f.store.putWorkItem(expected);
        const input = {
          expected_item: expected, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        };
        assert.equal(await f.store.claimWorkRunStart(input), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), newer);
        assert.equal(await f.store.getWorkRun(ORG, input.run.id), null);
        assert.equal(await f.store.claimWorkRunStart({ ...input, expected_item: newer }), true);
      });
    }

    it("does not bypass missing retry intent, active attempts or unresolved historical deliveries", async (t) => {
      const f = await fixture(t, driver);
      const failed = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({ run, retry: "manual", expected_item: failed }), false);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      assert.equal(await f.store.claimWorkRunStart({ run, expected_item: failed }), false);
      const delivery = enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Old result" }, now: LATER,
      });
      for (const status of ["queued", "write_back", "dead", "uncertain"]) {
        await f.store.putWorkDelivery({ ...delivery, status });
        assert.equal(await f.store.claimWorkRunStart({ run, retry: "manual", expected_item: failed }), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), failed);
      }
      await f.store.putWorkDelivery({ ...delivery, status: "acked", write_back: "sent" });
      assert.equal(await f.store.claimWorkRunStart({ run, retry: "manual", expected_item: failed }), true);
    });

    it("serializes concurrent manual and automatic retries of one failed snapshot", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const results = await Promise.all(["manual", "automatic"].map((retry) =>
        f.store.claimWorkRunStart({
          expected_item: item, retry,
          run: { ...f.run, id: `retry-${retry}`, status: "running", start_state: "pending" },
        })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      assert.equal((await f.store.listWorkRuns(ORG, item.id)).length, 2);
    });

    it("preserves the failed status and pointer if retry capacity is full", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: item, retry: "automatic", max_concurrent: 0,
        run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      assert.equal(await f.store.getWorkRun(ORG, "retry-run"), null);
    });

    it("checkpoints session binding and submission without changing frozen obligations", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      assert.equal(bound.outcome, "applied");
      assert.equal(bound.run.start_state, "pending");
      assert.equal(bound.run.version, input.expected_run.version + 1);
      assert.deepEqual(bound.item, input.expected_item);
      const submitted = await f.store.checkpointWorkRunStart({
        ...input, expected_run: bound.run, kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(submitted.outcome, "applied");
      assert.equal(submitted.run.start_state, "submitted");
      assert.equal(submitted.run.agent_thread_id, "executor:1");
      assert.deepEqual(submitted.run.write_back_target, TARGET);
      assert.equal(submitted.run.write_back_required, true);
      assert.equal(submitted.run.trigger_kind, "push");
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      await f.reopen();
      assert.deepEqual(await f.store.getWorkRun(ORG, submitted.run.id), submitted.run);
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: submitted.item, expected_run: submitted.run,
      })).outcome, "applied");
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
    });

    for (const kind of ["failed", "uncertain"]) {
      it(`atomically checkpoints ${kind} with the matching item status`, async (t) => {
        const { f, input } = await startCheckpointFixture(t, driver);
        const result = await f.store.checkpointWorkRunStart({ ...input, kind, error: "Start error" });
        assert.equal(result.outcome, "applied");
        assert.equal(result.run.status, kind === "failed" ? "failed" : "waiting_human");
        assert.equal(result.item.status, result.run.status);
        assert.equal(result.run.start_state, kind === "failed" ? undefined : "uncertain");
        assert.equal(result.run.version, input.expected_run.version + 1);
        assert.equal(result.item.version, input.expected_item.version + 1);
        assert.equal(result.item.current_run_id, result.run.id);
        assert.equal(result.run.result.summary, "Start error");
        assert.deepEqual(await f.store.getWorkRun(ORG, result.run.id), result.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, result.item.id), result.item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkRun(ORG, result.run.id), result.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, result.item.id), result.item);
      });
    }

    it("does not mistake a known external session for a definite pre-start failure", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      const next = { ...input, expected_run: bound.run };
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...next, kind: "failed", error: "Not proven",
      }), { outcome: "conflict", reason: "start_closed" });
      const uncertain = await f.store.checkpointWorkRunStart({
        ...next, kind: "uncertain", error: "Submission response lost",
      });
      assert.equal(uncertain.run.external_run_id, "external-1");
      assert.equal(uncertain.run.agent_thread_id, "executor:1");
      const recovered = await f.store.checkpointWorkRunStart({
        ...input, expected_item: uncertain.item, expected_run: uncertain.run,
        kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(recovered.outcome, "applied");
      assert.equal(recovered.run.start_state, "submitted");
      assert.equal(recovered.item.status, "waiting_human");
    });

    it("rejects stale startup snapshots, skipped work and superseded attempts", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const command = { ...input, kind: "uncertain", error: "Unknown" };
      const newer = await f.store.putWorkItem({ ...f.item, updated_at: LATER });
      assert.deepEqual(await f.store.checkpointWorkRunStart(command),
        { outcome: "conflict", reason: "stale_checkpoint" });
      const run = await f.store.putWorkRun({ ...input.expected_run, result: { summary: "Newer" } });
      assert.deepEqual(await f.store.checkpointWorkRunStart({ ...command, expected_item: newer }),
        { outcome: "conflict", reason: "stale_checkpoint" });
      const skipped = await f.store.putWorkItem({ ...newer, status: "skipped" });
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...command, expected_item: skipped, expected_run: run,
      }), { outcome: "conflict", reason: "work_skipped" });
      await f.store.putWorkRun({ ...run, status: "cancelled", start_state: undefined });
      await f.store.putWorkItem({ ...skipped, status: "open" });
      assert.equal(await f.store.claimWorkRunStart({
        run: { ...input.expected_run, id: "new-start", status: "running", start_state: "pending" },
      }), true);
      const currentItem = await f.store.getWorkItem(ORG, f.item.id);
      const closedRun = await f.store.getWorkRun(ORG, run.id);
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...command, expected_item: currentItem, expected_run: closedRun,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), closedRun);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), currentItem);
    });

    it("cannot checkpoint a closed or terminal start or cross-tenant identity", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const closed = await f.store.putWorkRun({ ...input.expected_run, start_state: undefined });
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...input, expected_run: closed, kind: "uncertain", error: "Unknown",
      }), { outcome: "conflict", reason: "start_closed" });
      const completed = await f.store.putWorkRun({ ...closed, status: "completed", start_state: "submitted" });
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...input, expected_run: completed, kind: "submitted", external_run_id: "late",
      }), { outcome: "conflict", reason: "start_closed" });
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...input, expected_item: { ...input.expected_item, org_id: "foreign" },
        expected_run: { ...completed, org_id: "foreign" }, kind: "uncertain", error: "Unknown",
      }), { outcome: "conflict", reason: "missing_work" });
      await assert.rejects(f.store.checkpointWorkRunStart({
        ...input, expected_run: { ...completed, work_item_id: "foreign" }, kind: "uncertain", error: "Unknown",
      }), /same organization and work item/);
      assert.deepEqual(await f.store.getWorkRun(ORG, completed.id), completed);
    });

    it("serializes competing failure and submission checkpoints without torn status", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const results = await Promise.all([
        f.store.checkpointWorkRunStart({ ...input, kind: "failed", error: "Not sent" }),
        f.store.checkpointWorkRunStart({ ...input, kind: "submitted", external_run_id: "accepted" }),
      ]);
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
      const winner = results.find((result) => result.outcome === "applied");
      assert.deepEqual(await f.store.getWorkRun(ORG, winner.run.id), winner.run);
      assert.deepEqual(await f.store.getWorkItem(ORG, winner.item.id), winner.item);
      winner.run.result = { summary: "Mutated return" };
      assert.notEqual((await f.store.getWorkRun(ORG, winner.run.id)).result?.summary, "Mutated return");
    });

    it("atomically claims each delivery once and fences settlement with owner, token and lease", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const command = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      await assert.rejects(f.store.putWorkDelivery({
        ...delivery, lease_owner: "forged", claim_token: "forged",
      }), /atomic delivery command/);
      const claims = await Promise.all(["worker-1", "worker-2"].map((owner) =>
        f.store.transitionWorkDelivery({ ...command, kind: "claim", owner })));
      assert.equal(claims.filter((row) => row.outcome === "applied").length, 1);
      const claimed = claims.find((row) => row.outcome === "applied").delivery;
      assert.ok(claimed.claim_token);
      assert.equal(claimed.attempts, 1);
      const evidence = { ...command, owner: claimed.lease_owner, token: claimed.claim_token };
      for (const change of [{ owner: "foreign" }, { token: "foreign" }]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, ...change, kind: "sent",
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      await assert.rejects(f.store.putWorkDelivery({ ...claimed, status: "acked", write_back: "sent" }),
        /atomic delivery command/);
      const renewed = await f.store.transitionWorkDelivery({
        ...evidence, kind: "renew", now: "2026-11-09T08:01:30.000Z",
      });
      assert.equal(renewed.outcome, "applied");
      assert.equal(renewed.delivery.claim_token, claimed.claim_token);
      assert.equal(renewed.delivery.lease_expires_at, "2026-11-09T08:02:30.000Z");
      const failed = await f.store.transitionWorkDelivery({
        ...evidence, kind: "failed", error: "Definitely rejected before acceptance",
        now: "2026-11-09T08:01:31.000Z",
      });
      assert.equal(failed.outcome, "applied");
      const retry = await f.store.transitionWorkDelivery({
        ...command, kind: "claim", owner: claimed.lease_owner, force: true,
        now: "2026-11-09T08:01:32.000Z",
      });
      assert.equal(retry.outcome, "applied");
      assert.notEqual(retry.delivery.claim_token, claimed.claim_token);
      assert.equal(retry.delivery.idempotency_key, delivery.idempotency_key);
      for (const kind of ["sent", "failed", "renew", "receipt", "uncertain"]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, kind, receipt: { accepted: true, rpc_id: "stale" }, error: "stale",
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      const settled = await f.store.transitionWorkDelivery({
        ...command, kind: "sent", owner: retry.delivery.lease_owner,
        token: retry.delivery.claim_token, now: "2026-11-09T08:01:33.000Z",
      });
      assert.equal(settled.delivery.status, "acked");
    });

    it("persists unknown acceptance across restart and merges only the retained claim's late receipt", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const { delivery: claimed } = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker",
      });
      const evidence = { ...base, owner: "worker", token: claimed.claim_token };
      const later = "2026-11-09T08:02:00.000Z";
      for (const kind of ["sent", "failed", "renew"]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, kind, error: "expired", now: later,
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "expire", now: later,
      })).delivery.status, "uncertain");
      await f.reopen();
      const restored = await f.store.getWorkDelivery(ORG, delivery.id);
      assert.equal(restored.status, "uncertain");
      assert.equal(restored.claim_token, claimed.claim_token);
      assert.equal(restored.lease_owner, "worker");
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "cancel", now: later,
      })).delivery.status, "uncertain");
      assert.deepEqual(await f.store.listDueWorkDeliveries(ORG, later), []);
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", force: true, now: later,
      })).outcome, "conflict");
      assert.equal((await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "late-receipt" }, now: later,
      })).outcome, "applied");
      assert.deepEqual(await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "conflicting-receipt" }, now: later,
      }), { outcome: "conflict", reason: "receipt_conflict" });
      const due = await f.store.listDueWorkDeliveries(ORG, later);
      assert.equal(due.length, 1);
      const recovery = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", now: later,
      });
      assert.equal(recovery.outcome, "applied");
      assert.equal(recovery.delivery.channel_receipt.rpc_id, "late-receipt");
      assert.notEqual(recovery.delivery.claim_token, claimed.claim_token);
      assert.equal((await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true }, now: later,
      })).outcome, "conflict");
    });

    it("retains in-flight acceptance evidence when work is dismissed instead of faking a withdrawal", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const { delivery: claimed } = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker",
      });
      await f.store.putWorkItem({ ...await f.store.getWorkItem(ORG, f.item.id), status: "skipped" });
      const cancel = await f.store.transitionWorkDelivery({ ...base, kind: "cancel" });
      assert.equal(cancel.delivery.status, "write_back");
      assert.equal(cancel.delivery.cancel_requested_at, LATER);
      const evidence = { ...base, owner: "worker", token: claimed.claim_token };
      await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "accepted" },
      });
      const result = await f.store.transitionWorkDelivery({ ...evidence, kind: "sent" });
      assert.equal(result.delivery.write_back, "sent");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "skipped");
      assert.equal((await f.store.transitionWorkDelivery({ ...base, kind: "cancel" })).delivery.write_back, "sent");
    });

    it("cancels a queued send without exposing it to a new worker", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const cancelled = await f.store.transitionWorkDelivery({ ...base, kind: "cancel" });
      assert.equal(cancelled.delivery.status, "acked");
      assert.equal(cancelled.delivery.write_back, "skipped");
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", force: true,
      })).outcome, "conflict");
    });

    it("freezes run obligations across restart and rejects changes to the snapshot", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.putRecipe({ ...f.recipe, can_write_back: false, write_back_thread_id: "other:room" });
      await f.reopen();
      assert.deepEqual((await f.store.getWorkRun(ORG, f.run.id)).write_back_target, TARGET);
      for (const change of [
        { write_back_required: false, write_back_target: undefined },
        { write_back_target: { ...TARGET, installation_id: "replacement" } },
        { trigger_kind: "manual" },
      ]) {
        await assert.rejects(f.store.putWorkRun({ ...f.run, ...change }), /immutable/);
      }
      const reordered = await f.store.putWorkRun({
        ...f.run, write_back_target: { target: TARGET.target, source: TARGET.source, installation_id: TARGET.installation_id },
      });
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_run: reordered, can_write_back: false, trigger_kind: "manual",
      })).outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.run_id, f.run.id);
      assert.equal(delivery.kind, "push");
      assert.deepEqual(delivery.target, TARGET);
    });

    it("keeps explicitly local runs local even when the recipe later enables write-back", async (t) => {
      const f = await fixture(t, driver, { write_back_required: false, trigger_kind: "push" });
      await f.reopen();
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("keeps independent immutable deliveries for identical results from distinct runs", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.commitWorkObservation(f.input);
      const first = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      for (const change of [
        { payload: { summary: "Changed" } },
        { idempotency_key: "replacement" },
        { target: { ...TARGET, target: "another" } },
        { run_id: undefined },
        { work_item_id: "other" },
      ]) {
        await assert.rejects(f.store.putWorkDelivery({ ...first, ...change }), /immutable|must belong/);
      }
      await assert.rejects(f.store.putWorkDelivery({ ...first, id: "duplicate" }));
      await f.store.putWorkDelivery({ ...first, status: "acked", write_back: "sent" });
      await f.store.putWorkItem({ ...await f.store.getWorkItem(ORG, f.item.id), status: "open" });
      assert.equal(await f.store.claimWorkRunStart({
        run: { ...f.run, id: "run-2", status: "running", start_state: "pending" },
      }), true);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, "run-2");
      const observe = { ...f.input, expected_item: item, expected_run: run };
      await f.store.commitWorkObservation(observe);
      const second = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(second.run_id, "run-2");
      assert.notEqual(first.id, second.id);
      assert.notEqual(first.idempotency_key, second.idempotency_key);
      await f.store.commitWorkObservation({
        ...observe,
        expected_item: await f.store.getWorkItem(ORG, f.item.id),
        expected_run: await f.store.getWorkRun(ORG, run.id),
      });
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 2);
      assert.equal((await f.store.getWorkDeliveryByItem(ORG, f.item.id)).id, second.id);
      await f.store.putWorkDelivery({
        ...await f.store.getWorkDelivery(ORG, first.id),
        channel_receipt: { accepted: true, channel_message_ids: ["original-message"] },
      });
      assert.deepEqual(await f.store.getWorkDelivery(ORG, second.id), second);
      await f.reopen();
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 2);
    });

    it("blocks another execution until all historical deliveries have closed", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      await f.store.putWorkItem({ ...await f.store.getWorkItem(ORG, f.item.id), status: "open" });
      const next = { ...f.run, id: "run-2", status: "running", start_state: "pending" };
      for (const status of ["queued", "write_back", "dead"]) {
        await f.store.putWorkDelivery({ ...delivery, status });
        assert.equal(await f.store.claimWorkRunStart({ run: next }), false);
      }
      await f.store.putWorkDelivery({ ...delivery, status: "acked", write_back: "sent" });
      assert.equal(await f.store.claimWorkRunStart({ run: next }), true);
    });

    it("commits the completed run, work status and queued delivery together", async (t) => {
      const f = await fixture(t, driver);
      const result = await f.store.commitWorkObservation(f.input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.changed, true);
      assert.equal(result.transition.settled, true);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).status, "completed");
      const savedRun = await f.store.getWorkRun(ORG, f.run.id);
      const savedItem = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(savedRun.status, "completed");
      assert.equal(savedRun.version, f.run.version + 1);
      assert.equal(savedItem.status, "done");
      assert.equal(savedItem.version, f.item.version + 1);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.status, "queued");
      assert.equal(delivery.payload.summary, "Handled");
      assert.equal(delivery.recipe_id, f.recipe.id);
    });

    it("does not apply an observation whose item snapshot was superseded", async (t) => {
      const f = await fixture(t, driver);
      const changed = await f.store.putWorkItem({ ...f.item, status: "waiting_human" });
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
      const changed = await f.store.putWorkRun({ ...f.run, result: { summary: "A newer observation" } });
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "conflict", reason: "stale_observation",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), changed);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("freezes the full completed result through ordinary puts without touching work or delivery", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1", "event-2"],
      };
      await f.store.commitWorkObservation(f.input);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const deliveries = await f.store.listWorkDeliveries(ORG);
      for (const result of [
        undefined,
        { ...run.result, summary: "Corrected" },
        { ...run.result, content: [{ role: "body", media_type: "text/plain", text: "Changed" }] },
        { ...run.result, evidence_event_ids: ["event-2", "event-1"] },
        { summary: run.result.summary },
      ]) {
        await assert.rejects(f.store.putWorkRun({ ...run, result }),
          /Completed work results are immutable/);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      }
      await assert.rejects(f.store.putWorkRun(f.run), /Terminal work run status is immutable/);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), deliveries);
      await f.reopen();
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
    });

    it("permits non-result metadata updates and semantically equal completed results", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1"],
      };
      await f.store.commitWorkObservation(f.input);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const deliveries = await f.store.listWorkDeliveries(ORG);
      const metadata = await f.store.putWorkRun({
        ...run,
        agent_thread_id: "executor:recovered",
        updated_at: "2026-11-09T08:03:00.000Z",
        result: {
          evidence_event_ids: ["event-1"],
          content: [{ text: "Original", media_type: "text/plain", role: "body" }],
          summary: "Handled",
        },
      });
      assert.equal(metadata.version, run.version + 1);
      assert.equal(metadata.agent_thread_id, "executor:recovered");
      assert.deepEqual(metadata.result, run.result);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), metadata);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), deliveries);
    });

    it("does not backfill an unknown result after direct historical completion", async (t) => {
      const f = await fixture(t, driver);
      const historical = await f.store.putWorkRun({ ...f.run, status: "completed", result: undefined });
      await assert.rejects(f.store.putWorkRun({
        ...historical, result: { summary: "Guessed historical result" },
      }), /Completed work results are immutable/);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), historical);
    });

    for (const terminal of ["completed", "failed", "cancelled"]) {
      it(`does not change ${terminal} through ordinary puts, but allows a separate attempt`, async (t) => {
        const f = await fixture(t, driver);
        const run = await f.store.putWorkRun({
          ...f.run, status: terminal, start_state: undefined, result: { summary: "Original" },
        });
        for (const status of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
          if (status === terminal) continue;
          await assert.rejects(f.store.putWorkRun({ ...run, status }),
            /Terminal work run status is immutable/);
        }
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
        await f.store.putWorkItem({ ...await f.store.getWorkItem(ORG, f.item.id), status: "open" });
        assert.equal(await f.store.claimWorkRunStart({
          run: { ...f.run, id: "run-2", status: "running", start_state: "pending" },
        }), true);
        assert.equal((await f.store.getActiveWorkRun(ORG, f.item.id)).id, "run-2");
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      });
    }

    for (const inserting of [false, true]) {
      it(`serializes competing completed results on ${inserting ? "insert" : "update"}`, async (t) => {
        const f = await fixture(t, driver);
        const id = inserting ? "new-completed-run" : f.run.id;
        const results = await Promise.allSettled(["First", "Second"].map((summary) =>
          f.store.putWorkRun({ ...f.run, id, status: "completed", result: { summary } })));
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        const winner = results.find((result) => result.status === "fulfilled").value;
        assert.deepEqual(await f.store.getWorkRun(ORG, id), winner);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      });
    }

    it("does not expose persisted completed results through mutable reads", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1"],
      };
      await f.store.commitWorkObservation(f.input);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      run.result.content[0].text = "Changed through read";
      run.result.evidence_event_ids.push("event-2");
      delivery.payload.content[0].text = "Changed delivery through read";
      const storedRun = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal(storedRun.result.content[0].text, "Original");
      assert.deepEqual(storedRun.result.evidence_event_ids, ["event-1"]);
      assert.equal(
        (await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload.content[0].text,
        "Original",
      );
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

    it("does not let an old completed attempt settle the item after a newer run starts", async (t) => {
      const f = await fixture(t, driver);
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const oldRun = await f.store.getWorkRun(ORG, f.run.id);
      const oldDelivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      await f.store.putWorkDelivery({ ...oldDelivery, status: "acked", write_back: "sent" });
      const reopened = await f.store.putWorkItem({
        ...await f.store.getWorkItem(ORG, f.item.id),
        status: "open",
        updated_at: LATER,
      });
      const newRun = {
        id: "run-2", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        executor_type: "test", status: "running", start_state: "pending",
        created_at: LATER, updated_at: LATER,
      };
      assert.equal(await f.store.claimWorkRunStart({ run: newRun }), true);
      await f.store.putWorkItem({ ...reopened, status: "running" });
      const currentItem = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(currentItem.current_run_id, newRun.id);
      assert.ok(currentItem.version > reopened.version);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: currentItem,
        expected_run: oldRun,
        handle: { status: "completed", external_run_id: oldRun.external_run_id, result: oldRun.result },
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "running");
      assert.equal((await f.store.getActiveWorkRun(ORG, f.item.id)).id, newRun.id);
      assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
    });

    it("keeps historical run identity unknown instead of guessing it from the only run", async (t) => {
      const f = await fixture(t, driver);
      const item = await f.store.putWorkItem({
        ...f.item,
        id: "legacy-work",
        thread_id: "source:legacy-conversation",
        unit_key: "legacy-unit",
        current_run_id: undefined,
        status: "running",
        version: 0,
      });
      const run = await f.store.putWorkRun({
        ...f.run,
        id: "legacy-run",
        work_item_id: item.id,
        version: 0,
      });
      assert.equal(item.current_run_id, undefined);
      assert.equal(run.version, 0);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.equal((await f.store.getWorkItem(ORG, item.id)).current_run_id, undefined);
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
    });

    it("rejects changes to completed summary, content and evidence even with current snapshots", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1", "event-2"],
      };
      await f.store.commitWorkObservation(f.input);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      for (const result of [
        { ...run.result, summary: "Corrected" },
        { ...run.result, content: [{ role: "body", media_type: "text/plain", text: "Changed" }] },
        { ...run.result, evidence_event_ids: ["event-2", "event-1"] },
        { summary: "Handled" },
      ]) {
        assert.deepEqual(await f.store.commitWorkObservation({
          ...f.input, expected_item: item, expected_run: run,
          handle: { ...f.input.handle, result },
        }), { outcome: "conflict", reason: "completed_result_changed" });
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
        assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
      }
    });

    it("does not replace or abandon delivery evidence on duplicate completion", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      for (const [status, write_back] of [
        ["queued", "pending"], ["write_back", "pending"], ["dead", "failed"],
        ["acked", "sent"], ["acked", "skipped"],
      ]) {
        const recorded = {
          ...delivery, status, write_back, attempts: 2,
          channel_receipt: { accepted: true, rpc_id: "receipt-1" },
          last_error: "Previous attempt evidence",
        };
        await f.store.putWorkDelivery(recorded);
        for (const can_write_back of [false, true]) {
          for (const result of [undefined, f.input.handle.result]) {
            const item = await f.store.getWorkItem(ORG, f.item.id);
            const run = await f.store.getWorkRun(ORG, f.run.id);
            const repeated = await f.store.commitWorkObservation({
              ...f.input, expected_item: item, expected_run: run, can_write_back,
              handle: { ...f.input.handle, result },
            });
            assert.equal(repeated.outcome, "applied");
            assert.equal(repeated.transition.changed, false);
            assert.deepEqual(repeated.transition.delivery, { kind: "keep" });
            assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), recorded);
          }
        }
      }
    });

    it("does not invent delivery obligations or unknown results for historical completed work", async (t) => {
      const f = await fixture(t, driver);
      const item = await f.store.putWorkItem({ ...f.item, status: "done" });
      const run = await f.store.putWorkRun({ ...f.run, status: "completed", start_state: undefined });
      const repeated = await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { ...f.input.handle, result: undefined },
      });
      assert.equal(repeated.outcome, "applied");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).result, undefined);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: await f.store.getWorkItem(ORG, f.item.id),
        expected_run: await f.store.getWorkRun(ORG, f.run.id),
      }), { outcome: "conflict", reason: "completed_result_changed" });
    });

    it("uses the last known result when the first completed observation omits it", async (t) => {
      const f = await fixture(t, driver);
      const run = await f.store.putWorkRun({ ...f.run, result: { summary: "Known result" } });
      const result = await f.store.commitWorkObservation({
        ...f.input, expected_run: run,
        handle: { ...f.input.handle, result: undefined },
      });
      assert.equal(result.outcome, "applied");
      assert.deepEqual((await f.store.getWorkRun(ORG, f.run.id)).result, run.result);
      assert.deepEqual((await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload, run.result);
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

    for (const status of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
      it(`records actual ${status} after dismissal without changing ignored item or delivery evidence`, async (t) => {
        const f = await fixture(t, driver, {
          write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
        });
        const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
          org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
          unit_key: f.item.unit_key, run_id: f.run.id, target: TARGET,
          payload: { summary: "Existing evidence" }, now: NOW,
        }));
        const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
        const stopped = await f.store.getWorkDelivery(ORG, delivery.id);
        const input = { ...f.input, expected_item: dismissed.item, handle: { ...f.input.handle, status } };
        const result = await f.store.commitWorkObservation(input);
        assert.equal(result.outcome, "applied");
        assert.deepEqual(result.transition.item, dismissed.item);
        assert.deepEqual(result.transition.delivery, { kind: "keep" });
        assert.equal(result.transition.run.status, status);
        assert.equal(result.transition.run.version, f.run.version + 1);
        assert.equal(result.transition.run.result.summary, "Handled");
        assert.equal(result.transition.run.write_back_required, true);
        assert.deepEqual(result.transition.run.write_back_target, TARGET);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), stopped);
        assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), result.transition.run);
        const repeated = await f.store.commitWorkObservation({
          ...input, expected_run: result.transition.run,
        });
        assert.equal(repeated.outcome, "applied");
        assert.equal(repeated.transition.changed, false);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), stopped);
        if (status === "completed") {
          assert.deepEqual(await f.store.commitWorkObservation({
            ...input, expected_run: repeated.transition.run,
            handle: { ...input.handle, result: { summary: "Changed after completion" } },
          }), { outcome: "conflict", reason: "completed_result_changed" });
        }
      });
    }

    it("allows explicit retry only after an ignored execution's actual terminal outcome is committed", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const claim = {
        expected_item: dismissed.item, retry: "manual",
        run: { ...f.run, id: "successor", status: "running", start_state: "pending" },
      };
      assert.equal(await f.store.claimWorkRunStart(claim), false);
      const result = await f.store.commitWorkObservation({ ...f.input, expected_item: dismissed.item });
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.run.status, "completed");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
      assert.equal(await f.store.claimWorkRunStart(claim), true);
      const successor = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(successor.current_run_id, "successor");
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: dismissed.item, expected_run: result.transition.run,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), successor);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), result.transition.run);
    });

    it("refuses ambiguous or different execution identities on ignored work", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      for (const fields of [
        { external_run_id: undefined }, { external_run_id: "different-execution" },
        { start_state: "pending" }, { start_state: "uncertain" },
      ]) {
        const run = await f.store.putWorkRun({ ...f.run, ...fields });
        const result = await f.store.commitWorkObservation({
          ...f.input, expected_item: dismissed.item, expected_run: run,
        });
        assert.deepEqual(result, { outcome: "conflict", reason: "execution_identity_unknown" });
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      }
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
    it("does not create work when its recipe update is rejected", async (t) => {
      const f = await fixture(t, driver);
      const expected = await f.store.getRecipe(ORG, f.recipe.id);
      const input = creationInput(f, {
        recipe: { ...expected, executor_config: { prompt: "New configuration" } },
        expected_recipe: expected,
      });
      input.item.recipe_id = expected.id;
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_creation_recipe BEFORE UPDATE ON recipes
          BEGIN SELECT RAISE(ABORT, 'recipe update rejected'); END`);
        await assert.rejects(f.store.createWorkItem(input), /recipe update rejected/);
        assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
        assert.deepEqual(await f.store.getRecipe(ORG, expected.id), expected);
      } finally {
        db.close();
      }
    });

    for (const existing of [false, true]) {
      it(`rolls back ${existing ? "an updated" : "a new"} recipe if work creation fails`, async (t) => {
        const f = await fixture(t, driver);
        const input = creationInput(f);
        if (existing) {
          await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Original" }, created_at: NOW, updated_at: NOW });
          input.expected_recipe = await f.store.getRecipe(ORG, input.recipe.id);
        }
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_creation BEFORE INSERT ON work_items
            BEGIN SELECT RAISE(ABORT, 'creation rejected'); END`);
          await assert.rejects(f.store.createWorkItem(input), /creation rejected/);
          await f.reopen();
          assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
          assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), input.expected_recipe);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        } finally {
          db.close();
        }
      });
    }

    for (const table of ["search_answers", "work_items"]) {
      it(`rolls back the complete timeout when the ${table} write fails`, async (t) => {
        const f = await timeoutFixture(t, driver);
        const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
          org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
          unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
        }));
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_timeout BEFORE UPDATE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'timeout rejected'); END`);
          await assert.rejects(f.store.dismissWorkItem(f.timeout), /timeout rejected/);
          await f.reopen();
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
          assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
          assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
          assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
        } finally {
          db.close();
        }
      });
    }

    it("preserves ignored work and run facts when actual-outcome persistence fails", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_ignored_result BEFORE UPDATE ON work_runs
          BEGIN SELECT RAISE(ABORT, 'ignored result rejected'); END`);
        await assert.rejects(f.store.commitWorkObservation({
          ...f.input, expected_item: dismissed.item,
        }), /ignored result rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      } finally {
        db.close();
      }
    });

    it("rolls back delivery stop requests if the dismissal item update fails", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await f.store.putWorkDelivery(enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_dismissal BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'dismissal rejected'); END`);
        await assert.rejects(f.store.dismissWorkItem({ expected_item: f.item, now: LATER }), /dismissal rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      } finally {
        db.close();
      }
    });

    it("rolls back preflight failure history if the item write fails", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "open" });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_preflight BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'preflight item write rejected'); END`);
        await assert.rejects(f.store.recordWorkRunStartFailure({
          expected_item: item, mode: "automatic",
          run: {
            id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
            executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
            write_back_required: false, created_at: LATER, updated_at: LATER,
          },
        }), /preflight item write rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "preflight-failure"), null);
      } finally {
        db.close();
      }
    });

    it("rolls back both rule rebinding and new run on failure", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "done" });
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_binding BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'binding rejected'); END`);
        await assert.rejects(f.store.claimWorkRunStart({
          expected_item: item, retry: "manual", rebind: "manual",
          run: { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" },
        }), /binding rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "trial-run"), null);
      } finally {
        db.close();
      }
    });

    it("rolls back a retry run if the final item update fails, without an intermediate open state", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_retry BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'retry item write rejected'); END`);
        await assert.rejects(f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        }), /retry item write rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "retry-run"), null);
        db.exec("DROP TRIGGER reject_retry");
        db.exec(`CREATE TRIGGER reject_intermediate_open BEFORE UPDATE ON work_items
          WHEN NEW.status = 'open' BEGIN SELECT RAISE(ABORT, 'intermediate open forbidden'); END`);
        assert.equal(await f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        }), true);
      } finally {
        db.close();
      }
    });

    for (const kind of ["failed", "uncertain"]) {
      it(`rolls back the ${kind} checkpoint if the item write fails`, async (t) => {
        const { f, input } = await startCheckpointFixture(t, driver);
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_start_checkpoint BEFORE UPDATE ON work_items
            BEGIN SELECT RAISE(ABORT, 'checkpoint write rejected'); END`);
          await assert.rejects(f.store.checkpointWorkRunStart({
            ...input, kind, error: "Start error",
          }), /checkpoint write rejected/);
          assert.deepEqual(await f.store.getWorkRun(ORG, input.expected_run.id), input.expected_run);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), input.expected_item);
          db.exec("DROP TRIGGER reject_start_checkpoint");
          assert.equal((await f.store.checkpointWorkRunStart({
            ...input, kind, error: "Start error",
          })).outcome, "applied");
        } finally {
          db.close();
        }
      });
    }

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
  const f = await fixture(t, driver, {
    write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
  });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([
    f.store.commitWorkObservation(f.input),
    second.commitWorkObservation(f.input),
  ]);
  assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
  assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
  assert.equal((await second.listWorkDeliveries(ORG)).length, 1);
  const delivery = await second.getWorkDeliveryByItem(ORG, f.item.id);
  const resultsOfClaim = await Promise.all([f.store, second].map((store) =>
    store.transitionWorkDelivery({
      org_id: ORG, delivery_id: delivery.id, owner: "same-worker", kind: "claim", now: LATER,
    })));
  assert.equal(resultsOfClaim.filter((row) => row.outcome === "applied").length, 1);
});

it("freezes completed results across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.allSettled([f.store, second].map((store, index) =>
    store.putWorkRun({
      ...f.run, status: "completed", result: { summary: `Worker ${index}` },
    })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const winner = results.find((result) => result.status === "fulfilled").value;
  assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), winner);
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), winner);
  await assert.rejects(second.putWorkRun(f.run), /Terminal work run status is immutable/);
  assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
});

it("fences competing startup checkpoints across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const { f, input } = await startCheckpointFixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store) =>
    store.checkpointWorkRunStart({ ...input, kind: "uncertain", error: "Response lost" })));
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  assert.deepEqual(await second.getWorkItem(ORG, winner.item.id), winner.item);
  assert.deepEqual(await second.getWorkRun(ORG, winner.run.id), winner.run);
});

it("fences item creation across independent SQLite writer workers without leaking recipes", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = creationInput(f);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const competing = {
    ...input, recipe: { ...input.recipe, id: "losing-recipe" },
    item: { ...input.item, recipe_id: "losing-recipe" },
  };
  const results = await Promise.all([
    f.store.createWorkItem(input), second.createWorkItem(competing),
  ]);
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  const loser = results[0].outcome === "applied" ? competing : input;
  assert.deepEqual(await second.getWorkItem(ORG, input.item.id), winner.item);
  assert.deepEqual(await second.getRecipe(ORG, winner.recipe.id), winner.recipe);
  assert.equal(await second.getRecipe(ORG, loser.recipe.id), null);
});

it("allows distinct work to share a concurrently created equivalent recipe across SQLite writers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = creationInput(f);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([
    f.store.createWorkItem(input),
    second.createWorkItem({ ...input, item: { ...input.item, id: "second-created-item", unit_key: "second-created-unit" } }),
  ]);
  assert.equal(results.every((result) => result.outcome === "applied"), true);
  assert.deepEqual(results[0].recipe, results[1].recipe);
  for (const result of results) assert.deepEqual(await second.getWorkItem(ORG, result.item.id), result.item);
});

it("fences timeout and human cancellation across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await timeoutFixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [timeout, cancel] = await Promise.all([
    f.store.dismissWorkItem(f.timeout),
    second.dismissWorkItem({ expected_item: f.item, now: LATER }),
  ]);
  assert.equal(Number(timeout.outcome === "applied") + Number(cancel.outcome === "applied"), 1);
  const item = await second.getWorkItem(ORG, f.item.id);
  const record = await second.getSearchAnswer(ORG, f.record.id);
  assert.equal(item.status, "skipped");
  assert.equal(item.version, f.item.version + 1);
  assert.equal(record.outcome, timeout.outcome === "applied" ? "timed_out" : undefined);
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), f.run);
});

it("fences conflicting actual outcomes for ignored work across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.commitWorkObservation({
      ...f.input, expected_item: dismissed.item,
      handle: { ...f.input.handle, status: index === 0 ? "completed" : "cancelled" },
    })));
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), winner.transition.run);
  assert.deepEqual(await second.getWorkItem(ORG, f.item.id), dismissed.item);
  assert.deepEqual(await second.listWorkDeliveries(ORG), []);
});

it("fences dismissal against retries across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
  const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [dismissed, started] = await Promise.all([
    f.store.dismissWorkItem({ expected_item: item, now: LATER }),
    second.claimWorkRunStart({
      expected_item: item, retry: "manual",
      run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
    }),
  ]);
  assert.equal(Number(dismissed.outcome === "applied") + Number(started), 1);
  const saved = await second.getWorkItem(ORG, item.id);
  assert.equal(saved.version, item.version + 1);
  assert.equal(saved.status, started ? "running" : "skipped");
  assert.equal(saved.current_run_id, started ? "real-start" : f.run.id);
});

it("fences preflight failures against a real start across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
  const item = await f.store.putWorkItem({ ...f.item, status: "open" });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [failure, started] = await Promise.all([
    f.store.recordWorkRunStartFailure({
      expected_item: item, mode: "manual",
      run: {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      },
    }),
    second.claimWorkRunStart({
      expected_item: item,
      run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
    }),
  ]);
  assert.equal(Number(failure.outcome === "applied") + Number(started), 1);
  assert.equal((await second.getWorkItem(ORG, item.id)).version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("fences manual and automatic retries across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
  const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.claimWorkRunStart({
      expected_item: item, retry: index === 0 ? "manual" : "automatic",
      run: { ...f.run, id: `retry-${index}`, status: "running", start_state: "pending" },
    })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await second.getWorkItem(ORG, item.id)).version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("fences competing rule selections across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  await f.store.putWorkRun({ ...f.run, status: "failed", start_state: undefined });
  const item = await f.store.putWorkItem({ ...f.item, status: "failed" });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  for (const id of ["selected-0", "selected-1"]) {
    await f.store.putRecipe({ ...f.recipe, id });
  }
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.claimWorkRunStart({
      expected_item: item, retry: "manual", rebind: "manual",
      run: { ...f.run, id: `trial-${index}`, recipe_id: `selected-${index}`, status: "running", start_state: "pending" },
    })));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.indexOf(true);
  const saved = await second.getWorkItem(ORG, item.id);
  assert.equal(saved.recipe_id, `selected-${winner}`);
  assert.equal(saved.current_run_id, `trial-${winner}`);
  assert.equal(saved.version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("migrates the v57 delivery table without changing request identities or inventing snapshots", async (t) => {
  const root = join(process.cwd(), `.test-work-ledger-migration-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  let store;
  t.after(async () => {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = new Database(path);
  db.function("conversation_id", (source, externalId, fallbackId) =>
    conversationId(source, externalId, fallbackId));
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= 57)) {
    db.exec(migration.sql);
  }
  db.prepare(`INSERT INTO work_items (
    id, org_id, thread_id, unit_key, record_class, thread_facet, status, created_at, updated_at
  ) VALUES ('legacy-work', ?, 'source:legacy', 'unit', 'task', 'ticket', 'done', ?, ?)`).run(ORG, NOW, NOW);
  db.prepare(`INSERT INTO work_runs (
    id, org_id, work_item_id, recipe_id, executor_type, status, created_at, updated_at
  ) VALUES ('legacy-run', ?, 'legacy-work', 'rule', 'test', 'completed', ?, ?)`).run(ORG, NOW, NOW);
  db.prepare(`INSERT INTO work_deliveries (
    id, org_id, work_item_id, recipe_id, kind, unit_key, status, write_back, attempts,
    payload_json, idempotency_key, channel_receipt_json, created_at, updated_at
  ) VALUES ('legacy-delivery', ?, 'legacy-work', 'rule', 'push', 'unit', 'acked', 'sent', 1,
    '{"summary":"Original result"}', 'original-key', '{"accepted":true,"rpc_id":"original-receipt"}', ?, ?)`)
    .run(ORG, NOW, NOW);
  const before = db.prepare("SELECT * FROM work_deliveries").get();
  db.pragma("user_version = 57");
  db.close();
  store = new SqliteAuthorityStore(path);
  const inspect = new Database(path, { readonly: true });
  try {
    const after = inspect.prepare("SELECT * FROM work_deliveries").get();
    for (const [field, value] of Object.entries(before)) assert.deepEqual(after[field], value);
    assert.equal(after.run_id, null);
    assert.equal(after.target_json, null);
    assert.equal(inspect.prepare("SELECT count(*) AS total FROM work_deliveries").get().total, 1);
    assert.deepEqual(inspect.prepare("SELECT write_back_required, write_back_target_json, trigger_kind FROM work_runs").get(),
      { write_back_required: null, write_back_target_json: null, trigger_kind: null });
    assert.deepEqual(inspect.pragma("foreign_key_check"), []);
  } finally {
    inspect.close();
  }
});

it("migrates schema 56 without inferring historical current-run identity", async (t) => {
  const root = join(process.cwd(), `.test-work-migration-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  let store = new SqliteAuthorityStore(path);
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.putWorkItem({
    id: "legacy-work", org_id: ORG, thread_id: "source:legacy",
    unit_key: "legacy-unit", record_class: "task", thread_facet: "ticket",
    status: "done", created_at: NOW, updated_at: NOW,
  });
  await store.putWorkRun({
    id: "legacy-run", org_id: ORG, work_item_id: "legacy-work",
    recipe_id: "legacy-recipe", executor_type: "test", status: "completed",
    created_at: NOW, updated_at: NOW,
  });
  for (const [id, count, status] of [
    ["single-active", 1, "running"],
    ["ambiguous-active", 2, "running"],
    ["single-waiting", 1, "waiting_human"],
    ["terminal-only", 1, "failed"],
  ]) {
    await store.putWorkItem({
      id, org_id: ORG, thread_id: `source:${id}`, unit_key: id,
      record_class: "task", thread_facet: "ticket", status: "running",
      recipe_id: "legacy-recipe", created_at: NOW, updated_at: NOW,
    });
    for (let index = 0; index < count; index += 1) {
      await store.putWorkRun({
        id: `${id}-${index}`, org_id: ORG, work_item_id: id,
        recipe_id: "legacy-recipe", executor_type: "test", status,
        created_at: NOW, updated_at: NOW,
      });
    }
  }
  store.close();
  store = undefined;
  const db = new Database(path);
  db.exec(`
    ALTER TABLE work_items DROP COLUMN current_run_id;
    ALTER TABLE work_items DROP COLUMN version;
    ALTER TABLE work_runs DROP COLUMN version;
    ALTER TABLE work_runs DROP COLUMN write_back_required;
    ALTER TABLE work_runs DROP COLUMN write_back_target_json;
    ALTER TABLE work_runs DROP COLUMN trigger_kind;
    DROP INDEX work_runs_org_id_idx;
  `);
  db.pragma("user_version = 56");
  db.close();
  store = new SqliteAuthorityStore(path);
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual(await store.getWorkItem(ORG, "legacy-work"), {
    id: "legacy-work", org_id: ORG, thread_id: "source:legacy",
    unit_key: "legacy-unit", head_event_id: undefined, record_class: "task",
    thread_facet: "ticket", status: "done", recipe_id: undefined,
    current_run_id: undefined, version: 0, created_at: NOW, updated_at: NOW,
  });
  assert.equal((await store.getWorkRun(ORG, "legacy-run")).version, 0);
  for (const id of ["single-active", "single-waiting"]) {
    assert.equal((await store.getWorkItem(ORG, id)).current_run_id, `${id}-0`);
    assert.equal((await store.getActiveWorkRun(ORG, id)).id, `${id}-0`);
  }
  for (const id of ["ambiguous-active", "terminal-only"]) {
    assert.equal((await store.getWorkItem(ORG, id)).current_run_id, undefined);
    assert.equal(await store.getActiveWorkRun(ORG, id), null);
  }
});
