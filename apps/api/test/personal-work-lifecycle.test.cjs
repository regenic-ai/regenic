const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryWorkStore, enqueueWriteBack } = require("@regenic/domain");
const { PersonalWorkSupervise } = require("../dist/personal-work-supervise");
const { releaseFinishedAgentThread } = require("../dist/personal-work-lifecycle");
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
  authority.setConversationPolicyHidden = async (input) => {
    const current = prefs.get(input.thread_id);
    const version = current?.visibility_version ?? 0;
    if (version !== input.expected_visibility_version) {
      return { outcome: "conflict", current_version: version };
    }
    if (current?.hidden && current.hidden_reason !== "policy") {
      return { outcome: "unchanged" };
    }
    const patch = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      hidden: true,
      hidden_reason: "policy",
      visibility_version: version,
      updated_at: input.updated_at,
    };
    writes.push(patch);
    prefs.set(input.thread_id, { ...current, ...patch });
    return { outcome: "applied", pref: prefs.get(input.thread_id) };
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
  const created = await createTestWorkItem(authority, initialItem, recipe);
  assert.equal(await authority.claimWorkRunStart({ run: initialRun, expected_item: created }), true);
  const item = await authority.getWorkItem(ORG, initialItem.id);
  let run = await authority.getWorkRun(ORG, initialRun.id);
  const submitted = await authority.checkpointWorkRunStart({
    expected_item: item,
    expected_run: run,
    kind: "submitted",
    external_run_id: "external-1",
    agent_thread_id: "executor:conversation",
    now: NOW,
  });
  assert.equal(submitted.outcome, "applied");
  run = submitted.run;
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

async function uncertainStartFixture({ agentOnly = false, noIdentity = false, pending = false } = {}) {
  const authority = new MemoryWorkStore();
  const recipe = {
    id: "recipe-uncertain",
    org_id: ORG,
    name: "Confirm start",
    match: { record_class: "task" },
    trigger: { kind: "push" },
    executor_type: "test",
    executor_config: {},
    can_write_back: false,
    include_context: false,
    enabled: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const initialItem = {
    id: "work-uncertain",
    org_id: ORG,
    thread_id: "source:uncertain",
    unit_key: "uncertain-unit",
    record_class: "task",
    status: "open",
    recipe_id: recipe.id,
    created_at: NOW,
    updated_at: NOW,
  };
  const initialRun = {
    id: "run-uncertain",
    org_id: ORG,
    work_item_id: initialItem.id,
    recipe_id: recipe.id,
    executor_type: "test",
    status: "running",
    start_state: "pending",
    trigger_kind: "push",
    created_at: NOW,
    updated_at: NOW,
  };
  await authority.putRecipe(recipe);
  const created = await createTestWorkItem(authority, initialItem, recipe);
  assert.equal(await authority.claimWorkRunStart({ run: initialRun, expected_item: created }), true);
  const claimed = {
    item: await authority.getWorkItem(ORG, initialItem.id),
    run: await authority.getWorkRun(ORG, initialRun.id),
  };
  const bound = noIdentity ? claimed : agentOnly
    ? {
        item: claimed.item,
        run: seedTestWorkRun(authority, { ...claimed.run, agent_thread_id: "agent-uncertain" }),
      }
    : await authority.checkpointWorkRunStart({
        expected_item: claimed.item,
        expected_run: claimed.run,
        kind: "bound",
        external_run_id: "external-uncertain",
        agent_thread_id: "agent-uncertain",
        now: NOW,
      });
  if (!agentOnly && !noIdentity) assert.equal(bound.outcome, "applied");
  if (pending) return { authority, recipe, ...bound };
  const uncertain = await authority.checkpointWorkRunStart({
    expected_item: bound.item,
    expected_run: bound.run,
    kind: "uncertain",
    error: "Submission response lost",
    now: NOW,
  });
  assert.equal(uncertain.outcome, "applied");
  return { authority, recipe, ...uncertain };
}

async function createTestWorkItem(authority, item, recipe) {
  const result = await authority.createWorkItem({
    item,
    recipe,
    expected_recipe: recipe,
  });
  assert.equal(result.outcome, "applied");
  return result.item;
}

function seedTestWorkDelivery(authority, delivery) {
  const saved = { ...delivery, version: delivery.version ?? 0 };
  authority.deliveries.set(saved.id, structuredClone(saved));
  return structuredClone(saved);
}

function seedTestWorkRun(authority, run) {
  authority.runs.set(run.id, structuredClone(run));
  return structuredClone(run);
}

function seedTestWorkItemSnapshot(authority, item) {
  authority.items.set(item.id, structuredClone(item));
  return structuredClone(item);
}

describe("work observation transaction boundaries", () => {
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
      const f = await uncertainStartFixture({ pending: start_state === "pending" });
      const run = f.run;
      const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
      const supervisor = new PersonalWorkSupervise({
        requireHost: () => { throw new Error("Must not query an unconfirmed start"); },
      }, {});
      await supervisor.refreshOne(dismissed.item, f.recipe, run);
      assert.deepEqual(await f.authority.getWorkRun(ORG, run.id), run);
      assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
    });
  }

  it("does not query an active historical run with no executor identity", async () => {
    const f = await uncertainStartFixture({ noIdentity: true });
    // Simulate a legacy row predating startup checkpoints.
    f.authority.runs.get(f.run.id).start_state = undefined;
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => { throw new Error("Must not guess an executor identity"); },
    }, {});
    await supervisor.refreshOne(f.item, f.recipe, run);
    assert.deepEqual(await f.authority.getWorkRun(ORG, run.id), run);
    assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), f.item);
  });

  it("rejects mismatched status before following or reaping an active run", async () => {
    const f = await fixture();
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({ status: async () => f.handle("running", {
          external_run_id: "different-run",
        }) }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    supervisor.bindWaits({ attached: () => { throw new Error("Must not follow"); } });
    await assert.rejects(supervisor.refreshOne(f.item, f.recipe, f.run),
      (error) => error.code === "execution_observation_conflict");
    assert.deepEqual(await f.authority.getWorkRun(ORG, f.run.id), f.run);
    assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), f.item);
  });

  it("confirms a known uncertain start only after matching positive executor status evidence", async () => {
    const f = await uncertainStartFixture();
    let queries = 0;
    const executor = {
      status: async () => {
        queries += 1;
        return {
          external_run_id: "external-uncertain",
          agent_thread_id: "agent-uncertain",
          status: "running",
          transcript: { kind: "assistant", activity: "working" },
        };
      },
    };
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => executor },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await supervisor.refreshOne(f.item, f.recipe, f.run);
    const savedRun = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(queries, 1);
    assert.equal(savedRun.start_state, undefined);
    assert.equal(savedRun.status, "running");
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "running");
  });

  it("keeps an uncertain start when status is failed or refers to another execution", async () => {
    for (const handle of [
      { external_run_id: "external-uncertain", status: "failed" },
      { external_run_id: "another-execution", status: "running" },
      { external_run_id: "external-uncertain", status: "running" },
    ]) {
      const f = await uncertainStartFixture();
      const supervisor = new PersonalWorkSupervise({
        requireHost: () => ({ get: (name) => ({
          authority: f.authority,
          executors: { get: () => ({ status: async () => handle }) },
        })[name] }),
      }, { contextFor: () => ({ org_id: ORG }) });
      await supervisor.refreshOne(f.item, f.recipe, f.run);
      assert.deepEqual(await f.authority.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), f.item);
    }
  });

  it("does not confirm uncertain starts from mixed or mismatched identities", async () => {
    for (const handle of [
      { external_run_id: "another-execution", agent_thread_id: "agent-uncertain" },
      { external_run_id: "external-uncertain", agent_thread_id: "another-agent" },
      { external_run_id: "agent-uncertain" },
    ]) {
      const f = await uncertainStartFixture();
      const events = f.authority.listWorkRunStartLifecycleEvents();
      const supervisor = new PersonalWorkSupervise({
        requireHost: () => ({ get: (name) => ({
          authority: f.authority,
          executors: { get: () => ({ status: async () => ({
            ...handle, status: "running",
            transcript: { kind: "assistant", activity: "working" },
            result: { summary: "Unrelated result" },
          }) }) },
        })[name] }),
      }, { contextFor: () => ({ org_id: ORG }) });
      await supervisor.refreshOne(f.item, f.recipe, f.run);
      assert.deepEqual(await f.authority.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(f.authority.listWorkRunStartLifecycleEvents(), events);
      assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
    }
  });

  it("uses the observed external identity when recovering an agent-only start", async () => {
    const f = await uncertainStartFixture({ agentOnly: true });
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({ status: async () => ({
          external_run_id: "actual-external-run",
          agent_thread_id: "agent-uncertain",
          status: "running",
          transcript: { kind: "assistant", activity: "working" },
        }) }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await supervisor.refreshOne(f.item, f.recipe, f.run);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(run.external_run_id, "actual-external-run");
    assert.equal(run.agent_thread_id, "agent-uncertain");
    assert.equal(run.start_state, undefined);
  });

  it("recovers a matching external run when the optional agent identity is omitted", async () => {
    const f = await uncertainStartFixture();
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({ status: async () => ({
          external_run_id: "external-uncertain",
          status: "running",
          transcript: { kind: "assistant", activity: "working" },
        }) }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await supervisor.refreshOne(f.item, f.recipe, f.run);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(run.external_run_id, "external-uncertain");
    assert.equal(run.agent_thread_id, "agent-uncertain");
    assert.equal(run.start_state, undefined);
  });

  it("preserves uncertain start facts when executor status lookup fails", async () => {
    const f = await uncertainStartFixture();
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({ status: async () => { throw new Error("Status unavailable"); } }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await assert.rejects(supervisor.refreshOne(f.item, f.recipe, f.run), /Status unavailable/);
    assert.deepEqual(await f.authority.getWorkRun(ORG, f.run.id), f.run);
    assert.deepEqual(await f.authority.getWorkItem(ORG, f.item.id), f.item);
  });

  it("records a failed executor handle after follow changes the same work item", async () => {
    const f = await fixture();
    const stored = await f.authority.getWorkItem(ORG, f.item.id);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    const supervisor = new PersonalWorkSupervise({
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({
          status: async () => {
            const current = await f.authority.getWorkItem(ORG, f.item.id);
            seedTestWorkItemSnapshot(f.authority, {
              ...current,
              head_event_id: "followed-event",
              version: (current.version ?? 0) + 1,
              updated_at: "2026-11-09T08:05:00.000Z",
            });
            return f.handle("failed", { result: { summary: "DSH failed" } });
          },
        }) },
      })[name] }),
    }, { contextFor: () => ({ org_id: ORG }) });
    await supervisor.refreshOne(stored, f.recipe, run);
    const savedRun = await f.authority.getWorkRun(ORG, run.id);
    const savedItem = await f.authority.getWorkItem(ORG, f.item.id);
    assert.equal(savedRun.status, "failed");
    assert.equal(savedRun.result.summary, "DSH failed");
    assert.equal(savedItem.status, "failed");
    assert.equal(savedItem.head_event_id, "followed-event");
    assert.equal(savedItem.current_run_id, run.id);
  });

  it("does not apply an ignored observation to the successor started during its status query", async () => {
    const f = await fixture();
    const dismissed = await f.authority.dismissWorkItem({ expected_item: f.item, now: NOW });
    const runtime = {
      requireHost: () => ({ get: (name) => ({
        authority: f.authority,
        executors: { get: () => ({
          status: async () => {
            const observed = await f.authority.commitWorkObservation({
              expected_item: dismissed.item, expected_run: f.run,
              handle: f.handle("completed", { result: { summary: "Known result" } }),
              can_write_back: false, trigger_kind: "push", now: NOW,
            });
            assert.equal(observed.outcome, "applied");
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

  it("completes work and queues its result without a post-commit visibility write", async (t) => {
    const f = await fixture();
    t.after(() => preferThread(null));
    preferThread(f.run.agent_thread_id);
    const commitObservation = f.authority.commitWorkObservation.bind(f.authority);
    f.authority.commitWorkObservation = async (input) => {
      assert.equal(preferredThreadId(), f.run.agent_thread_id);
      return commitObservation(input);
    };
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    assert.equal(preferredThreadId(), null);
    const run = await f.authority.getWorkRun(ORG, f.run.id);
    assert.equal(run.status, "completed");
    assert.equal(run.start_state, undefined);
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "done");
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    assert.equal(delivery.status, "queued");
    assert.equal(delivery.write_back, "pending");
    assert.equal(delivery.payload.summary, "Handled");
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.dropped, [f.run.id]);
    assert.deepEqual(f.updated, [f.item.id]);
    assert.equal(f.digestChanges(), 1);
  });

  it("does not policy-hide a failed work item after the observation commit", async () => {
    const f = await fixture();
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle("failed"));
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "failed");
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "failed");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 0);
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
      const delivery = seedTestWorkDelivery(f.authority, f.delivery());
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
    assert.equal(f.writes.length, 0);
  });

  it("honors a trial override and abandons an unacknowledged delivery", async () => {
    const f = await fixture();
    seedTestWorkDelivery(f.authority, f.delivery());
    f.supervisor.setWriteBackOverride(f.item.id, false);
    await f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle());
    const delivery = await f.authority.getWorkDeliveryByItem(ORG, f.item.id);
    assert.equal(delivery.status, "acked");
    assert.equal(delivery.write_back, "skipped");
    assert.equal(f.supervisor.allowsWriteBack(f.item.id, f.recipe), true);
  });

  it("preserves acknowledged deliveries when completion does not request write-back", async () => {
    const f = await fixture({ writeBack: false });
    const delivery = seedTestWorkDelivery(f.authority, {
      ...f.delivery(), status: "acked", write_back: "sent",
    });
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
    const savedRun = seedTestWorkRun(f.authority, run);
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
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, [item.id]);
    assert.equal(f.digestChanges(), 1);
  });

  it("does not enqueue, reopen or fake cancellation for work ignored before atomic observation", async () => {
    const f = await fixture();
    const dismissed = await f.authority.dismissWorkItem({
      expected_item: f.item,
      now: "2026-11-09T08:01:00.000Z",
    });
    assert.equal(dismissed.outcome, "applied");
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
    assert.equal(f.writes.length, 0);
  });

  it("reports a stale observation without changing the new work or notifying success", async () => {
    const f = await fixture();
    seedTestWorkItemSnapshot(f.authority, { ...f.item, head_event_id: "new-trigger" });
    await assert.rejects(
      f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle()),
      (error) => error.code === "execution_observation_conflict" && error.httpStatus === 409,
    );
    assert.equal((await f.authority.getWorkRun(ORG, f.run.id)).status, "running");
    assert.equal(await f.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, []);
  });

  it("propagates persistence failure rather than notifying success", async (t) => {
    const f = await fixture();
    t.after(() => preferThread(null));
    preferThread(f.run.agent_thread_id);
    f.authority.commitWorkObservation = async () => { throw new Error("storage unavailable"); };
    await assert.rejects(
      f.supervisor.applyHandle(f.item, f.recipe, f.run, f.handle()), /storage unavailable/,
    );
    assert.equal(preferredThreadId(), f.run.agent_thread_id);
    assert.equal((await f.authority.getWorkItem(ORG, f.item.id)).status, "running");
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.updated, []);
  });
});

describe("finished agent thread selection", () => {
  it("clears only the preferred executor conversation", async (t) => {
    t.after(() => preferThread(null));
    const f = await fixture();
    preferThread(f.run.agent_thread_id);
    releaseFinishedAgentThread(f.run.agent_thread_id);
    assert.equal(preferredThreadId(), null);

    preferThread(f.item.thread_id);
    releaseFinishedAgentThread(f.run.agent_thread_id);
    assert.equal(preferredThreadId(), f.item.thread_id);
  });

});
