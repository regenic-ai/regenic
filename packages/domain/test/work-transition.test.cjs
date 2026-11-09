const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { planWorkObservation } = require("../dist");

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

  it("preserves empty result validation for the existing delivery path", () => {
    const input = fixture();
    delete input.handle.result;
    input.run.result = { summary: "Previous result" };
    const plan = planWorkObservation(input);
    assert.deepEqual(plan.run.result, input.run.result);
    assert.deepEqual(plan.delivery, {
      kind: "enqueue", payload: { summary: "", content: undefined },
    });
  });
});
