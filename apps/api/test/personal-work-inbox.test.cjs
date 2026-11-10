const assert = require("node:assert/strict");
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
  const hooks = {};
  const executor = {
    executor_type: "stub",
    capabilities: () => ({}),
    async start(input) {
      starts.push(input);
      return hooks.start ? hooks.start(input) : { status: "running" };
    },
  };
  const runtime = {
    orgId: () => ORG,
    requireHost: () => ({ get: (name) => ({
      authority, blobs, executors: { get: () => executor },
    })[name] }),
  };
  const channel = {
    contextFor: () => ({ org_id: ORG }),
    evidenceText: async () => "evidence",
    threadContextLines: async () => ({ lines: [], overflow: false }),
  };
  const supervise = new PersonalWorkSupervise(runtime, channel);
  const makeDispatch = () => new PersonalWorkDispatch(
    runtime, channel, supervise, { attach() {} },
  );
  const recipe = normalizeRecipe({
    id: "messages", name: "Inbox rule",
    match: { thread_id: "chat:room", text_contains: "approve", text_excludes: "draft" },
    trigger: { kind: "push", coalesce: false },
    executor_type: "stub", include_context: false, can_write_back: false,
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
      return result.records[0].event_id;
    },
    async settle() {
      for (const item of await authority.listWorkItems(ORG)) {
        await authority.putWorkItem({ ...item, status: "done" });
      }
      for (const run of await authority.listWorkRuns(ORG)) {
        await authority.putWorkRun({ ...run, status: "completed" });
      }
    },
  };
}

describe("reconcileInbox ordinary push observation", () => {
  it("starts the first ordinary matching inbound, not rejected text or other conversations", async (t) => {
    const f = await fixture(t);
    await f.ingest("please approve this draft");
    await f.ingest("ordinary update without the condition");
    const pending = await f.ingest("aside");
    assert.equal((await f.authority.getDisposition(pending)).disposition, "pending");
    await f.ingest("please approve release", { target: "another" });
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkItems(ORG), []);
    const eventId = await f.ingest("please APPROVE release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    assert.match(f.starts[0].evidence_text, /please APPROVE release/);
    const [item] = await f.authority.listWorkItems(ORG);
    assert.equal(item.record_class, "utterance");
    assert.equal(item.head_event_id, eventId);
    assert.equal(item.unit_key, eventId);
    await f.dispatch.reconcileInbox();
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
  });

  it("handles a short automatically pending message without promoting its disposition", async (t) => {
    const f = await fixture(t, { match: { thread_id: "chat:room", text_contains: "[给客户]" } });
    const id = await f.ingest("[给客户]");
    const before = await f.authority.getDisposition(id);
    assert.equal(before.disposition, "pending");
    assert.deepEqual(before.reason_codes, ["needs_review"]);
    assert.deepEqual(await f.authority.listInbox(ORG), []);
    await f.dispatch.reconcileInbox();
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
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    assert.deepEqual(await f.authority.listWorkDeliveries(ORG), []);
  });

  for (const options of [{ enabled: false }, { trigger: { kind: "manual" } }, { match: { record_class: "task" } }]) {
    it(`does not open ordinary work for ${JSON.stringify(options)}`, async (t) => {
      const f = await fixture(t, options);
      await f.ingest("please approve release");
      await f.dispatch.reconcileInbox();
      assert.equal(f.starts.length, 0);
      assert.deepEqual(await f.authority.listWorkItems(ORG), []);
    });
  }

  it("finds intermediate messages hidden by the conversation face and later messages in the same thread", async (t) => {
    const f = await fixture(t);
    const first = await f.ingest("approve first release");
    await f.ingest("a later ordinary update");
    await f.ingest("approve assistant echo", { kind: "assistant" });
    await f.dispatch.reconcileInbox();
    assert.deepEqual(f.starts.map((input) => input.work_item.head_event_id), [first]);
    const second = await f.ingest("approve second release");
    await f.dispatch.reconcileInbox();
    assert.deepEqual(f.starts.map((input) => input.work_item.head_event_id), [first, second]);
    await f.settle();
    const restarted = f.reopen();
    await restarted.reconcileInbox();
    assert.equal(f.starts.length, 2);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 2);
  });

  it("does not execute human pending, outside-current-work or hidden messages", async (t) => {
    const f = await fixture(t);
    for (const disposition of ["pending", "outside_current_work"]) {
      const id = await f.ingest("approve this release");
      const decision = await f.authority.getDisposition(id);
      await f.authority.putDisposition({
        ...decision, disposition, reason_codes: [...decision.reason_codes, "human_triage"],
      });
    }
    await f.dispatch.reconcileInbox();
    assert.deepEqual(await f.authority.listWorkItems(ORG), []);
    await f.ingest("approve hidden release");
    await f.authority.putConversationPref({
      org_id: ORG, thread_id: "chat:room", hidden: true, updated_at: f.now,
    });
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkItems(ORG), []);
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
      // Exercise the guard even if arrangement would normally remove the echo.
      const decision = await f.authority.getDisposition(id);
      await f.authority.putDisposition({ ...decision, disposition: "current_work" });
    }
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(await f.authority.listWorkItems(ORG), []);
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
    await f.dispatch.reconcileInbox();
    assert.deepEqual(f.starts.map((input) => [input.work_item.head_event_id, input.recipe.id]), [
      [inRoom, f.recipe.id], [inOther, "channel-kind"],
    ]);
  });

  it("pages past unmatched traffic with tied timestamps and eventually catches arrivals and late history", async (t) => {
    const f = await fixture(t);
    const first = await f.ingest("approve oldest release", {
      occurred_at: "2020-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 40; i++) {
      await f.ingest("unmatched ordinary message", { occurred_at: f.now });
    }
    const queries = t.mock.method(f.authority, "listInbox");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 0);
    const recent = await f.ingest("approve recent release");
    const late = await f.ingest("approve late-arriving history", {
      occurred_at: "2019-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 8; i++) await f.dispatch.reconcileInbox();
    assert.deepEqual(new Set(f.starts.map((input) => input.work_item.head_event_id)),
      new Set([first, recent, late]));
    assert.equal(f.starts.length, 3);
    for (const call of queries.mock.calls.filter((call) => call.arguments[1]?.tasks === false)) {
      assert.equal(call.arguments[1].limit, 16);
      assert.equal(call.arguments[1].heads, undefined);
      assert.equal(call.arguments[1].needs_work, true);
      assert.equal(call.arguments[1].push_candidates, true);
    }
    const restart = f.reopen();
    for (let i = 0; i < 4; i++) await restart.reconcileInbox();
    assert.equal(f.starts.length, 3);
  });

  it("does not advance the message page past a failed observation", async (t) => {
    const f = await fixture(t);
    const ids = [];
    for (let i = 0; i < 17; i++) ids.push(await f.ingest(`approve release ${i}`));
    const failed = t.mock.method(f.authority, "listInstallations", async () => {
      throw new Error("store unavailable");
    });
    await assert.rejects(f.dispatch.reconcileInbox(), /store unavailable/);
    failed.mock.restore();
    await f.dispatch.reconcileInbox();
    await f.dispatch.reconcileInbox();
    assert.deepEqual(new Set(f.starts.map((input) => input.work_item.head_event_id)), new Set(ids));
    assert.equal(f.starts.length, ids.length);
  });

  it("keeps order and other task quotas independent of a large message backlog", async (t) => {
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
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.filter((input) => input.work_item.thread_id.startsWith("crm:order:")).length, 16);
    assert.equal(f.starts.filter((input) => input.work_item.thread_id.startsWith("chat:ticket-")).length, 16);
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 40);
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 40);
  });

  it("keeps a capped message queued and starts it through the existing open-slot path", async (t) => {
    const f = await fixture(t, { max_concurrent: 1 });
    const first = await f.ingest("approve first release");
    const second = await f.ingest("approve second release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].work_item.head_event_id, first);
    const items = await f.authority.listWorkItems(ORG);
    assert.equal(items.find((item) => item.head_event_id === second).status, "open");
    const running = items.find((item) => item.head_event_id === first);
    await f.authority.putWorkItem({ ...running, status: "done" });
    const [run] = await f.authority.listWorkRuns(ORG);
    await f.authority.putWorkRun({ ...run, status: "completed" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
    assert.equal(f.starts[1].work_item.head_event_id, second);
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 2);
  });

  for (const exclusion of ["pending", "outside_current_work", "hidden"]) {
    it(`does not bypass ${exclusion} on a previously queued ordinary message`, async (t) => {
      const f = await fixture(t, { max_concurrent: 1 });
      await f.ingest("approve first release");
      const queuedId = await f.ingest("approve second release");
      await f.dispatch.reconcileInbox();
      assert.equal(f.starts.length, 1);
      const [run] = await f.authority.listWorkRuns(ORG);
      const active = await f.authority.getWorkItem(ORG, run.work_item_id);
      await f.authority.putWorkItem({ ...active, status: "done" });
      await f.authority.putWorkRun({ ...run, status: "completed" });
      if (exclusion === "hidden") {
        await f.authority.putConversationPref({
          org_id: ORG, thread_id: "chat:room", hidden: true, updated_at: f.now,
        });
      } else {
        const decision = await f.authority.getDisposition(queuedId);
        await f.authority.putDisposition({
          ...decision, disposition: exclusion, reason_codes: [...decision.reason_codes, "human_triage"],
        });
      }
      await f.dispatch.fillOpenSlots();
      await f.dispatch.reconcileInbox();
      assert.equal(f.starts.length, 1);
    });
  }

  it("uses the existing failed-run backoff rather than retrying each scan", async (t) => {
    const f = await fixture(t);
    f.hooks.start = () => ({ status: "failed" });
    await f.ingest("approve failed release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    await f.dispatch.reconcileInbox();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    await f.authority.putWorkItem({ ...item, updated_at: "2020-01-01T00:00:00.000Z" });
    f.hooks.start = () => ({ status: "running" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts.length, 2);
    assert.equal((await f.authority.getWorkItem(ORG, item.id)).status, "running");
  });

  it("retains coalescing while a run is occupied", async (t) => {
    const f = await fixture(t, { trigger: { kind: "push", coalesce: true } });
    const first = await f.ingest("approve first release");
    await f.dispatch.reconcileInbox();
    await f.ingest("approve second release");
    await f.dispatch.reconcileInbox();
    await f.dispatch.reconcileInbox();
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
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    const pref = await f.authority.getConversationPref(ORG, "chat:room");
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
    const next = await f.ingest("[给客户]");
    assert.equal((await f.authority.getDisposition(next)).disposition, "pending");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 2);
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 2);
  });

  async function finishStartedWork(f, dispatch, status) {
    await dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    const run = await f.authority.getActiveWorkRun(ORG, item.id);
    const recipe = await f.authority.getRecipe(ORG, item.recipe_id);
    await f.supervise.applyHandle(item, recipe, run, {
      external_run_id: "stub-run",
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
      const item = {
        id: `item-${kind}`, org_id: ORG, thread_id: "chat:room", unit_key: `unit-${kind}`,
        record_class: "utterance", thread_facet: "chat", status: "running",
        recipe_id: f.recipe.id, created_at: f.now, updated_at: f.now,
      };
      const run = {
        id: `run-${kind}`, org_id: ORG, work_item_id: item.id, recipe_id: f.recipe.id,
        executor_type: "stub", status: "running", created_at: f.now, updated_at: f.now,
      };
      await f.authority.putWorkItem(item);
      await f.authority.putWorkRun(run);
      await f.supervise.applyHandle(item, f.recipe, run, {
        external_run_id: `external-${kind}`, status: "completed",
      });
      const pref = await f.authority.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.hidden, true);
      assert.equal(pref.hidden_reason, "policy");
    });
  }

  it("does not replace a human-hidden conversation preference after success", async (t) => {
    const f = await fixture(t, { hide_on_success: true });
    await f.ingest("approve this release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    const [item] = await f.authority.listWorkItems(ORG);
    const run = await f.authority.getActiveWorkRun(ORG, item.id);
    const recipe = await f.authority.getRecipe(ORG, item.recipe_id);
    await f.authority.putConversationPref({
      org_id: ORG, thread_id: "chat:room", hidden: true, hidden_reason: "human",
      updated_at: f.now,
    });
    await f.supervise.applyHandle(item, recipe, run, {
      external_run_id: "stub-run", status: "completed", result: { summary: "done" },
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
    await f.dispatch.reconcileInbox();
    const [delivery] = await f.authority.listWorkDeliveries(ORG);
    assert.equal(delivery.payload.summary, "approve this result");
    await f.ingest(delivery.payload.summary, {
      direction: "outbound", external_id: "room:out:rule-result",
    });
    await f.dispatch.reconcileInbox();
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts.length, 1);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 1);
    assert.equal((await f.authority.listWorkDeliveries(ORG)).length, 1);
  });
});
