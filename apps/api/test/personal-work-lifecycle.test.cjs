const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryWorkStore, enqueueWriteBack } = require("@regenic/domain");
const { PersonalWorkSupervise } = require("../dist/personal-work-supervise");
const { foldFinishedWorkThreads } = require("../dist/personal-work-lifecycle");
const { preferThread, preferredThreadId } = require("../dist/personal-pull-status");

const NOW = "2026-11-09T08:00:00.000Z";
const ORG = "test-owner";

async function fixture(options = {}) {
  const authority = new MemoryWorkStore();
  const prefs = new Map();
  const writes = [];
  authority.getConversationPref = async (org, thread) => {
    assert.equal(org, ORG);
    return prefs.get(thread) ?? null;
  };
  authority.putConversationPref = async (patch) => {
    writes.push(patch);
    const pref = { ...prefs.get(patch.thread_id), ...patch };
    prefs.set(patch.thread_id, pref);
    return pref;
  };
  const recipe = {
    id: options.system ? "system:background:test" : "recipe-1",
    org_id: ORG,
    name: "Handle work",
    match: { record_class: "task" },
    trigger: { kind: "push" },
    executor_type: "test",
    executor_config: {},
    can_write_back: options.writeBack ?? true,
    include_context: false,
    enabled: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const initialItem = {
    id: "work-1",
    org_id: ORG,
    thread_id: "source:conversation",
    unit_key: "unit-1",
    record_class: "task",
    thread_facet: "ticket",
    status: "open",
    recipe_id: recipe.id,
    created_at: NOW,
    updated_at: NOW,
  };
  const initialRun = {
    id: "run-1",
    org_id: ORG,
    work_item_id: initialItem.id,
    recipe_id: recipe.id,
    executor_type: "test",
    external_run_id: "external-1",
    agent_thread_id: "executor:conversation",
    status: "running",
    start_state: "pending",
    ...(options.frozen ? { write_back_required: false, trigger_kind: "push" } : {}),
    created_at: NOW,
    updated_at: NOW,
  };
  await authority.putRecipe(recipe);
  await authority.putWorkItem(initialItem);
  assert.equal(await authority.claimWorkRunStart({ run: initialRun }), true);
  const item = await authority.getWorkItem(ORG, initialItem.id);
  let run = await authority.getWorkRun(ORG, initialRun.id);
  run = await authority.putWorkRun({
    ...run,
    external_run_id: "external-1",
    agent_thread_id: "executor:conversation",
    start_state: "submitted",
  });
  const dropped = [];
  let digestChanges = 0;
  const updated = [];
  const runtime = {
    requireHost: () => ({ get: (name) => {
      assert.equal(name, "authority");
      return authority;
    } }),
  };
  const supervisor = new PersonalWorkSupervise(
    runtime, {}, () => { digestChanges += 1; }, (id) => updated.push(id),
  );
  supervisor.bindWaits({ drop: (id) => dropped.push(id) });
  const handle = (status = "completed", extra = {}) => ({
    status,
    external_run_id: run.external_run_id,
    agent_thread_id: run.agent_thread_id,
    result: { summary: "Handled" },
    ...extra,
  });
  const delivery = () => enqueueWriteBack({
    org_id: ORG,
    work_item_id: item.id,
    recipe_id: recipe.id,
    kind: "push",
    unit_key: item.unit_key,
    payload: { summary: "Earlier result" },
    now: NOW,
  });
  return {
    authority, prefs, writes, recipe, item, run, supervisor, dropped, updated,
    handle, delivery, digestChanges: () => digestChanges,
  };
}

describe("work observation compatibility before RFC 0011 policy activation", () => {
  for (const status of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
    it(`records an ignored run's ${status} facts without folding, sending or restoring follow priority`, async () => {
      const f = await fixture();
      const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
      await f.supervisor.applyHandle(dismissed.item, f.recipe, f.run, f.handle(status));
      const run = await f.authority.getWorkRun(ORG, f.run.id);
      assert.equal(run.status, status);
      assert.equal(run.result.summary, "Handled");
      assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), dismissed.item);
      assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
      assert.deepEqual(f.dropped, [f.run.id]);
      assert.deepEqual(f.updated, [f.item.id]);
      assert.equal(f.writes.length, 0);
      assert.equal(f.digestChanges(), 0);
    });
  }

  it("polls known ignored runs after restart without attaching waits or reaping; stops after actual exit", async () => {
    const f = await fixture({ frozen: true });
    await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
    await f.authority.deleteRecipe(ORG, f.recipe.id);
    const ignored = await f.authority.getWorkItem(ORG, f.item.id);
    let status = "running";
    let polls = 0;
    const executor = {
      status: async () => { polls++; return f.handle(status); },
    };
    const runtime = {
      orgId: () => ORG,
      requireHost: () => ({ get: (name) => ({
        authority: f.authority, executors: { get: () => executor },
      })[name] }),
    };
    const supervisor = new PersonalWorkSupervise(runtime, {
      contextFor: () => ({ org_id: ORG }),
      inspectSysout: () => { throw new Error("Ignored runs must not be reaped"); },
    });
    const dropped = [];
    supervisor.bindWaits({
      drop: (id) => dropped.push(id),
      attach: () => { throw new Error("Ignored runs must not regain wait priority"); },
      followSysout: () => { throw new Error("Ignored runs must not be followed"); },
    });
    await supervisor.refreshRuns();
    assert.equal(polls, 1);
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "running");
    status = "completed";
    await supervisor.refreshRuns();
    assert.equal(polls, 2);
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "completed");
    await supervisor.refreshRuns();
    assert.equal(polls, 2);
    assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), ignored);
    assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(dropped, [f.run.id, f.run.id]);
  });

  for (const start_state of ["pending", "uncertain"]) {
    it(`does not query an ignored ${start_state} start as a confirmed execution`, async () => {
      const f = await fixture();
      const run = await f.authority.putWorkRun({ ...f.run, start_state });
      const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
      const supervisor = new PersonalWorkSupervise({
        requireHost: () => { throw new Error("Must not query an unconfirmed start"); },
      }, {});
      await supervisor.refreshOne(dismissed.item, f.recipe, run);
      assert.deepEqual(await f.authority.getWorkRun(ORG, run.id), run);
      assert.equal(f.writes.length, 0);
    });
  }

  it("does not apply an ignored observation to the successor started during its status query", async () => {
    const f = await fixture();
    const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
    const runtime = {
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({
          status: async () => {
            await f.authority.putWorkRun({ ...f.run, status: "completed", result: { summary: "Known result" } });
            assert.equal(await f.authority.claimWorkRunStart({
              expected_item: dismissed.item, retry: "manual",
              run: { ...f.run, id: "successor", status: "running", start_state: "pending" },
            }), true);
            return f.handle();
          },
        }) },
      })[name] }),
    };
    const supervisor = new PersonalWorkSupervise(runtime, { contextFor: () => ({ org_id: ORG }) });
    await assert.rejects(supervisor.refreshOne(dismissed.item, f.recipe, f.run),
      (error) => error.code === "execution_observation_conflict");
    const current = await f.authority.getWorkItem(ORG, f.item.id);
    assert.equal(current.current_run_id, "successor");
    assert.equal(current.status, "running");
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).result.summary, "Known result");
    assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
  });

  it("logs an ignored status query failure and preserves its last known execution facts", async (t) => {
    const f = await fixture();
    const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
    const logged = t.mock.method(console, "error", () => {});
    const supervisor = new PersonalWorkSupervise({
      orgId: () => ORG,
      requireHost: () => ({ get: (name) => ({
        authority: f.authority, executors: { get: () => ({
          status: async () => { throw new Error("Status unavailable"); },
        }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await supervisor.refreshRuns();
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), dismissed.item);
    assert.deepEqual(await f.authority.getWorkRun(ORG, f.run.id), f.run);
    assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
  });

  it("completes work, queues its result, and folds both conversations before delivery", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(run.status, "completed");
    assert.equal(run.start_state, undefined);
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "done");
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    assert.equal(delivery.status, "queued");
    assert.equal(delivery.write_back, "pending");
    assert.equal(delivery.payload.summary, "Handled");
    assert.deepEqual(f.writes.map((p) => [p.thread_id, p.hidden, p.hidden_reason]), [
      [f.item.thread_id, true, "policy"],
      [f.run.agent_thread_id, true, "policy"],
    ]);
    assert.deepEqual(f.dropped, [f.run.id]);
    assert.deepEqual(f.updated, [f.item.id]);
    assert.equal(f.digestChanges(), 1);
  });

  it("keeps the existing failure-fold behavior during the structural migration", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle("failed"));
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "failed");
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "failed");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.dropped, [f.run.id]);
  });

  it("records an executor-confirmed cancellation without leaving a running attempt behind", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle("cancelled"));
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "cancelled");
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.deepEqual(f.dropped, [f.run.id]);
  });

  for (const [status, itemStatus] of [["running", "running"], ["waiting_human", "waiting_human"]]) {
    it(`keeps ${status} work visible and followed without touching pending deliveries`, async () => {
      const f = await fixture();
      const delivery = f.delivery();
      await f.authority.putWorkDelivery(delivery);
      await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle(status));
      assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, status);
      assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, itemStatus);
      assert.deepEqual(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), delivery);
      assert.equal(f.writes.length, 0);
      assert.deepEqual(f.dropped, []);
      assert.equal(f.digestChanges(), 0);
    });
  }

  it("does not enqueue a result when write-back is disabled", async () => {
    const f = await fixture({ writeBack: false });
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 2);
  });

  it("honors a trial override and abandons an unacknowledged delivery", async () => {
    const f = await fixture();
    await f.authority.putWorkDelivery(f.delivery());
    f.supervisor.setWriteBackOverride(f.item.id, false);
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    assert.equal(delivery.status, "acked");
    assert.equal(delivery.write_back, "skipped");
    assert.equal(f.supervisor.allowsWriteBack(f.item.id, f.recipe), true);
  });

  it("preserves acknowledged deliveries when completion does not request write-back", async () => {
    const f = await fixture({ writeBack: false });
    const delivery = { ...f.delivery(), status: "acked", write_back: "sent" };
    await f.authority.putWorkDelivery(delivery);
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    assert.deepEqual(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), delivery);
  });

  it("cleans up system work without folding either conversation or refreshing its list", async () => {
    const f = await fixture({ system: true });
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    assert.deepEqual(f.dropped, [f.run.id]);
    assert.deepEqual(f.updated, [f.item.id]);
    assert.equal(f.writes.length, 0);
    assert.equal(f.digestChanges(), 0);
  });

  it("retains a known executor thread and previous result when absent from the observation", async () => {
    const f = await fixture();
    const run = { ...f.run, result: { summary: "Earlier result" } };
    const savedRun = await f.authority.putWorkRun(run);
    await f.supervisor.applyHandle(
      f.item, f.recipe, savedRun, f.handle("running", { agent_thread_id: undefined, result: undefined }),
    );
    const next = await f.authority.getWorkRun(ORG, run.id);
    assert.equal(next.agent_thread_id, run.agent_thread_id);
    assert.deepEqual(next.result, run.result);
  });

  it("does not notify again for an unchanged terminal observation", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const item = await f.authority.getWorkItem(ORG, f.item.id);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    await f.supervisor.applyHandle(item, f.recipe, run, f.handle());
    assert.deepEqual(await f.authority.getWorkDeliveryByItem(ORG, item.id), delivery);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.updated, [item.id]);
    assert.equal(f.digestChanges(), 1);
  });

  it("does not enqueue, reopen or fake cancellation for work ignored before atomic observation", async () => {
    const f = await fixture();
    await f.authority.putWorkItem({ ...f.item, status: "skipped" });
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "running");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, []);
    assert.deepEqual(f.dropped, [f.run.id]);
  });

  it("does not restore trial write-back after its in-memory override has been released", async () => {
    const f = await fixture();
    f.supervisor.setWriteBackOverride(f.item.id, false);
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const item = await f.authority.getWorkItem(ORG, f.item.id);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(f.supervisor.allowsWriteBack(item.id, f.recipe), true);
    await f.supervisor.applyHandle(item, f.recipe, run, f.handle());
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, item.id), null);
    assert.deepEqual(f.updated, [item.id]);
  });

  it("rejects a rewritten completed result before emitting success notifications", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const item = await f.authority.getWorkItem(ORG, f.item.id);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    await assert.rejects(
      f.supervisor.applyHandle(item, f.recipe, run, f.handle("completed", {
        result: { summary: "Rewritten" },
      })),
      (error) => error.code === "execution_observation_conflict"
        && error.httpStatus === 409
        && /Start a new attempt/.test(error.message),
    );
    assert.deepEqual(await f.authority.getWorkRun(ORG, run.id), run);
    assert.deepEqual(await f.authority.getWorkDeliveryByItem(ORG, item.id), delivery);
    assert.deepEqual(f.updated, [item.id]);
    assert.equal(f.writes.length, 2);
  });

  it("reports a stale observation without changing the new work or notifying success", async () => {
    const f = await fixture();
    await f.authority.putWorkItem({ ...f.item, head_event_id: "new-trigger" });
    await assert.rejects(
      f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle()),
      (error) => error.code === "execution_observation_conflict" && error.httpStatus === 409,
    );
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "running");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, []);
  });

  it("propagates persistence failure rather than notifying success", async () => {
    const f = await fixture();
    f.authority.commitWorkObservation = async () => { throw new Error("storage unavailable"); };
    await assert.rejects(
      f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle()), /storage unavailable/,
    );
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "running");
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, []);
  });
});

describe("finished conversation folding compatibility", () => {
  it("preserves human hiding and clears only the preferred executor conversation", async (t) => {
    t.after(() => preferThread(null));
    const f = await fixture();
    const human = {
      org_id: ORG, thread_id: f.item.thread_id, hidden: true, hidden_reason: "human",
    };
    f.prefs.set(f.item.thread_id, human);
    preferThread(f.run.agent_thread_id);
    await foldFinishedWorkThreads(
      f.authority, ORG, f.item.thread_id, f.run.agent_thread_id, NOW,
    );
    assert.deepEqual(f.prefs.get(f.item.thread_id), human);
    assert.equal(f.prefs.get(f.run.agent_thread_id).hidden_reason, "policy");
    assert.equal(preferredThreadId(), null);

    preferThread(f.item.thread_id);
    await foldFinishedWorkThreads(
      f.authority, ORG, f.item.thread_id, f.run.agent_thread_id, NOW,
    );
    assert.equal(preferredThreadId(), f.item.thread_id);
  });

  for (const agent of [undefined, "", "   ", "source:conversation"]) {
    it(`folds the source only when the executor identity is ${JSON.stringify(agent)}`, async () => {
      const f = await fixture();
      await foldFinishedWorkThreads(f.authority, ORG, f.item.thread_id, agent, NOW);
      assert.deepEqual(f.writes.map((p) => p.thread_id), [f.item.thread_id]);
    });
  }
});
