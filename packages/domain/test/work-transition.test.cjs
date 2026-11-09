const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  assertWorkRunWrite, planWorkObservation, prepareWorkRunStartCheckpoint, canClaimWorkRunStartItem,
  prepareWorkRunStartFailure,
} = require("../dist");

const BEFORE = "2026-11-09T08:00:00.000Z";
const NOW = "2026-11-09T08:01:00.000Z";

function fixture() {
  const item = {
    id: "work-1",
    org_id: "owner",
    thread_id: "source:conversation",
    unit_key: "unit-1",
    record_class: "task",
    thread_facet: "ticket",
    status: "running",
    recipe_id: "recipe-1",
    created_at: BEFORE,
    updated_at: BEFORE,
  };
  const run = {
    id: "run-1",
    org_id: item.org_id,
    work_item_id: item.id,
    recipe_id: item.recipe_id,
    executor_type: "test",
    external_run_id: "external-1",
    agent_thread_id: "executor:conversation",
    status: "running",
    created_at: BEFORE,
    updated_at: BEFORE,
  };
  return {
    item,
    run,
    handle: {
      status: "completed",
      external_run_id: run.external_run_id,
      result: { summary: "Handled" },
    },
    can_write_back: true,
    now: NOW,
  };
}

describe("work preflight failure transitions", () => {
  function failure() {
    const { item } = fixture();
    item.status = "open";
    item.version = 2;
    return {
      expected_item: item, mode: "automatic",
      run: {
        id: "failed-start", org_id: item.org_id, work_item_id: item.id,
        recipe_id: item.recipe_id, executor_type: "test", status: "failed",
        result: { summary: "Unknown executor" }, write_back_required: false,
        trigger_kind: "push", created_at: NOW, updated_at: NOW,
      },
    };
  }
  const facts = (input, overrides = {}) => ({
    item: input.expected_item, recipe_exists: true, active_run: false, unresolved_delivery: false, ...overrides,
  });

  for (const mode of ["automatic", "manual", "auxiliary"]) {
    it(`records ${mode} failure without creating an intermediate running state`, () => {
      const input = { ...failure(), mode };
      input.expected_item.current_run_id = "old-run";
      const original = structuredClone(input);
      const result = prepareWorkRunStartFailure(input, facts(input));
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, mode === "automatic" ? "failed" : "open");
      assert.equal(result.item.current_run_id, mode === "automatic" ? input.run.id : "old-run");
      assert.equal(result.item.version, 3);
      assert.equal(result.run.version, 0);
      assert.equal(result.run.write_back_required, false);
      assert.deepEqual(input, original);
      result.item.unit_key = "changed";
      result.run.result.summary = "changed";
      assert.deepEqual(input, original);
    });
  }

  it("rejects stale facts, protected work, active runs and unresolved deliveries", () => {
    const input = failure();
    for (const [overrides, reason] of [
      [{ item: null }, "missing_work"],
      [{ item: { ...input.expected_item, version: 3 } }, "stale_failure"],
      [{ item: { ...input.expected_item, status: "skipped" } }, "stale_failure"],
      [{ recipe_exists: false }, "missing_recipe"],
      [{ active_run: true }, "active_run"],
      [{ unresolved_delivery: true }, "unresolved_delivery"],
    ]) {
      assert.deepEqual(prepareWorkRunStartFailure(input, facts(input, overrides)), { outcome: "conflict", reason });
    }
    for (const status of ["running", "waiting_human", "done", "skipped"]) {
      const protectedInput = failure();
      protectedInput.expected_item.status = status;
      assert.equal(prepareWorkRunStartFailure(protectedInput, facts(protectedInput)).outcome, "conflict");
    }
  });

  it("rejects an external or ambiguous failure and cross-item identities", () => {
    for (const changed of [
      { id: "" }, { executor_type: 42 },
      { status: "running" }, { external_run_id: "external" }, { agent_thread_id: "executor:thread" },
      { start_state: "uncertain" }, { write_back_required: undefined }, { version: 1 },
      { result: { summary: " " } }, { result: { summary: 42 } }, { updated_at: "invalid" },
    ]) {
      const input = failure();
      input.run = { ...input.run, ...changed };
      assert.throws(() => prepareWorkRunStartFailure(input, facts(input)), /definitely unstarted/);
    }
    const input = failure();
    input.run.org_id = "other";
    assert.throws(() => prepareWorkRunStartFailure(input, facts(input)), /same organization/);
  });
});

describe("work retry start eligibility", () => {
  for (const status of ["open", "failed", "done", "skipped"]) {
    it(`requires explicit rule binding intent for ${status} and preserves the snapshot`, () => {
      const { item, run } = fixture();
      item.status = status;
      run.recipe_id = "new-rule";
      run.start_state = "pending";
      const original = structuredClone(item);
      assert.equal(canClaimWorkRunStartItem({
        run, retry: "manual", expected_item: item,
      }, item), false);
      assert.equal(canClaimWorkRunStartItem({
        run, retry: "manual", rebind: "manual", expected_item: item,
      }, item), status !== "open");
      assert.equal(canClaimWorkRunStartItem({
        run, retry: "automatic", rebind: "automatic", expected_item: item,
      }, item), status === "open" || status === "failed");
      assert.deepEqual(item, original);
    });
  }

  it("allows binding unbound open work but rejects malformed or stale binding intent", () => {
    const { item, run } = fixture();
    item.status = "open";
    delete item.recipe_id;
    run.start_state = "pending";
    const input = { run, retry: "manual", rebind: "manual", expected_item: item };
    assert.equal(canClaimWorkRunStartItem(input, item), true);
    assert.equal(canClaimWorkRunStartItem(input, { ...item, version: 1 }), false);
    assert.throws(() => canClaimWorkRunStartItem({ ...input, expected_item: undefined }, item),
      /expected item snapshot/);
    assert.throws(() => canClaimWorkRunStartItem({ ...input, retry: "automatic" }, item),
      /matching retry intent/);
    assert.throws(() => canClaimWorkRunStartItem({ ...input, rebind: "automatic" }, item),
      /matching retry intent/);
    assert.throws(() => canClaimWorkRunStartItem({ ...input, rebind: "unsupported" }, item),
      /Unknown work start binding mode/);
  });

  for (const status of ["open", "running", "waiting_human", "failed", "done", "skipped"]) {
    it(`checks explicit retry intent against ${status} without changing the item`, () => {
      const { item, run } = fixture();
      item.status = status;
      run.start_state = "pending";
      const original = structuredClone(item);
      for (const retry of [undefined, "automatic", "manual"]) {
        const eligible = status === "open" || (status === "failed" && retry !== undefined)
          || (retry === "manual" && (status === "done" || status === "skipped"));
        assert.equal(canClaimWorkRunStartItem({ run, retry, expected_item: item }, item), eligible);
      }
      assert.deepEqual(item, original);
    });
  }

  it("requires a retry snapshot and rejects stale versions even when timestamps match", () => {
    const { item, run } = fixture();
    item.status = "failed";
    run.start_state = "pending";
    assert.throws(() => canClaimWorkRunStartItem({ run, retry: "manual" }, item), /expected item snapshot/);
    assert.throws(() => canClaimWorkRunStartItem({
      run, retry: "unknown", expected_item: item,
    }, item), /Unknown work start retry mode/);
    assert.throws(() => canClaimWorkRunStartItem({
      run, expected_item: { ...item, org_id: "foreign" },
    }, item), /same organization and work item/);
    assert.equal(canClaimWorkRunStartItem({
      run, retry: "manual", expected_item: { ...item, version: 0 },
    }, { ...item, version: 1 }), false);
    assert.equal(canClaimWorkRunStartItem({ run, expected_item: item }, item), false);
  });
});

describe("work start checkpoint planning", () => {
  function checkpointFixture() {
    const { item, run } = fixture();
    item.current_run_id = run.id;
    run.start_state = "pending";
    delete run.external_run_id;
    delete run.agent_thread_id;
    return {
      input: { expected_item: item, expected_run: run, now: NOW, kind: "uncertain", error: "Unknown" },
      current: { item, run },
    };
  }

  it("plans the run and item together without mutating caller snapshots", () => {
    const { input, current } = checkpointFixture();
    const original = structuredClone(current);
    const result = prepareWorkRunStartCheckpoint(input, current);
    assert.equal(result.outcome, "applied");
    assert.equal(result.run.start_state, "uncertain");
    assert.equal(result.run.status, "waiting_human");
    assert.equal(result.item.status, "waiting_human");
    assert.equal(result.run.version, 1);
    assert.equal(result.item.version, 1);
    assert.deepEqual(current, original);
    assert.deepEqual(prepareWorkRunStartCheckpoint(input, current), result);
  });

  it("validates timestamps, errors and external identities without writes", () => {
    const { input, current } = checkpointFixture();
    for (const change of [
      { now: "invalid" },
      { error: " " },
      { kind: "submitted", external_run_id: undefined },
      { kind: "bound", external_run_id: "external", agent_thread_id: undefined },
      { kind: "submitted", external_run_id: " " },
      { kind: "submitted", external_run_id: "external", agent_thread_id: " " },
      { kind: "bound", external_run_id: "external", agent_thread_id: " " },
    ]) {
      assert.throws(() => prepareWorkRunStartCheckpoint({ ...input, ...change }, current),
        /requires|checkpoint failure/);
    }
    assert.equal(current.run.start_state, "pending");
    assert.equal(current.item.status, "running");
    assert.throws(() => prepareWorkRunStartCheckpoint({ ...input, kind: "unsupported" }, current),
      /Unknown work run start checkpoint kind/);
  });

  it("keeps historical current identity unknown and does not infer a run", () => {
    const { input, current } = checkpointFixture();
    delete current.item.current_run_id;
    assert.deepEqual(prepareWorkRunStartCheckpoint(input, current),
      { outcome: "conflict", reason: "not_current_run" });
  });

  it("does not turn a submitted or uncertain request into a definite failure", () => {
    for (const start_state of ["submitted", "uncertain"]) {
      const { input, current } = checkpointFixture();
      current.run.start_state = start_state;
      assert.deepEqual(prepareWorkRunStartCheckpoint({ ...input, kind: "failed" }, current),
        { outcome: "conflict", reason: "start_closed" });
      assert.deepEqual(prepareWorkRunStartCheckpoint(input, current),
        { outcome: "conflict", reason: "start_closed" });
    }
  });
});

describe("work observation transitions", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    it(`rejects a different state after ${status}, even through the pure planner`, () => {
      const input = fixture();
      input.run.status = status;
      input.run.result = input.handle.result;
      for (const next of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
        if (next === status) continue;
        input.handle.status = next;
        assert.throws(() => planWorkObservation(input), /Terminal work run status is immutable/);
        assert.throws(() => assertWorkRunWrite({ ...input.run, status: next }, input.run),
          /Terminal work run status is immutable/);
      }
    });
  }

  it("rejects clearing or filling a completed result through the common write guard", () => {
    const { run } = fixture();
    run.status = "completed";
    run.result = { summary: "Original" };
    assert.throws(() => assertWorkRunWrite({ ...run, result: undefined }, run),
      /Completed work results are immutable/);
    assert.throws(() => assertWorkRunWrite(run, { ...run, result: undefined }),
      /Completed work results are immutable/);
    assert.doesNotThrow(() => assertWorkRunWrite({ ...run, updated_at: NOW }, run));
  });

  for (const [status, itemStatus, settled] of [
    ["running", "running", false],
    ["waiting_human", "waiting_human", false],
    ["completed", "done", true],
    ["failed", "failed", true],
    ["cancelled", "skipped", true],
  ]) {
    it(`maps ${status} to the matching run and ${itemStatus} work status`, () => {
      const input = fixture();
      input.handle.status = status;
      const plan = planWorkObservation(input);
      assert.equal(plan.run.status, status);
      assert.equal(plan.item.status, itemStatus);
      assert.equal(plan.settled, settled);
      assert.equal(plan.run.updated_at, NOW);
      assert.equal(plan.run.created_at, BEFORE);
      assert.equal(plan.item.created_at, BEFORE);
    });
  }

  it("plans a delivery payload without allocating a sending identity or touching a store", () => {
    const input = fixture();
    input.handle.result.content = [
      { role: "body", media_type: "text/plain", text: "Details" },
    ];
    const plan = planWorkObservation(input);
    assert.deepEqual(plan.delivery, { kind: "enqueue", payload: input.handle.result });
    assert.equal(plan.run.agent_thread_id, input.run.agent_thread_id);
    assert.equal(plan.changed, true);
    assert.deepEqual(planWorkObservation(input), plan);
  });

  it("plans abandonment only for successful completion with write-back disabled", () => {
    const input = fixture();
    input.can_write_back = false;
    assert.deepEqual(planWorkObservation(input).delivery, { kind: "abandon" });
    for (const status of ["running", "waiting_human", "failed", "cancelled"]) {
      input.handle.status = status;
      assert.deepEqual(planWorkObservation(input).delivery, { kind: "keep" });
    }
  });

  it("retains known context and clears the acknowledged startup marker", () => {
    const input = fixture();
    input.run.start_state = "submitted";
    input.run.result = { summary: "Previous result" };
    input.handle = { status: "running", external_run_id: "external-2" };
    const plan = planWorkObservation(input);
    assert.equal(plan.run.external_run_id, "external-2");
    assert.equal(plan.run.agent_thread_id, input.run.agent_thread_id);
    assert.deepEqual(plan.run.result, input.run.result);
    assert.equal(plan.run.start_state, undefined);
    assert.equal(plan.changed, true);
  });

  it("ignores timestamp-only changes and avoids rewriting an unchanged item", () => {
    const input = fixture();
    input.handle = { status: "running", external_run_id: input.run.external_run_id };
    const plan = planWorkObservation(input);
    assert.equal(plan.changed, false);
    assert.equal(plan.item, input.item);
    assert.equal(plan.run.updated_at, NOW);
    assert.equal(plan.item.updated_at, BEFORE);
  });

  it("clears a submitted checkpoint without publishing a spurious executor state change", () => {
    const input = fixture();
    input.run.start_state = "submitted";
    input.handle = { status: "running", external_run_id: input.run.external_run_id };
    const plan = planWorkObservation(input);
    assert.equal(plan.changed, false);
    assert.equal(plan.run.start_state, undefined);
  });

  for (const change of [
    { agent_thread_id: "executor:replacement" },
    { external_run_id: "external-2" },
    { result: { summary: "New result" } },
  ]) {
    it(`reports changed work for ${Object.keys(change)[0]} without changing item status`, () => {
      const input = fixture();
      input.handle = { status: "running", external_run_id: input.run.external_run_id, ...change };
      const plan = planWorkObservation(input);
      assert.equal(plan.changed, true);
      assert.equal(plan.item, input.item);
    });
  }

  it("does not mutate the provided observation, work item or run", () => {
    const input = fixture();
    const original = structuredClone(input);
    Object.freeze(input.item);
    Object.freeze(input.run);
    Object.freeze(input.handle.result);
    Object.freeze(input.handle);
    Object.freeze(input);
    planWorkObservation(input);
    assert.deepEqual(input, original);
  });

  for (const change of [{ org_id: "another-owner" }, { work_item_id: "work-2" }]) {
    it(`rejects a mismatched ${Object.keys(change)[0]} instead of constructing a cross-work transition`, () => {
      const input = fixture();
      Object.assign(input.run, change);
      assert.throws(() => planWorkObservation(input), /same organization and work item/);
    });
  }

  it("uses the retained result when completion does not repeat the result envelope", () => {
    const input = fixture();
    delete input.handle.result;
    input.run.result = { summary: "Previous result" };
    const plan = planWorkObservation(input);
    assert.deepEqual(plan.run.result, input.run.result);
    assert.deepEqual(plan.delivery, {
      kind: "enqueue", payload: { summary: "Previous result", content: undefined },
    });
  });

  it("keeps empty result validation when no result was ever observed", () => {
    const input = fixture();
    delete input.handle.result;
    assert.deepEqual(planWorkObservation(input).delivery, {
      kind: "enqueue", payload: { summary: "", content: undefined },
    });
  });

  it("does not recreate or abandon delivery on repeated completion after recipe edits", () => {
    for (const can_write_back of [true, false]) {
      const input = fixture();
      input.item.status = "done";
      input.run.status = "completed";
      input.run.result = { summary: "Handled" };
      input.can_write_back = can_write_back;
      const plan = planWorkObservation(input);
      assert.equal(plan.changed, false);
      assert.deepEqual(plan.delivery, { kind: "keep" });
      delete input.handle.result;
      assert.deepEqual(planWorkObservation(input).run.result, input.run.result);
      assert.deepEqual(planWorkObservation(input).delivery, { kind: "keep" });
    }
  });

  it("rejects a changed completed result including previously unknown historical results", () => {
    for (const result of [undefined, { summary: "Original" }]) {
      const input = fixture();
      input.run.status = "completed";
      input.run.result = result;
      assert.throws(() => planWorkObservation(input), /Completed work results are immutable/);
    }
  });

  it("compares result objects semantically while preserving evidence and content ordering", () => {
    const input = fixture();
    input.item.status = "done";
    input.run.status = "completed";
    input.run.result = {
      summary: "Handled",
      content: [{ role: "body", media_type: "text/plain", text: "Details" }],
      evidence_event_ids: ["event-1", "event-2"],
    };
    input.handle.result = {
      evidence_event_ids: ["event-1", "event-2"],
      content: [{ text: "Details", media_type: "text/plain", role: "body" }],
      summary: "Handled",
    };
    const plan = planWorkObservation(input);
    assert.equal(plan.run.result, input.run.result);
    assert.equal(plan.changed, false);
    input.handle.result.evidence_event_ids.reverse();
    assert.throws(() => planWorkObservation(input), /Completed work results are immutable/);
  });
});
