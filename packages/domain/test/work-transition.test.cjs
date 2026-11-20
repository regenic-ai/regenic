const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  assertWorkRunWrite, planWorkObservation, prepareWorkRunStartCheckpoint, canClaimWorkRunStartItem,
  prepareWorkRunStartFailure,
  prepareWorkItemCreation,
  prepareWorkItemCreationAbort,
  prepareWorkDismissal, enqueueWriteBack, prepareWorkObservation,
  automaticWorkCompletionReady,
  diagnoseWorkItemRunIdentity,
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

describe("work item run identity diagnostics", () => {
  it("reports missing pointers and only lists active same-recipe candidates", () => {
    const { item, run } = fixture();
    assert.deepEqual(diagnoseWorkItemRunIdentity(item, [run]), {
      work_item_id: item.id,
      thread_id: item.thread_id,
      unit_key: item.unit_key,
      item_status: "running",
      reason: "missing_current_run",
      candidate_run_ids: [run.id],
    });
    assert.equal(diagnoseWorkItemRunIdentity({ ...item, current_run_id: run.id }, [run]), null);
    assert.deepEqual(
      diagnoseWorkItemRunIdentity(item, [{
        ...run,
        recipe_id: "different-recipe",
      }]).candidate_run_ids,
      [],
    );
    assert.equal(diagnoseWorkItemRunIdentity({ ...item, status: "done" }, [run]), null);
    assert.equal(diagnoseWorkItemRunIdentity({ ...item, status: "open" }, []), null);
  });

  it("reports invalid stored pointers without treating candidates as repaired identity", () => {
    const { item, run } = fixture();
    assert.equal(
      diagnoseWorkItemRunIdentity(
        { ...item, current_run_id: "missing-run" },
        [run],
      ).reason,
      "current_run_not_found",
    );
    assert.equal(
      diagnoseWorkItemRunIdentity(
        { ...item, current_run_id: run.id },
        [{ ...run, recipe_id: "different-recipe" }],
      ).reason,
      "current_run_recipe_mismatch",
    );
    assert.equal(
      diagnoseWorkItemRunIdentity(
        { ...item, current_run_id: run.id },
        [{ ...run, work_item_id: "other-work" }],
      ).reason,
      "current_run_identity_mismatch",
    );
    assert.equal(
      diagnoseWorkItemRunIdentity(
        { ...item, current_run_id: run.id },
        [{ ...run, status: "completed" }],
      ).reason,
      "current_run_not_active",
    );
    assert.deepEqual(
      diagnoseWorkItemRunIdentity(item, [run, { ...run, id: "run-2" }]).candidate_run_ids,
      ["run-1", "run-2"],
    );
  });
});

describe("work item creation transitions", () => {
  function creation() {
    const { item } = fixture();
    return {
      item: { ...item, status: "open" },
      recipe: {
        id: item.recipe_id, org_id: item.org_id, name: "System work",
        trigger: { kind: "manual" }, match: { unit_kind: "__system.test" },
        executor_type: "test", executor_config: { prompt: "Instruction" },
        can_write_back: false, include_context: false, enabled: true,
        created_at: BEFORE, updated_at: BEFORE,
      },
      expected_recipe: null,
    };
  }
  it("plans a fresh item and recipe without aliasing the input", () => {
    const input = creation();
    const result = prepareWorkItemCreation(input, { item_exists: false, recipe: null });
    assert.equal(result.outcome, "applied");
    assert.equal(result.item.version, 0);
    result.recipe.executor_config.prompt = "Mutated";
    result.item.status = "done";
    assert.equal(input.item.status, "open");
    assert.equal(input.recipe.executor_config.prompt, "Instruction");
  });
  for (const change of [
    { status: "running" }, { version: 1 }, { current_run_id: "existing-run" },
    { id: "" }, { thread_id: "" }, { org_id: "foreign" },
    { recipe_id: "other" }, { updated_at: NOW }, { created_at: "invalid" },
  ]) {
    it(`rejects invalid new work ${JSON.stringify(change)}`, () => {
      const input = creation();
      assert.throws(() => prepareWorkItemCreation({
        ...input, item: { ...input.item, ...change },
      }, { item_exists: false, recipe: null }), /fresh open item/);
    });
  }
  it("does not recreate a removed recipe from a stale expectation", () => {
    const input = creation();
    assert.deepEqual(prepareWorkItemCreation({
      ...input, expected_recipe: input.recipe,
    }, { item_exists: false, recipe: null }), { outcome: "conflict", reason: "stale_recipe" });
  });
  it("reuses equivalent configuration without changing timestamps, even for simultaneous creates", () => {
    const input = creation();
    const current = { ...input.recipe, hide_on_success: true, created_at: NOW, updated_at: NOW };
    const result = prepareWorkItemCreation(input, { item_exists: false, recipe: current });
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.recipe, current);
  });
  it("does not adopt a concurrent recipe with a different success-hiding choice", () => {
    for (const hide of [false, true]) {
      const input = creation();
      input.recipe.hide_on_success = hide;
      const current = { ...input.recipe, hide_on_success: !hide };
      assert.deepEqual(prepareWorkItemCreation(input, { item_exists: false, recipe: current }),
        { outcome: "conflict", reason: "stale_recipe" });
    }
  });
  function answerCreation() {
    const input = creation();
    return {
      ...input, search_answer: {
        id: "answer", org_id: input.item.org_id, work_item_id: input.item.id,
        query: "Question", event_ids: ["event"], created_at: BEFORE, updated_at: BEFORE,
      },
    };
  }
  it("plans answer metadata together and keeps input and output detached", () => {
    const input = answerCreation();
    const result = prepareWorkItemCreation(input, { item_exists: false, recipe: null, search_answer_exists: false });
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.search_answer, input.search_answer);
    result.search_answer.event_ids.push("mutated");
    assert.deepEqual(input.search_answer.event_ids, ["event"]);
    assert.deepEqual(prepareWorkItemCreation(input, {
      item_exists: false, recipe: null, search_answer_exists: true,
    }), { outcome: "conflict", reason: "search_answer_exists" });
  });
  function answerAdvancement(completed = 0) {
    const base = answerCreation();
    const fact = { dedupe_key: "first", group: "owner", metric: "tasks", value: 1, event_ids: ["event"] };
    const previous = {
      ...base.search_answer,
      event_ids: ["event", "event-2"],
      scope: {
        intent: "aggregate", complete: true, total_count: 2, included_count: 2, omitted_count: 0,
        map_reduce: {
          strategy: "map_reduce", phase: "mapping", snapshot_id: "snapshot",
          batch_offsets: [0, 1, 2], total_batches: 2, completed_batches: completed,
          facts: completed ? [fact] : [],
        },
      },
    };
    const item = { ...base.item, status: "done", version: 2, current_run_id: "run-1" };
    const run = { ...fixture().run, status: "completed", version: 2 };
    const next = {
      ...previous, work_item_id: "next-work", updated_at: NOW,
      scope: {
        ...previous.scope,
        map_reduce: {
          ...previous.scope.map_reduce, completed_batches: completed + 1,
          phase: completed === 1 ? "reducing" : "mapping",
          facts: [...previous.scope.map_reduce.facts, { ...fact, dedupe_key: "next" }],
        },
      },
    };
    return {
      input: {
        ...base,
        item: { ...base.item, id: next.work_item_id, unit_key: next.work_item_id },
        search_answer: next,
        search_answer_transition: { expected_answer: previous, expected_item: item, expected_run: run },
      },
      facts: {
        item_exists: false, recipe: null, search_answer_exists: true,
        search_answer: previous, answer_item: item, answer_run: run,
      },
    };
  }
  it("advances a completed map into the next batch or reduce in the same creation plan", () => {
    for (const completed of [0, 1]) {
      const { input, facts } = answerAdvancement(completed);
      const result = prepareWorkItemCreation(input, facts);
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.id, result.search_answer.work_item_id);
      assert.equal(result.search_answer.scope.map_reduce.completed_batches, completed + 1);
      assert.equal(result.search_answer.scope.map_reduce.phase, completed ? "reducing" : "mapping");
      assert.equal(facts.search_answer.scope.map_reduce.completed_batches, completed);
    }
  });
  it("atomically advances a fully completed parallel map into reduce", () => {
    const base = answerAdvancement(1);
    const previousMap = {
      ...base.facts.search_answer.scope.map_reduce,
      completed_batches: 2,
      facts: [
        ...base.facts.search_answer.scope.map_reduce.facts,
        { dedupe_key: "next", group: "owner", metric: "tasks", value: 1, event_ids: ["event-2"] },
      ],
      batches: [
        { index: 0, start_offset: 0, end_offset: 1, status: "completed", attempt: 0, work_item_id: base.facts.answer_item.id, facts: [] },
        { index: 1, start_offset: 1, end_offset: 2, status: "completed", attempt: 0, work_item_id: "other-map", facts: [] },
      ],
    };
    const previous = {
      ...base.facts.search_answer,
      work_item_id: "failed-initial-map",
      scope: { ...base.facts.search_answer.scope, map_reduce: previousMap },
    };
    const next = {
      ...previous,
      work_item_id: base.input.item.id,
      updated_at: NOW,
      scope: {
        ...previous.scope,
        conflict_count: 1,
        map_reduce: { ...previousMap, phase: "reducing" },
      },
    };
    const result = prepareWorkItemCreation({
      ...base.input,
      search_answer: next,
      search_answer_transition: {
        expected_answer: previous,
        expected_item: base.facts.answer_item,
        expected_run: base.facts.answer_run,
      },
    }, { ...base.facts, search_answer: previous });
    assert.equal(result.outcome, "applied");
    assert.equal(result.search_answer.scope.map_reduce.phase, "reducing");
    assert.equal(result.search_answer.scope.map_reduce.completed_batches, 2);
  });
  it("fences changed answer metadata and cancelled or replaced source work before advancing", () => {
    const base = answerAdvancement();
    const candidates = [
      { ...base.facts, search_answer: { ...base.facts.search_answer, outcome: "timed_out" } },
      { ...base.facts, search_answer: { ...base.facts.search_answer, work_item_id: "another-map" } },
      { ...base.facts, answer_item: { ...base.facts.answer_item, status: "skipped", version: 3 } },
      { ...base.facts, answer_item: { ...base.facts.answer_item, current_run_id: "another-run" } },
      { ...base.facts, answer_run: { ...base.facts.answer_run, version: 3 } },
    ];
    for (const facts of candidates) {
      assert.deepEqual(prepareWorkItemCreation(base.input, facts),
        { outcome: "conflict", reason: "stale_search_answer" });
    }
    for (const change of [
      { query: "Different question" }, { event_ids: ["unauthorized-event"] },
      { scope: { ...base.input.search_answer.scope, map_reduce: {
        ...base.input.search_answer.scope.map_reduce, completed_batches: 2,
      } } },
    ]) {
      assert.deepEqual(prepareWorkItemCreation({
        ...base.input, search_answer: { ...base.input.search_answer, ...change },
      }, base.facts), { outcome: "conflict", reason: "stale_search_answer" });
    }
  });
  describe("pre-reservation abort", () => {
    function abortFacts() {
      const input = answerCreation();
      const created = prepareWorkItemCreation(input, { item_exists: false, recipe: null });
      return {
        input: { expected_item: created.item, expected_search_answer: created.search_answer },
        facts: { item: created.item, has_run: false, has_delivery: false, search_answer: created.search_answer },
      };
    }
    it("removes only a fresh work item and its matching answer snapshot", () => {
      const { input, facts } = abortFacts();
      const result = prepareWorkItemCreationAbort(input, facts);
      assert.equal(result.outcome, "applied");
      assert.deepEqual(result.item, facts.item);
      assert.deepEqual(result.search_answer, facts.search_answer);
      assert.deepEqual(prepareWorkItemCreationAbort(input, { ...facts, item: null }),
        { outcome: "conflict", reason: "missing_work" });
    });
    for (const [name, facts] of [
      ["missing work", { item: null, has_run: false, has_delivery: false }],
      ["changed work", { item: { ...abortFacts().facts.item, version: 1 }, has_run: false, has_delivery: false }],
      ["active run", { ...abortFacts().facts, has_run: true }],
      ["historical run", { ...abortFacts().facts, has_run: true }],
      ["delivery", { ...abortFacts().facts, has_delivery: true }],
      ["missing answer", { ...abortFacts().facts, search_answer: null }],
      ["changed answer", { ...abortFacts().facts, search_answer: { ...abortFacts().facts.search_answer, query: "Changed" } }],
    ]) {
      it(`refuses abort when ${name} is no longer the prepared state`, () => {
        const { input } = abortFacts();
        const result = prepareWorkItemCreationAbort(input, facts);
        assert.equal(result.outcome, "conflict");
        assert.notEqual(result.reason, undefined);
      });
    }
    it("rejects foreign answer identity and does not mutate prepared state", () => {
      const { input, facts } = abortFacts();
      assert.throws(() => prepareWorkItemCreationAbort({
        ...input, expected_search_answer: { ...input.expected_search_answer, org_id: "foreign" },
      }, facts), /same work item/);
      assert.equal(facts.item.status, "open");
      assert.equal(facts.search_answer.outcome, undefined);
    });
    it("does not remove an unexpected answer when no answer snapshot was prepared", () => {
      const { input, facts } = abortFacts();
      assert.deepEqual(prepareWorkItemCreationAbort({ expected_item: input.expected_item }, facts), {
        outcome: "conflict", reason: "stale_search_answer",
      });
    });
  });
  for (const change of [
    { id: "" }, { org_id: "foreign" }, { work_item_id: "other-work" },
    { outcome: "timed_out" }, { query: "" }, { event_ids: [""] }, { event_ids: [1] },
    { created_at: "invalid" }, { updated_at: NOW },
  ]) {
    it(`rejects invalid new answer ${JSON.stringify(change)}`, () => {
      const input = answerCreation();
      assert.throws(() => prepareWorkItemCreation({
        ...input, search_answer: { ...input.search_answer, ...change },
      }, { item_exists: false, recipe: null }), /fresh search answer/);
    });
  }
  describe("pre-reservation abort", () => {
    function abortFacts() {
      const input = answerCreation();
      const created = prepareWorkItemCreation(input, { item_exists: false, recipe: null });
      return {
        input: { expected_item: created.item, expected_search_answer: created.search_answer },
        facts: { item: created.item, has_run: false, has_delivery: false, search_answer: created.search_answer },
      };
    }
    it("accepts only the exact fresh preparation and returns detached snapshots", () => {
      const { input, facts } = abortFacts();
      const result = prepareWorkItemCreationAbort(input, facts);
      assert.equal(result.outcome, "applied");
      assert.deepEqual(result.item, facts.item);
      assert.deepEqual(result.search_answer, facts.search_answer);
      result.search_answer.event_ids.push("mutated");
      assert.deepEqual(facts.search_answer.event_ids, ["event"]);
      assert.deepEqual(prepareWorkItemCreationAbort(input, { ...facts, item: null }),
        { outcome: "conflict", reason: "missing_work" });
    });
    for (const [reason, patch] of [
      ["stale work", { item: { ...abortFacts().facts.item, version: 1 } }],
      ["existing run", { has_run: true }],
      ["existing delivery", { has_delivery: true }],
      ["missing answer", { search_answer: null }],
      ["changed answer", { search_answer: { ...abortFacts().facts.search_answer, event_ids: ["changed"] } }],
    ]) {
      it(`refuses abort with ${reason}`, () => {
        const { input, facts } = abortFacts();
        const result = prepareWorkItemCreationAbort(input, { ...facts, ...patch });
        assert.equal(result.outcome, "conflict");
        assert.notEqual(result.reason, undefined);
      });
    }
    it("rejects foreign answer identity", () => {
      const { input, facts } = abortFacts();
      assert.throws(() => prepareWorkItemCreationAbort({
        ...input, expected_search_answer: { ...input.expected_search_answer, org_id: "foreign" },
      }, facts), /same work item/);
    });
  });
});

describe("work dismissal transitions", () => {
  function dismissal() {
    const { item, run } = fixture();
    item.current_run_id = run.id;
    return {
      input: { expected_item: item, now: NOW },
      facts: {
        item, run,
        deliveries: [enqueueWriteBack({
          org_id: item.org_id, work_item_id: item.id, recipe_id: item.recipe_id,
          unit_key: item.unit_key, kind: "push", payload: { summary: "Previous result" }, now: BEFORE,
        })],
      },
    };
  }
  it("stops following work and unsent delivery without forging an executor outcome", () => {
    const { input, facts } = dismissal();
    const original = structuredClone(facts);
    const result = prepareWorkDismissal(input, facts);
    assert.equal(result.outcome, "applied");
    assert.equal(result.item.status, "skipped");
    assert.equal(result.item.current_run_id, facts.run.id);
    assert.equal(result.item.version, 1);
    assert.deepEqual(result.run, facts.run);
    assert.equal(result.deliveries[0].status, "acked");
    assert.equal(result.deliveries[0].write_back, "skipped");
    assert.deepEqual(facts, original);
    result.run.result = { summary: "Changed" };
    assert.deepEqual(facts, original);
  });
  it("plans the timeout cause with local dismissal without mutating its input", () => {
    const { input, facts } = dismissal();
    const record = {
      id: "answer", org_id: facts.item.org_id, work_item_id: facts.item.id,
      query: "Question", event_ids: ["event"], created_at: BEFORE, updated_at: BEFORE,
    };
    const original = structuredClone(record);
    const result = prepareWorkDismissal({ ...input, search_answer_timeout: record }, { ...facts, search_answer: record });
    assert.equal(result.outcome, "applied");
    assert.equal(result.item.status, "skipped");
    assert.deepEqual(result.run, facts.run);
    assert.deepEqual(result.search_answer, { ...record, outcome: "timed_out", updated_at: NOW });
    result.search_answer.event_ids.push("mutated");
    assert.deepEqual(record, original);
    assert.deepEqual(prepareWorkDismissal({ ...input, search_answer_timeout: record }, facts),
      { outcome: "conflict", reason: "stale_search_answer" });
    assert.deepEqual(prepareWorkDismissal({ ...input, search_answer_timeout: record }, {
      ...facts, search_answer: record, run: { ...facts.run, status: "completed" },
    }), { outcome: "conflict", reason: "inactive_search_answer" });
    const skipped = { ...facts.item, status: "skipped" };
    assert.deepEqual(prepareWorkDismissal({
      ...input, expected_item: skipped, search_answer_timeout: record,
    }, { ...facts, item: skipped, search_answer: record }),
    { outcome: "conflict", reason: "inactive_search_answer" });
  });
  it("atomically records cancellation through an active parallel map batch", () => {
    const { input, facts } = dismissal();
    const record = {
      id: "answer",
      org_id: facts.item.org_id,
      work_item_id: "completed-map",
      query: "Question",
      event_ids: ["event"],
      scope: {
        intent: "aggregate",
        complete: true,
        map_reduce: {
          strategy: "map_reduce",
          phase: "mapping",
          snapshot_id: "snapshot",
          batch_offsets: [0, 1],
          total_batches: 1,
          completed_batches: 0,
          facts: [],
          batches: [{
            index: 0,
            start_offset: 0,
            end_offset: 1,
            status: "running",
            attempt: 0,
            work_item_id: facts.item.id,
          }],
        },
      },
      created_at: BEFORE,
      updated_at: BEFORE,
    };
    const result = prepareWorkDismissal({
      ...input,
      search_answer_timeout: record,
      search_answer_outcome: "cancelled",
    }, { ...facts, search_answer: record });
    assert.equal(result.outcome, "applied");
    assert.equal(result.search_answer.outcome, "cancelled");
  });
  for (const status of ["write_back", "uncertain"]) {
    it(`preserves ${status} delivery evidence while recording a stop request`, () => {
      const { input, facts } = dismissal();
      Object.assign(facts.deliveries[0], {
        status, lease_owner: "sender", claim_token: "original-token",
        lease_expires_at: NOW, channel_receipt: { accepted: true, rpc_id: "accepted" },
      });
      const result = prepareWorkDismissal(input, facts);
      assert.equal(result.deliveries[0].status, status);
      assert.equal(result.deliveries[0].cancel_requested_at, NOW);
      assert.equal(result.deliveries[0].claim_token, "original-token");
      assert.deepEqual(result.deliveries[0].channel_receipt, facts.deliveries[0].channel_receipt);
    });
  }
  it("rejects stale items, missing current runs and cross-work delivery identities", () => {
    const { input, facts } = dismissal();
    assert.deepEqual(prepareWorkDismissal(input, { ...facts, item: null }),
      { outcome: "conflict", reason: "missing_work" });
    assert.deepEqual(prepareWorkDismissal(input, { ...facts, item: { ...facts.item, version: 1 } }),
      { outcome: "conflict", reason: "stale_dismissal" });
    assert.deepEqual(prepareWorkDismissal(input, { ...facts, run: null }),
      { outcome: "conflict", reason: "unknown_current_run" });
    assert.throws(() => prepareWorkDismissal(input, { ...facts, run: { ...facts.run, work_item_id: "other" } }),
      /current work item/);
    facts.deliveries[0].org_id = "other";
    assert.throws(() => prepareWorkDismissal(input, facts), /same organization/);
    assert.throws(() => prepareWorkDismissal({ ...input, now: "invalid" }, facts), /valid timestamp/);
  });
});

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
  it("keeps the executor configuration immutable for a run", () => {
    const { run } = fixture();
    run.executor_config = { prompt: "Original", limits: { retries: 2 } };
    run.include_context = true;
    assert.throws(() => assertWorkRunWrite({
      ...run, executor_type: "other",
    }, run), /execution snapshot are immutable/);
    assert.throws(() => assertWorkRunWrite({
      ...run, recipe_id: "other-recipe",
    }, run), /execution snapshot are immutable/);
    assert.doesNotThrow(() => assertWorkRunWrite({
      ...run, executor_config: { limits: { retries: 2 }, prompt: "Original" },
      updated_at: NOW,
    }, run));
    assert.throws(() => assertWorkRunWrite({
      ...run, executor_config: { prompt: "Changed", limits: { retries: 2 } },
    }, run), /immutable/);
    assert.throws(() => assertWorkRunWrite({
      ...run, executor_config: undefined,
    }, run), /immutable/);
    assert.throws(() => assertWorkRunWrite({
      ...run, include_context: false,
    }, run), /immutable/);
    assert.throws(() => assertWorkRunWrite({
      ...run, completion_policy_version: 1,
    }, run), /immutable/);
    assert.throws(() => assertWorkRunWrite({
      ...run, hide_on_success: false,
    }, run), /immutable/);
    assert.throws(() => assertWorkRunWrite(run, {
      ...run, completion_policy_version: 1,
    }), /immutable/);
  });

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

  for (const status of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
    it(`records actual ${status} facts without reopening ignored work or touching delivery`, () => {
      const input = fixture();
      input.item.status = "skipped";
      input.item.current_run_id = input.run.id;
      input.item.version = 3;
      input.handle.status = status;
      const plan = planWorkObservation(input);
      assert.equal(plan.item, input.item);
      assert.equal(plan.item.version, 3);
      assert.equal(plan.run.status, status);
      assert.deepEqual(plan.delivery, { kind: "keep" });
      assert.equal(plan.settled, !["running", "waiting_human"].includes(status));
    });
  }

  it("requires a fresh ignored snapshot and known matching execution before applying actual facts", () => {
    const f = fixture();
    f.item.status = "skipped";
    f.item.current_run_id = f.run.id;
    const input = {
      expected_item: f.item, expected_run: f.run, handle: f.handle,
      can_write_back: true, trigger_kind: "push", now: NOW,
    };
    const facts = { item: f.item, run: f.run, delivery: null };
    assert.equal(prepareWorkObservation(input, facts).outcome, "applied");
    for (const [run, reason] of [
      [{ ...f.run, external_run_id: undefined }, "execution_identity_unknown"],
      [{ ...f.run, external_run_id: "another-execution" }, "execution_identity_mismatch"],
      [{ ...f.run, start_state: "pending" }, "execution_identity_unknown"],
      [{ ...f.run, start_state: "uncertain" }, "execution_identity_unknown"],
    ]) {
      assert.deepEqual(prepareWorkObservation({ ...input, expected_run: run }, { ...facts, run }),
        { outcome: "conflict", reason });
    }
    assert.deepEqual(prepareWorkObservation(input, { ...facts, item: { ...f.item, version: 1 } }),
      { outcome: "conflict", reason: "stale_observation" });
    assert.deepEqual(prepareWorkObservation(input, { ...facts, item: { ...f.item, current_run_id: "successor" } }),
      { outcome: "conflict", reason: "not_current_run" });
  });

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
    input.handle = { status: "running", external_run_id: input.run.external_run_id };
    const plan = planWorkObservation(input);
    assert.equal(plan.run.external_run_id, input.run.external_run_id);
    assert.equal(plan.run.agent_thread_id, input.run.agent_thread_id);
    assert.deepEqual(plan.run.result, input.run.result);
    assert.equal(plan.run.start_state, undefined);
    assert.equal(plan.changed, false);
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
      if (change.agent_thread_id) input.run.agent_thread_id = undefined;
      if (change.external_run_id) input.run.external_run_id = undefined;
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

  it("sends only the message after REPLY and keeps a finished check on the run", () => {
    const input = fixture();
    input.handle.result = {
      summary: "REPLY\n方方，绩效表还没交，请今天补上。\n\nNOTE\n文档缺 10-12 月测算。",
    };
    const sent = planWorkObservation(input);
    assert.equal(sent.run.result.summary, input.handle.result.summary);
    assert.deepEqual(sent.delivery, {
      kind: "enqueue",
      payload: { summary: "方方，绩效表还没交，请今天补上。", content: undefined },
    });

    input.handle.result = {
      summary: "QUIET\n\nNOTE\n已经提交，不需要催。",
    };
    const quiet = planWorkObservation(input);
    assert.equal(quiet.run.result.summary, input.handle.result.summary);
    assert.deepEqual(quiet.delivery, { kind: "keep" });

    input.handle.result = { summary: "NO_REPLY\n已经提交。" };
    assert.deepEqual(planWorkObservation(input).delivery, { kind: "keep" });

    input.handle.result = {
      summary: "HOLD\n\nNOTE\n两套口径冲突，需要你决定催哪一版。",
    };
    const held = planWorkObservation(input);
    assert.deepEqual(held.delivery, { kind: "keep" });

    const done = {
      ...input.item,
      status: "done",
      head_event_id: "event-1",
      current_run_id: input.run.id,
    };
    const finished = {
      ...quiet.run,
      status: "completed",
      external_run_id: "external-1",
      completion_policy_version: 1,
      write_back_required: true,
      result: { summary: "QUIET\n\nNOTE\n已经提交，不需要催。" },
    };
    assert.equal(automaticWorkCompletionReady(done, finished, null), true);
    finished.result = { summary: "REPLY\n请今天补交。" };
    assert.equal(automaticWorkCompletionReady(done, finished, null), false);
    finished.result = { summary: "HOLD\n\nNOTE\n需要你决定。" };
    assert.equal(automaticWorkCompletionReady(done, finished, null), false);
    const unanchored = { ...done };
    delete unanchored.head_event_id;
    finished.result = { summary: "QUIET\n\nNOTE\n已经提交，不需要催。" };
    assert.equal(automaticWorkCompletionReady(unanchored, finished, null), true);
    finished.result = { summary: "HOLD\n\nNOTE\n需要你决定。" };
    assert.equal(automaticWorkCompletionReady(unanchored, finished, null), false);

    input.handle.result = { summary: "REPLY 请今天补上。\n\nNOTE\n内部口径" };
    assert.deepEqual(planWorkObservation(input).delivery, {
      kind: "enqueue",
      payload: { summary: "请今天补上。", content: undefined },
    });
    input.handle.result = { summary: "方方，表已经交了。\n\nNOTE\n内部口径" };
    assert.deepEqual(planWorkObservation(input).delivery, {
      kind: "enqueue",
      payload: { summary: "方方，表已经交了。", content: undefined },
    });
    input.handle.result = { summary: "NOTE\n只有证据" };
    assert.deepEqual(planWorkObservation(input).delivery, { kind: "keep" });
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
