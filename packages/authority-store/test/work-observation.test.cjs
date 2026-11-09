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
const { MIGRATIONS } = require("../dist/sqlite/migrations");

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

for (const driver of drivers) {
  describe(`${driver.name} atomic work observation`, { skip: driver.skip }, () => {
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
  assert.equal(store.schemaVersion, 58);
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
