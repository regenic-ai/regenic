const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { assertWorkRunWrite, planWorkObservation } = require("../dist");

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
