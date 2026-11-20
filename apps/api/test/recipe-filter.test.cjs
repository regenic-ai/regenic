const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const { normalizeRecipe } = require("../dist/personal-work-recipe");
const { PersonalWorkDispatch } = require("../dist/personal-work-dispatch");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalConnectorError } = require("../dist/personal-errors");

const ORG = "local-owner";

async function fixture(t, options = {}) {
  const writeBack = options.writeBack;
  const recipeOptions = { ...options };
  delete recipeOptions.writeBack;
  const root = await mkdtemp(join(tmpdir(), "regenic-recipe-filter-"));
  const authority = new SqliteAuthorityStore(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  t.after(async () => {
    authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const recipe = normalizeRecipe({
    id: "filtered", name: "Filtered rule",
    match: { thread_id: "test-chat:room", text_contains: "approve", text_excludes: "draft" },
    executor_type: "test", include_context: false, can_write_back: false,
    ...recipeOptions,
  }, ORG, now);
  await authority.putRecipe(recipe);
  let starts = 0;
  let lastTaskInstruction;
  const executor = {
    executor_type: "test",
    capabilities: () => ({}),
    async start(input) {
      starts++;
      lastTaskInstruction = input.task_instruction;
      return { status: "running", external_run_id: `execution-${starts}` };
    },
  };
  const runtime = {
    orgId: () => ORG,
    requireHost: () => ({ get: (name) => ({
      authority, blobs, executors: { get: () => executor },
    })[name] }),
  };
  const dispatch = new PersonalWorkDispatch(runtime, {
    contextFor: () => ({ org_id: ORG }),
    evidenceText: async () => "formatted evidence",
    threadContextLines: async () => ({ lines: [], overflow: false }),
    freezeWriteBackTarget: async (threadId) => {
      if (writeBack?.freeze) {
        return writeBack.freeze(threadId);
      }
      throw new Error("write-back was not expected");
    },
  }, {
    applyHandle: async () => {},
    allowsWriteBack: () => writeBack?.allows === true,
  }, { attach() {} });
  let sequence = 0;
  const ingest = async (text, options = {}) => {
    sequence++;
    const scopeId = options.scopeId ?? "room";
    const result = await new IngestionService(blobs, authority).ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "fixture", org_id: ORG, delivery_id: `delivery-${sequence}`,
      received_at: now,
      records: [channelRecord({
        channel: "test-chat", kind: "user", direction: "inbound",
        external_id: `${scopeId}:message-${sequence}`, scope_id: scopeId,
        ...(options.scopeName ? { scope_name: options.scopeName } : {}),
        occurred_at: new Date(Date.parse(now) + sequence * 1000).toISOString(),
        actor_id: "person", type: options.type ?? "task", text,
      })],
    });
    return result.records[0].event_id;
  };
  const service = new PersonalWorkService(
    runtime, {}, { ensureMounted: async () => {} }, { touchInboxDigest() {} }, {}, {},
  );
  service.dispatch = dispatch;
  return {
    authority,
    recipe,
    dispatch,
    service,
    ingest,
    starts: () => starts,
    taskInstruction: () => lastTaskInstruction,
    now,
  };
}

describe("recipe text filters", () => {
  it("defaults new rules to visible results and keeps the legacy default when editing", () => {
    const created = normalizeRecipe({
      name: "Keep visible", executor_type: "test",
      match: { thread_id: "test-chat:room" },
    }, ORG, "now");
    assert.equal(created.hide_on_success, false);
    assert.equal(normalizeRecipe({ name: "Renamed" }, ORG, "later", created).hide_on_success, false);
    assert.equal(normalizeRecipe({ hide_on_success: true }, ORG, "later", created).hide_on_success, true);

    const legacy = { ...created };
    delete legacy.hide_on_success;
    assert.equal(normalizeRecipe({ name: "Legacy edit" }, ORG, "later", legacy).hide_on_success, true);
    assert.throws(() => normalizeRecipe({
      name: "Invalid", executor_type: "test",
      match: { thread_id: "test-chat:room" },
      hide_on_success: "yes",
    }, ORG, "now"), (error) => error.code === "invalid_config");
  });

  it("validates filters, preserves exact strings and allows clearing them", () => {
    const input = {
      name: "Filter", executor_type: "test",
      match: { record_class: "task", text_contains: " approve ", text_excludes: "draft" },
    };
    const saved = normalizeRecipe(input, ORG, "now");
    assert.deepEqual(saved.match, input.match);
    assert.deepEqual(normalizeRecipe({ name: "Renamed" }, ORG, "later", saved).match, input.match);
    assert.deepEqual(normalizeRecipe({ match: { record_class: "task" } }, ORG, "later", saved).match,
      { record_class: "task" });
    const titled = {
      ...input,
      match: { ...input.match, title_contains: " 周报 ", title_excludes: "草稿" },
    };
    assert.deepEqual(normalizeRecipe(titled, ORG, "now").match, titled.match);
    for (const key of ["text_contains", "text_excludes", "title_contains", "title_excludes"]) {
      for (const value of [null, 42, true, [], {}, "", "   "]) {
        assert.throws(() => normalizeRecipe({
          ...input, match: { record_class: "task", [key]: value },
        }, ORG, "now"), (error) => error.code === "invalid_config");
      }
    }
    assert.throws(() => normalizeRecipe({
      ...input, match: { text_contains: "approve" },
    }, ORG, "now"), (error) => error.code === "invalid_config");
  });

  it("round-trips both filters in the authority store", async (t) => {
    const f = await fixture(t);
    assert.deepEqual((await f.authority.getRecipe(ORG, f.recipe.id)).match, f.recipe.match);
    assert.deepEqual((await f.authority.listRecipes(ORG))[0].match, f.recipe.match);
  });

  it("starts only matching push events while still ingesting rejected tasks", async (t) => {
    const f = await fixture(t);
    await f.ingest("please APPROVE this DRAFT");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkItems(ORG)).length, 1);
    await f.ingest("please APPROVE this release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
    const runs = await f.authority.listWorkRuns(ORG);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].recipe_id, f.recipe.id);
  });

  it("does not start an existing work item after its trigger leaves current work", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("please approve this release");
    const event = await f.authority.getEvent(ORG, eventId);
    const observed = await f.authority.getWorkItemByUnitKey(ORG, event.thread_id, event.id);
    assert.ok(observed);
    const decision = await f.authority.getDisposition(event.id);
    assert.ok(decision);
    const decidedAt = new Date(Date.parse(event.ingested_at) + 1).toISOString();
    const updatedDecision = {
      ...decision,
      disposition: "outside_current_work",
      reason_codes: ["manual_triage"],
      score: 0,
      decided_at: decidedAt,
    };
    const transition = await f.authority.transitionDisposition({
      expected: decision,
      decision: updatedDecision,
      command: {
        org_id: ORG,
        event_id: event.id,
        action: "triage",
        disposition: updatedDecision.disposition,
        command_id: "recipe-filter-triage",
        issued_at: decidedAt,
      },
    });
    assert.equal(transition.outcome, "applied");

    await f.dispatch.fillOpenSlots();

    assert.equal(f.starts(), 0);
    assert.deepEqual(
      await f.authority.getWorkItem(ORG, observed.id),
      observed,
    );
  });

  it("does not bypass changed filters through fill-open-slots or manual starts", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("please approve this draft");
    const item = await f.authority.getWorkItemByUnitKey(ORG, "test-chat:room", eventId);
    assert.ok(item);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    await assert.rejects(f.dispatch.startItem(item, f.recipe, "approve", "manual"),
      (error) => error.code === "invalid_config");
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 0);
  });

  it("does not retroactively bind a rule to work observed before the rule existed", async (t) => {
    const f = await fixture(t);
    await f.authority.deleteRecipe(ORG, f.recipe.id);
    await f.ingest("approve release");
    await f.dispatch.fillOpenSlots();
    const before = (await f.authority.listWorkItems(ORG))[0];
    assert.equal(before.recipe_id, undefined);
    assert.equal(f.starts(), 0);
    await f.authority.putRecipe(f.recipe);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    const saved = await f.authority.getWorkItem(ORG, before.id);
    assert.deepEqual(saved, before);
  });

  it("does not bind a matching filtered rule before its start has capacity", async (t) => {
    const f = await fixture(t, { max_concurrent: 1 });
    await f.authority.deleteRecipe(ORG, f.recipe.id);
    await f.ingest("approve release");
    await f.dispatch.fillOpenSlots();
    const before = (await f.authority.listWorkItems(ORG))[0];
    await f.authority.putRecipe(f.recipe);
    const occupiedItem = {
      id: "occupied",
      org_id: ORG,
      thread_id: "test-chat:occupied",
      unit_key: "occupied",
      record_class: "task",
      thread_facet: "ticket",
      recipe_id: f.recipe.id,
      status: "open",
      created_at: f.now,
      updated_at: f.now,
    };
    const created = await f.authority.createWorkItem({
      item: occupiedItem,
      recipe: f.recipe,
      expected_recipe: f.recipe,
    });
    assert.equal(created.outcome, "applied");
    assert.equal(await f.authority.claimWorkRunStart({
      run: {
        id: "occupied-run",
        org_id: ORG,
        work_item_id: occupiedItem.id,
        recipe_id: f.recipe.id,
        executor_type: f.recipe.executor_type,
        status: "running",
        start_state: "pending",
        created_at: f.now,
        updated_at: f.now,
      },
      expected_item: created.item,
      expected_recipe: f.recipe,
      max_concurrent: 1,
    }), true);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    assert.deepEqual(await f.authority.getWorkItem(ORG, before.id), before);
  });

  it("does not bind or revive a filtered sample ignored during automatic reservation", async (t) => {
    const f = await fixture(t);
    await f.authority.deleteRecipe(ORG, f.recipe.id);
    await f.ingest("approve release");
    await f.dispatch.fillOpenSlots();
    const before = (await f.authority.listWorkItems(ORG))[0];
    await f.authority.putRecipe(f.recipe);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    assert.deepEqual(await f.authority.getWorkItem(ORG, before.id), before);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 0);
  });

  it("ignores a rejected follow-up while a matching run is active", async (t) => {
    const f = await fixture(t);
    const acceptedId = await f.ingest("approve release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
    await f.ingest("approve draft");
    await f.dispatch.fillOpenSlots();
    const running = (await f.authority.listWorkItems(ORG)).find((item) => item.status === "running");
    assert.equal(running.head_event_id, acceptedId);
    assert.equal(f.starts(), 1);
  });

  it("does not use a newer matching message to start a rejected older work unit", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("approve draft");
    await f.ingest("approve release");
    const item = await f.authority.getWorkItemByUnitKey(ORG, "test-chat:room", eventId);
    assert.ok(item);
    await f.dispatch.startItem(item, f.recipe);
    assert.equal(f.starts(), 0);
  });

  it("rejects a nonmatching try and anchors a matching try to the latest message", async (t) => {
    const f = await fixture(t);
    const rejectedId = await f.ingest("approve draft");
    const old = await f.authority.getWorkItemByUnitKey(ORG, "test-chat:room", rejectedId);
    assert.ok(old);
    await assert.rejects(f.service.tryRecipe(f.recipe.id, {}),
      (error) => error.code === "invalid_config");
    assert.equal((await f.authority.getWorkItem(ORG, old.id)).status, "open");
    const latestId = await f.ingest("approve release");
    const result = await f.service.tryRecipe(f.recipe.id, {});
    assert.notEqual(result.work_item.id, old.id);
    assert.equal(result.work_item.head_event_id, latestId);
    assert.equal(result.work_item.recipe_id, f.recipe.id);
  });

  it("starts scheduled work regardless of stored text conditions and advances the schedule", async (t) => {
    const f = await fixture(t, { trigger: { kind: "pull", interval_ms: 60_000 } });
    await f.ingest("approve draft");
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 1);
    const items = await f.authority.listWorkItems(ORG);
    assert.equal(items.length, 2);
    assert.equal(items.filter((item) => item.recipe_id === f.recipe.id).length, 1);
    assert.ok((await f.authority.getRecipe(ORG, f.recipe.id)).next_run_at > f.now);
    assert.deepEqual((await f.authority.getRecipe(ORG, f.recipe.id)).match, f.recipe.match);
  });

  it("does not start or advance a scheduled occurrence when atomic creation conflicts", async (t) => {
    const f = await fixture(t, { trigger: { kind: "pull", interval_ms: 60_000 } });
    const before = await f.authority.getRecipe(ORG, f.recipe.id);
    const create = t.mock.method(f.authority, "createWorkItem", async () => ({
      outcome: "conflict", reason: "stale_recipe",
    }));
    await f.dispatch.dispatchPullRecipes();
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0].arguments[0].expected_recipe.id, f.recipe.id);
    assert.equal(f.starts(), 0);
    assert.deepEqual(await f.authority.listWorkItems(ORG), []);
    assert.deepEqual(await f.authority.getRecipe(ORG, f.recipe.id), before);
  });

  it("resumes a queued scheduled occurrence when the latest message stops matching", async (t) => {
    const f = await fixture(t, { trigger: { kind: "pull", interval_ms: 60_000 } });
    await f.ingest("approve release");
    const queued = t.mock.method(f.dispatch, "startItem", async () => undefined);
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 0);
    const item = (await f.authority.listWorkItems(ORG)).find((candidate) =>
      candidate.recipe_id === f.recipe.id);
    assert.ok(item);
    assert.equal(item.status, "open");
    assert.equal(item.head_event_id, undefined);
    queued.mock.restore();
    await f.ingest("approve draft");
    // The active occurrence prevents opening a second one; the queue must still drain.
    await f.dispatch.dispatchPullRecipes();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
    assert.equal((await f.authority.getWorkItem(ORG, item.id)).status, "running");
    assert.equal((await f.authority.listWorkItems(ORG)).length, 3);
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
  });

  it("fans a scheduled rule out across matching conversations and caps starts", async (t) => {
    const f = await fixture(t, {
      match: { record_class: "task", source: "test-chat" },
      trigger: { kind: "pull", interval_ms: 60_000 },
      max_concurrent: 1,
      can_write_back: false,
      include_context: false,
    });
    await f.ingest("review one", { scopeId: "room" });
    await f.ingest("review two", { scopeId: "other" });
    await f.dispatch.dispatchPullRecipes();
    const opened = (await f.authority.listWorkItems(ORG)).filter(
      (item) => item.recipe_id === f.recipe.id,
    );
    assert.equal(opened.length, 2);
    assert.equal(f.starts(), 1);
    assert.ok((await f.authority.getRecipe(ORG, f.recipe.id)).next_run_at > f.now);
  });

  it("sweeps a task conversation after a later message", async (t) => {
    const f = await fixture(t, {
      match: { record_class: "task", source: "test-chat" },
      trigger: { kind: "pull", interval_ms: 60_000 },
      can_write_back: false,
      include_context: false,
    });
    await f.ingest("review the task", { scopeId: "room" });
    await f.ingest("following up", { scopeId: "room", type: "message" });
    await f.dispatch.dispatchPullRecipes();
    const opened = (await f.authority.listWorkItems(ORG)).filter(
      (item) => item.recipe_id === f.recipe.id,
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0].record_class, "task");
    assert.equal(f.starts(), 1);
  });

  it("continues a sweep when one conversation cannot take a reply", async (t) => {
    const f = await fixture(t, {
      match: { record_class: "task", source: "test-chat" },
      trigger: { kind: "pull", interval_ms: 60_000 },
      can_write_back: true,
      include_context: false,
      writeBack: {
        allows: true,
        freeze: async (threadId) => {
          if (threadId.endsWith(":quiet")) {
            throw new PersonalConnectorError(
              "no_sender",
              "Write-back destination is unavailable",
              409,
            );
          }
          return { installation_id: "inst", source: "test-chat", target: "room" };
        },
      },
    });
    await f.ingest("review one", { scopeId: "quiet" });
    await f.ingest("review two", { scopeId: "room" });
    await f.dispatch.dispatchPullRecipes();
    const opened = (await f.authority.listWorkItems(ORG)).filter(
      (item) => item.recipe_id === f.recipe.id,
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0].thread_id.endsWith(":room"), true);
    assert.equal(opened[0].status, "running");
    assert.equal(f.starts(), 1);
    const scheduled = await f.authority.getRecipe(ORG, f.recipe.id);
    assert.ok(scheduled.next_run_at > f.now);
    await f.authority.putRecipe({
      ...scheduled,
      next_run_at: new Date(Date.parse(f.now) - 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
    await f.dispatch.dispatchPullRecipes();
    const again = (await f.authority.listWorkItems(ORG)).filter(
      (item) => item.recipe_id === f.recipe.id,
    );
    assert.equal(again.length, 1);
    assert.equal(f.starts(), 1);
  });

  it("queues a syncing conversation without holding the rest of the schedule", async (t) => {
    const f = await fixture(t, {
      match: { record_class: "task", source: "test-chat" },
      trigger: { kind: "pull", interval_ms: 60_000 },
      can_write_back: false,
      include_context: false,
    });
    const { clearOrgSyncPhaseIndex } = require("../dist/personal-sync-phase");
    clearOrgSyncPhaseIndex();
    t.after(() => clearOrgSyncPhaseIndex());
    const listInstallations = f.authority.listInstallations.bind(f.authority);
    const getSyncCatalog = f.authority.getSyncCatalog.bind(f.authority);
    const listSyncPhaseHeads = f.authority.listSyncPhaseHeads.bind(f.authority);
    f.authority.listInstallations = async () => [{ id: "inst", status: "enabled" }];
    f.authority.getSyncCatalog = async () => ({
      members: [{
        installation_id: "inst",
        stream_key: "lagging",
        thread_id: "test-chat:lagging",
        generation: 1,
        discovered_at: f.now,
        last_seen_at: f.now,
      }],
    });
    f.authority.listSyncPhaseHeads = async () => [{
      stream_key: "lagging",
      phase: "history",
    }];
    await f.ingest("review one", { scopeId: "lagging" });
    await f.ingest("review two", { scopeId: "room" });
    await f.dispatch.dispatchPullRecipes();
    const opened = (await f.authority.listWorkItems(ORG)).filter(
      (item) => item.recipe_id === f.recipe.id,
    );
    const lagging = opened.find((item) => item.thread_id.endsWith(":lagging"));
    const room = opened.find((item) => item.thread_id.endsWith(":room"));
    assert.equal(opened.length, 2);
    assert.equal(lagging.status, "open");
    assert.equal(room.status, "running");
    assert.equal(f.starts(), 1);
    assert.ok((await f.authority.getRecipe(ORG, f.recipe.id)).next_run_at > f.now);
    f.authority.listInstallations = listInstallations;
    f.authority.getSyncCatalog = getSyncCatalog;
    f.authority.listSyncPhaseHeads = listSyncPhaseHeads;
    clearOrgSyncPhaseIndex();
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 2);
    assert.equal((await f.authority.getWorkItem(ORG, lagging.id)).status, "running");
  });

  it("advances a scheduled rule when nothing matches", async (t) => {
    const f = await fixture(t, {
      match: { record_class: "task", source: "missing-app" },
      trigger: { kind: "pull", interval_ms: 60_000 },
      can_write_back: false,
    });
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 0);
    assert.ok((await f.authority.getRecipe(ORG, f.recipe.id)).next_run_at > f.now);
  });

  it("runs a scheduled rule with stored conditions even without any message", async (t) => {
    const f = await fixture(t, {
      match: { thread_id: "test-chat:room", text_excludes: "draft" },
      trigger: { kind: "pull", interval_ms: 60_000 },
    });
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 1);
  });

  for (const kind of ["pull", "manual"]) {
    it(`preserves inactive conditions on API edits and allows ${kind} trials with a rejected message`, async (t) => {
      const f = await fixture(t, {
        executor_config: { prompt: "Handle this as a trial." },
        trigger: { kind, ...(kind === "pull" ? { interval_ms: 60_000 } : {}) },
      });
      const edited = normalizeRecipe({ name: "Renamed" }, ORG, f.now, f.recipe);
      assert.deepEqual(edited.match, f.recipe.match);
      await f.authority.putRecipe(edited);
      const eventId = await f.ingest("approve draft");
      const result = await f.service.tryRecipe(f.recipe.id, {});
      assert.equal(result.work_item.head_event_id, eventId);
      assert.equal(result.work_item.status, "running");
      assert.equal(f.starts(), 1);
      assert.equal(f.taskInstruction(), "Handle this as a trial.");
    });
  }

  it("binds a manual rule despite its inactive filters, but does not auto-start it", async (t) => {
    const f = await fixture(t, { trigger: { kind: "manual" } });
    const eventId = await f.ingest("approve draft");
    await f.dispatch.fillOpenSlots();
    const [item] = await f.authority.listWorkItems(ORG);
    assert.equal(item.recipe_id, f.recipe.id);
    assert.equal(item.head_event_id, eventId);
    assert.equal(f.starts(), 0);
    await f.dispatch.startItem(item, f.recipe, undefined, "manual");
    assert.equal(f.starts(), 1);
  });

  it("rechecks current push filters before retrying a failed run", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("approve release");
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
    const event = await f.authority.getEvent(ORG, eventId);
    const item = await f.authority.getWorkItemByUnitKey(ORG, event.thread_id, event.id);
    const run = await f.authority.getActiveWorkRun(ORG, item.id);
    const failed = await f.authority.commitWorkObservation({
      expected_item: item,
      expected_run: run,
      handle: {
        external_run_id: run.external_run_id,
        status: "failed",
        result: { summary: "Failed run" },
      },
      can_write_back: false,
      trigger_kind: "push",
      now: new Date().toISOString(),
    });
    assert.equal(failed.outcome, "applied");
    await f.authority.putRecipe({
      ...f.recipe,
      match: { ...f.recipe.match, text_excludes: "release" },
      updated_at: new Date(Date.parse(f.now) + 10_000).toISOString(),
    });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
  });

  it("starts an app rule only when the conversation title matches", async (t) => {
    const f = await fixture(t, {
      match: {
        record_class: "task",
        source: "test-chat",
        title_contains: "Design",
        title_excludes: "draft",
      },
    });
    await f.ingest("hello", { scopeName: "Other room" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    const renamedIn = await f.ingest("hello", { scopeName: "Weekly Design sync" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);
    const anchored = (await f.authority.listWorkItems(ORG)).find((item) => item.head_event_id === renamedIn);
    assert.equal(anchored?.recipe_id, "filtered");

    await f.ingest("hello", { scopeId: "moving", scopeName: "Weekly Design sync" });
    await f.ingest("hello", { scopeId: "moving", scopeName: "Other room" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 1);

    await f.ingest("hello", { scopeId: "design", scopeName: "Weekly Design sync" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 2);

    await f.ingest("hello", { scopeId: "drafts", scopeName: "Design draft notes" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 2);

    await f.authority.putConversationPref({
      org_id: ORG,
      thread_id: "test-chat:renamed",
      title: "Design review",
      updated_at: f.now,
    });
    await f.ingest("hello", { scopeId: "renamed", scopeName: "Other room" });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 3);
  });

  it("refuses a start without its triggering event", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("approve release");
    const event = await f.authority.getEvent(ORG, eventId);
    const item = await f.authority.getWorkItemByUnitKey(ORG, event.thread_id, event.id);
    await f.dispatch.startItem({ ...item, head_event_id: undefined }, f.recipe);
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 0);
  });
});
