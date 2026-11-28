const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  INGEST_SCHEMA_VERSION, IngestionService, channelRecord,
  DEFAULT_PERSONAL_DISPATCH_POLICY, PERSONAL_DISPATCH_POLICY_PREF_KEY,
} = require("@regenic/domain");
const { PersonalWorkDispatch } = require("../dist/personal-work-dispatch");
const { PersonalWorkSupervise } = require("../dist/personal-work-supervise");
const { normalizeRecipe } = require("../dist/personal-work-recipe");

const ORG = "local-owner";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "regenic-work-inbox-"));
  const path = join(root, "authority.db");
  let authority = new SqliteAuthorityStore(path);
  const blobs = new FsBlobStore(join(root, "blobs"));
  t.after(async () => {
    authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const starts = [];
  const texts = new Map();
  const hooks = {};
  const executor = {
    executor_type: "stub",
    capabilities: () => ({}),
    async start(input) {
      starts.push(input);
      return { external_run_id: `stub-${starts.length}`,
        ...(hooks.start ? hooks.start(input) : { status: "running" }) };
    },
  };
  const runtime = {
    orgId: () => ORG,
    getOptions: () => ({ database: path }),
    requireHost: () => ({ get: (name) => ({
      authority, blobs, executors: { get: () => executor },
    })[name] }),
  };
  const channel = {
    contextFor: () => ({ org_id: ORG }),
    evidenceText: async (_, eventId) => texts.get(eventId),
    freezeWriteBackTarget: async () => ({ installation_id: "fixture", source: "chat", target: "room" }),
    threadContextLines: async () => ({ lines: [], overflow: false }),
  };
  const supervise = new PersonalWorkSupervise(runtime, channel);
  const makeDispatch = () => new PersonalWorkDispatch(
    runtime, channel, supervise, { attach() {} }, undefined, undefined, () => 1,
  );
  const recipe = normalizeRecipe({
    id: "messages", name: "Inbox rule",
    match: { thread_id: "chat:room", text_contains: "approve", text_excludes: "draft" },
    trigger: { kind: "push", coalesce: false },
    executor_type: "stub", include_context: false, can_write_back: false, hide_on_success: true,
    ...options,
  }, ORG, now);
  await authority.putRecipe(recipe);
  let sequence = 0;
  return {
    get authority() { return authority; },
    starts, hooks, recipe, now, supervise, dispatch: makeDispatch(), makeDispatch,
    reopen() {
      authority.close();
      authority = new SqliteAuthorityStore(path);
      return makeDispatch();
    },
    async ingest(text, fields = {}) {
      sequence++;
      const { source = "chat", target = "room", ...recordFields } = fields;
      const result = await new IngestionService(blobs, authority).ingest({
        schema_version: INGEST_SCHEMA_VERSION,
        connector_id: "fixture", org_id: ORG, delivery_id: `delivery-${sequence}`,
        received_at: now,
        records: [channelRecord({
          channel: source, kind: "user", direction: "inbound", type: "message",
          external_id: `${target}:message-${sequence}`, scope_id: target,
          occurred_at: new Date(Date.parse(now) + sequence * 1000).toISOString(),
          actor_id: "person", text, ...recordFields,
        })],
      });
      const eventId = result.records[0].event_id;
      texts.set(eventId, text);
      return eventId;
    },
    async settle() {
      for (const run of await authority.listWorkRuns(ORG)) {
        if (run.status !== "running") continue;
        const item = await authority.getWorkItem(ORG, run.work_item_id);
        const currentRecipe = await authority.getRecipe(ORG, run.recipe_id);
        await supervise.applyHandle(item, currentRecipe, run, {
          external_run_id: run.external_run_id, status: "completed", result: { summary: "done" },
        });
      }
    },
    async triage(eventId, disposition) {
      const expected = await authority.getDisposition(eventId);
      const result = await authority.transitionDisposition({
        expected,
        decision: { ...expected, disposition,
          reason_codes: [...expected.reason_codes, "human_triage"], decided_at: now },
        command: { org_id: ORG, event_id: eventId, action: "triage", disposition,
          command_id: randomUUID(), issued_at: now },
      });
      assert.equal(result.outcome, "applied");
    },
    async hide() {
      const pref = await authority.getConversationPref(ORG, "chat:room");
      const result = await authority.setConversationVisibility({
        org_id: ORG, thread_id: "chat:room", hidden: true,
        expected_version: pref?.visibility_version ?? 0,
        command_id: randomUUID(), issued_at: now, updated_at: now,
      });
      assert.equal(result.outcome, "applied");
    },
  };
}

describe("fillOpenSlots ordinary push observation", () => {
  it("starts the first ordinary matching inbound, not rejected text or other conversations", async (t) => {
    const f = await fixture(t);
    await f.ingest("please approve this draft");
    await f.ingest("ordinary update without the condition");
    const pending = await f.ingest("aside");
    assert.equal((await f.authority.getDisposition(pending)).disposition, "current_work");
    await f.ingest("please approve release", { target: "another" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkRuns(ORG), []);
    const eventId = await f.ingest("please APPROVE release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    assert.match(f.starts[0].evidence_text, /please APPROVE release/);
    const item = (await f.authority.listWorkItems(ORG)).find((item) => item.head_event_id === eventId);
    assert.equal(item.record_class, "utterance");
    assert.equal(item.head_event_id, eventId);
    assert.equal(item.unit_key, eventId);
    await f.dispatch.fillOpenSlots();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
  });

  it("handles a short automatically pending message without promoting its disposition", async (t) => {
    const f = await fixture(t, { match: { thread_id: "chat:room", text_contains: "[给客户]" } });
    const id = await f.ingest("[给客户]");
    const before = await f.authority.getDisposition(id);
    assert.equal(before.disposition, "current_work");
    assert.deepEqual(before.reason_codes, ["default_personal_attention"]);
    assert.equal((await f.authority.listInbox(ORG)).length, 1);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].work_item.head_event_id, id);
    assert.deepEqual(await f.authority.getDisposition(id), before);
  });

  it("treats a saved automatic pending policy as classification, not a send or approval grant", async (t) => {
    const f = await fixture(t);
    await f.authority.putUiPref(ORG, PERSONAL_DISPATCH_POLICY_PREF_KEY,
      JSON.stringify({ ...DEFAULT_PERSONAL_DISPATCH_POLICY, default_disposition: "pending" }), f.now);
    const id = await f.ingest("approve this ordinary release");
    assert.equal((await f.authority.getDisposition(id)).disposition, "pending");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
  });

  for (const options of [{ enabled: false }, { trigger: { kind: "manual" } }, { match: { record_class: "task" } }]) {
    it(`does not open ordinary work for ${JSON.stringify(options)}`, async (t) => {
      const f = await fixture(t, options);
      await f.ingest("please approve release");
      await f.dispatch.fillOpenSlots();
      assert.equal(f.starts.length, 0);
      assert.deepEqual(await f.authority.listWorkRuns(ORG), []);
    });
  }

  it("finds intermediate messages hidden by the conversation face and later messages in the same thread", async (t) => {
    const f = await fixture(t);
    const first = await f.ingest("approve first release");
    await f.ingest("a later ordinary update");
    await f.ingest("approve assistant echo", { kind: "assistant" });
    await f.dispatch.fillOpenSlots();
    assert.deepEqual(f.starts.map((input) => input.work_item.head_event_id), [first]);
    const second = await f.ingest("approve second release");
    await f.dispatch.fillOpenSlots();
    assert.deepEqual(f.starts.map((input) => input.work_item.head_event_id), [first, second]);
    await f.settle();
    const restarted = f.reopen();
    await restarted.fillOpenSlots();
    assert.equal(f.starts.length, 2);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 2);
  });

  it("does not execute human pending, outside-current-work or hidden messages", async (t) => {
    const f = await fixture(t);
    for (const disposition of ["pending", "outside_current_work"]) {
      const id = await f.ingest("approve this release");
      await f.triage(id, disposition);
    }
    await f.dispatch.fillOpenSlots();
    assert.deepEqual(await f.authority.listWorkRuns(ORG), []);
    await f.ingest("approve hidden release");
    await f.hide();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkRuns(ORG), []);
  });

  it("rejects outbound, local send IDs, assistant/system utterances and rule write-back echoes", async (t) => {
    const f = await fixture(t);
    for (const fields of [
      { direction: "outbound" },
      { external_id: "room:out:local-1" },
      { kind: "assistant" },
      { kind: "system" },
      { direction: "outbound", external_id: "room:out:work-result" },
    ]) {
      const id = await f.ingest("approve this echoed release", fields);
      const expected = await f.authority.getDisposition(id);
      if (expected.disposition !== "current_work") {
        await f.triage(id, "current_work");
      }
    }
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkRuns(ORG), []);
  });

  it("preserves source/unit-kind matching and the more specific recipe's priority", async (t) => {
    const f = await fixture(t);
    await f.authority.putRecipe(normalizeRecipe({
      ...f.recipe, id: "channel-kind",
      match: { source: "chat", unit_kind: "notice", text_contains: "approve" },
    }, ORG, f.now));
    const inRoom = await f.ingest("approve room release", { unit_kind: "notice" });
    const inOther = await f.ingest("approve other release", { target: "another", unit_kind: "notice" });
    await f.ingest("approve unrelated kind", { target: "another", unit_kind: "unrelated" });
    await f.dispatch.fillOpenSlots();
    assert.deepEqual(new Map(f.starts.map((input) => [input.work_item.head_event_id, input.recipe.id])),
      new Map([[inRoom, f.recipe.id], [inOther, "channel-kind"]]));
  });

  it("admits arrivals and late history atomically without scanning unmatched inbox traffic", async (t) => {
    const f = await fixture(t);
    const first = await f.ingest("approve oldest release", {
      occurred_at: "2020-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 40; i++) {
      await f.ingest("unmatched ordinary message", { occurred_at: f.now });
    }
    const queries = t.mock.method(f.authority, "listInbox");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const recent = await f.ingest("approve recent release");
    const late = await f.ingest("approve late-arriving history", {
      occurred_at: "2019-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 8; i++) await f.dispatch.fillOpenSlots();
    assert.deepEqual(new Set(f.starts.map((input) => input.work_item.head_event_id)),
      new Set([first, recent, late]));
    assert.equal(f.starts.length, 3);
    assert.equal(queries.mock.calls.length, 0);
    const restart = f.reopen();
    for (let i = 0; i < 4; i++) await restart.fillOpenSlots();
    assert.equal(f.starts.length, 3);
  });

  it("dispatches order and other tasks independently of unmatched message intake", async (t) => {
    const f = await fixture(t);
    const tasks = normalizeRecipe({
      ...f.recipe, id: "tasks", match: { record_class: "task" },
    }, ORG, f.now);
    await f.authority.putRecipe(tasks);
    for (let i = 0; i < 20; i++) {
      await f.ingest("order task", { source: "crm", target: `order:${i}`, type: "task", kind: "system" });
      await f.ingest("other task", { target: `ticket-${i}`, type: "task" });
    }
    for (let i = 0; i < 40; i++) await f.ingest("unmatched ordinary traffic");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.filter((input) => input.work_item.thread_id.startsWith("crm:order:")).length, 20);
    assert.equal(f.starts.filter((input) => input.work_item.thread_id.startsWith("chat:ticket-")).length, 20);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 40);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 40);
  });

  it("keeps a capped message queued and starts it through the existing open-slot path", async (t) => {
    const f = await fixture(t, { max_concurrent: 1 });
    const first = await f.ingest("approve first release");
    await f.dispatch.fillOpenSlots();
    const second = await f.ingest("approve second release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].work_item.head_event_id, first);
    const items = await f.authority.listWorkItems(ORG);
    assert.equal(items.find((item) => item.head_event_id === second).status, "open");
    await f.settle();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
    assert.equal(f.starts[1].work_item.head_event_id, second);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
  });

  for (const exclusion of ["pending", "outside_current_work", "hidden"]) {
    it(`does not bypass ${exclusion} on a previously queued ordinary message`, async (t) => {
      const f = await fixture(t, { max_concurrent: 1 });
      await f.ingest("approve first release");
      await f.dispatch.fillOpenSlots();
      const queuedId = await f.ingest("approve second release");
      await f.dispatch.fillOpenSlots();
      assert.equal(f.starts.length, 1);
      await f.settle();
      if (exclusion === "hidden") {
        await f.hide();
      } else {
        await f.triage(queuedId, exclusion);
      }
      await f.dispatch.fillOpenSlots();
      await f.dispatch.fillOpenSlots();
      assert.equal(f.starts.length, 1);
    });
  }

  it("retains coalescing while a run is occupied", async (t) => {
    const f = await fixture(t, { trigger: { kind: "push", coalesce: true } });
    const first = await f.ingest("approve first release");
    await f.dispatch.fillOpenSlots();
    await f.ingest("approve second release");
    await f.dispatch.fillOpenSlots();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    assert.equal(item.head_event_id, first);
    assert.equal((await f.authority.listWorkItems(ORG)).length, 1);
  });

  it("observes a second short pending message after completion policy-folded the conversation", async (t) => {
    const f = await fixture(t, {
      match: { thread_id: "chat:room", text_contains: "[给客户]" },
      hide_on_success: true,
    });
    f.hooks.start = () => ({ status: "completed", result: { summary: "done" } });
    await f.ingest("[给客户]");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const pref = await f.authority.getConversationPref(ORG, "chat:room");
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
    const next = await f.ingest("[给客户]");
    assert.equal((await f.authority.getDisposition(next)).disposition, "current_work");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
  });

  it("automatically completes an explicitly matched pending message without hiding an opted-out result", async (t) => {
    const f = await fixture(t, {
      match: { thread_id: "chat:room", text_contains: "[给客户]" },
      hide_on_success: false,
    });
    const id = await f.ingest("[给客户]");
    assert.equal((await f.authority.getDisposition(id)).disposition, "current_work");
    await f.dispatch.fillOpenSlots();
    const [run] = await f.authority.listWorkRuns(ORG);
    assert.equal(run.hide_on_success, false);
    await f.authority.putRecipe({ ...f.recipe, hide_on_success: true });
    await f.settle();
    assert.equal((await f.authority.getDisposition(id)).disposition, "outside_current_work");
    assert.equal(await f.authority.getConversationPref(ORG, "chat:room"), null);
    const shown = await f.authority.listInbox(ORG, { list: "shown", heads: true });
    assert.ok(shown.some((item) => item.event.id === id));
  });

  async function finishStartedWork(f, dispatch, status) {
    await dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    const run = await f.authority.getActiveWorkRun(ORG, item.id);
    const recipe = await f.authority.getRecipe(ORG, item.recipe_id);
    await f.supervise.applyHandle(item, recipe, run, {
      external_run_id: run.external_run_id,
      status,
      ...(status === "completed" ? { result: { summary: "done" } } : {}),
    });
    return f.authority.getConversationPref(ORG, item.thread_id);
  }

  it("persists the selected hide setting across SQLite reopen and hides after success when enabled", async (t) => {
    const f = await fixture(t, { hide_on_success: true });
    f.reopen();
    assert.equal((await f.authority.getRecipe(ORG, f.recipe.id)).hide_on_success, true);
    await f.ingest("approve this release");
    const pref = await finishStartedWork(f, f.makeDispatch(), "completed");
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
  });

  it("keeps a successful result visible when hide-on-success is disabled", async (t) => {
    const f = await fixture(t, { hide_on_success: false });
    await f.ingest("approve this release");
    assert.equal(await finishStartedWork(f, f.dispatch, "completed"), null);
  });

  it("does not hide a failed run even when hide-on-success is enabled", async (t) => {
    const f = await fixture(t, { hide_on_success: true });
    await f.ingest("approve this release");
    assert.equal(await finishStartedWork(f, f.dispatch, "failed"), null);
    assert.equal((await f.authority.listWorkItems(ORG))[0].status, "failed");
  });

  for (const kind of ["pull", "manual"]) {
    it(`applies hide-on-success to ${kind} runs too`, async (t) => {
      const f = await fixture(t, {
        trigger: { kind, ...(kind === "pull" ? { interval_ms: 60_000 } : {}) },
        hide_on_success: true,
      });
      await f.ingest("approve this request", { type: "task" });
      let item = await f.authority.getWorkItemByThread(ORG, "chat:room");
      assert.ok(item);
      if (item.recipe_id !== f.recipe.id) {
        const bound = await f.authority.observeWorkItem({
          expected_item: item, item: { ...item, recipe_id: f.recipe.id },
        });
        assert.equal(bound.outcome, "applied");
        item = bound.item;
      }
      f.hooks.start = () => ({ status: "completed", result: { summary: "done" } });
      await f.dispatch.startItem(item, f.recipe, undefined, kind === "manual" ? "manual" : "auto");
      const pref = await f.authority.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.hidden, true);
      assert.equal(pref.hidden_reason, "policy");
    });
  }

  it("does not replace a human-hidden conversation preference after success", async (t) => {
    const f = await fixture(t, { hide_on_success: true });
    await f.ingest("approve this release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    const run = await f.authority.getActiveWorkRun(ORG, item.id);
    const recipe = await f.authority.getRecipe(ORG, item.recipe_id);
    await f.hide();
    await f.supervise.applyHandle(item, recipe, run, {
      external_run_id: run.external_run_id, status: "completed", result: { summary: "done" },
    });
    const pref = await f.authority.getConversationPref(ORG, item.thread_id);
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "human");
  });

  it("treats a stored recipe without the new field as a legacy hide-on-success rule", async (t) => {
    const f = await fixture(t);
    const legacy = { ...f.recipe };
    delete legacy.hide_on_success;
    await f.authority.putRecipe(legacy);
    assert.equal((await f.authority.getRecipe(ORG, f.recipe.id)).hide_on_success, true);
    await f.ingest("approve legacy release");
    const pref = await finishStartedWork(f, f.dispatch, "completed");
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
  });

  it("does not trigger again when the completed rule's queued result returns as an outbound echo", async (t) => {
    const f = await fixture(t, { can_write_back: true });
    f.hooks.start = () => ({ status: "completed", result: { summary: "approve this result" } });
    await f.ingest("approve this request");
    await f.dispatch.fillOpenSlots();
    const [delivery] = await f.authority.listWorkDeliveries(ORG);
    assert.equal(delivery.payload.summary, "approve this result");
    await f.ingest(delivery.payload.summary, {
      direction: "outbound", external_id: "room:out:rule-result",
    });
    await f.dispatch.fillOpenSlots();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 1);
    assert.equal((await f.authority.listWorkDeliveries(ORG)).length, 1);
  });
});
