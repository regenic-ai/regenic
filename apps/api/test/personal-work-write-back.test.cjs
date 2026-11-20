const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalWorkFlush } = require("../dist/personal-work-flush");
const { enqueueWriteBack, planWorkDeliveryCommand, MemoryWorkStore, WORK_DELIVERY_SEND_TIMEOUT_MS } = require("@regenic/domain");
const { workInboxFaces } = require("../dist/personal-work-faces");
const { WorkDeliveryNotSentError } = require("../dist/personal-errors");

function recipeServiceFixture() {
  const recipes = new Map();
  const items = [];
  const starts = [];
  const capabilities = new Map([["writable", true], ["readonly", false]]);
  const authority = {
    getRecipe: async (_org, id) => recipes.get(id),
    putRecipe: async (recipe) => { recipes.set(recipe.id, recipe); return recipe; },
    putRecipeIfUnchanged: async ({ recipe, expected_recipe }) => {
      const current = recipes.get(recipe.id) ?? null;
      if (expected_recipe === null ? current !== null : current !== expected_recipe) {
        return { outcome: "conflict" };
      }
      recipes.set(recipe.id, recipe);
      return { outcome: "applied", recipe };
    },
    listInstallations: async () => [],
    getWorkItemByThread: async () => null,
    getConversationPref: async () => null,
    listInbox: async () => [],
    createWorkItem: async ({ item }) => {
      items.push(item);
      return { outcome: "applied", item };
    },
    getWorkDeliveryByItem: async () => null,
    getWorkItem: async (_org, id) => starts.findLast((start) => start.item.id === id)?.item
      ?? items.find((item) => item.id === id),
  };
  const ports = {
    authority,
    executors: { get: () => ({ catalog: () => ({ fields: [] }) }) },
  };
  const runtime = {
    orgId: () => "local-owner",
    requireHost: () => ({ get: (name) => ports[name] }),
  };
  const drivers = {
    findForThread: (_installations, thread) => capabilities.has(thread.source) ? ({
      installation: {},
      driver: {
        capabilities: () => ({ reply: capabilities.get(thread.source) }),
        bindEgress: () => {},
        outboundId: () => "outbound",
      },
    }) : undefined,
  };
  const service = new PersonalWorkService(
    runtime, drivers, { ensureMounted: async () => {} }, { touchInboxDigest() {} }, {}, {},
  );
  service.afterConnectorTick = async () => {};
  service.dispatch = {
    startItem: async (item, rule, _text, mode, options) => {
      starts.push({ item: { ...item, recipe_id: rule.id, status: "running" }, mode, options });
      return { id: "trial-run", status: "running" };
    },
  };
  const input = {
    name: "Result delivery",
    match: { thread_id: "readonly:source" },
    executor_type: "test",
    executor_config: { prompt: "Handle the task." },
    trigger: { kind: "manual" },
    can_write_back: true,
    write_back_thread_id: "writable:results",
  };
  return { service, recipes, items, starts, capabilities, input, authority };
}

describe("recipe destination validation", () => {
  it("saves a read-only source to a writable destination, independent of the executor", async () => {
    const { service, input, starts } = recipeServiceFixture();
    const saved = await service.putRecipe(input);
    assert.equal(saved.can_write_back, true);
    assert.equal(saved.write_back_thread_id, "writable:results");
    const trial = await service.tryRecipe(saved.id, { write_back: true });
    assert.equal(trial.thread_id, "readonly:source");
    assert.deepEqual(starts[0].options, { write_back: true, rebind: true });
  });

  it("rejects new unsupported or unknown send destinations rather than silently keeping results local", async () => {
    const { service, input, recipes } = recipeServiceFixture();
    for (const destination of ["readonly:results", "unknown:results", null]) {
      await assert.rejects(service.putRecipe({ ...input, write_back_thread_id: destination }),
        /Write-back destination is unavailable/);
    }
    assert.equal(recipes.size, 0);
    const local = await service.putRecipe({
      ...input, can_write_back: false, write_back_thread_id: "readonly:results",
    });
    assert.equal(local.can_write_back, false);
    assert.equal(local.write_back_thread_id, "readonly:results");
  });

  it("preserves a legacy unavailable destination on unrelated saves but rejects re-enabling or changing it", async () => {
    const { service, input, recipes, capabilities } = recipeServiceFixture();
    const saved = await service.putRecipe(input);
    capabilities.set("writable", false);
    const renamed = await service.putRecipe({ ...input, name: "Renamed" }, saved.id);
    assert.equal(renamed.can_write_back, true);
    assert.equal(renamed.write_back_thread_id, saved.write_back_thread_id);
    await assert.rejects(service.putRecipe({ ...renamed, id: undefined }),
      /Write-back destination is unavailable/, "Importing a copy must validate it as a new rule");
    await assert.rejects(service.putRecipe({ write_back_thread_id: "unknown:other" }, saved.id),
      /Write-back destination is unavailable/);
    assert.equal(recipes.get(saved.id).write_back_thread_id, saved.write_back_thread_id);
    await service.putRecipe({ can_write_back: false }, saved.id);
    await assert.rejects(service.putRecipe({ can_write_back: true }, saved.id),
      /Write-back destination is unavailable/);
  });

  it("checks the effective original destination when the source changes", async () => {
    const { service, input } = recipeServiceFixture();
    const saved = await service.putRecipe({
      ...input, match: { thread_id: "writable:source" }, write_back_thread_id: null,
    });
    await assert.rejects(service.putRecipe({ match: { thread_id: "readonly:source" } }, saved.id),
      /Write-back destination is unavailable/);
  });

  it("rejects unavailable/disabled send trials before creating work, but permits keep-here trials", async () => {
    const { service, input, capabilities, items, starts } = recipeServiceFixture();
    const saved = await service.putRecipe(input);
    capabilities.delete("writable");
    await assert.rejects(service.tryRecipe(saved.id, { write_back: true }),
      /Write-back destination is unavailable/);
    assert.equal(items.length, 0);
    await service.tryRecipe(saved.id, { write_back: false });
    assert.equal(items.length, 1);
    assert.deepEqual(starts[0].options, { write_back: false, rebind: true });
    await service.putRecipe({ can_write_back: false }, saved.id);
    await assert.rejects(service.tryRecipe(saved.id, { write_back: true }), /Send back is not enabled/);
    assert.equal(items.length, 1);
  });

  it("validates the selected trial sample for rules returning to the original conversation", async () => {
    const { service, input, items, authority } = recipeServiceFixture();
    authority.getWorkItemByThread = async () => ({ id: "sample", record_class: "task", status: "done" });
    authority.getActiveWorkRun = async () => null;
    const saved = await service.putRecipe({
      ...input, match: { record_class: "task" }, write_back_thread_id: null,
    });
    await assert.rejects(service.tryRecipe(saved.id, { thread_id: "readonly:source", write_back: true }),
      /Write-back destination is unavailable/);
    assert.equal(items.length, 0);
    const result = await service.tryRecipe(saved.id, { thread_id: "writable:source", write_back: true });
    assert.equal(result.work_item.id, "sample");
    assert.equal(items.length, 0, "Reusing a sample must not create another work item");
  });
});

describe("personal work write-back", () => {
  async function flushFixture(channel, onWorkUpdated = () => {}) {
    const authority = new MemoryWorkStore();
    const now = new Date().toISOString();
    const recipe = {
      id: "rule", org_id: "owner", name: "Write-back",
      match: { record_class: "task" }, trigger: { kind: "push" },
      executor_type: "test", executor_config: {}, include_context: false,
      can_write_back: true, enabled: true, created_at: now, updated_at: now,
    };
    await authority.putRecipe(recipe);
    const triggerEventId = "write-back-trigger";
    authority.recordCurrentWorkEvidence(triggerEventId);
    const created = await authority.createWorkItem({
      item: {
        id: "work", org_id: "owner", recipe_id: recipe.id, status: "open",
        thread_id: "source:room", unit_key: "unit", head_event_id: triggerEventId,
        record_class: "task", thread_facet: "ticket", created_at: now, updated_at: now,
      },
      recipe,
      expected_recipe: recipe,
    });
    assert.equal(created.outcome, "applied");
    const startRun = {
      id: "run", org_id: "owner", work_item_id: created.item.id, recipe_id: recipe.id,
      executor_type: recipe.executor_type, status: "running", start_state: "pending",
      write_back_required: true, write_back_target: {
        installation_id: "sender", source: "source", target: "room",
      },
      trigger_kind: "push", created_at: now, updated_at: now,
    };
    assert.equal(await authority.claimWorkRunStart({
      expected_item: created.item, expected_recipe: recipe, run: startRun,
    }), true);
    const reservedItem = await authority.getWorkItem("owner", created.item.id);
    const reservedRun = await authority.getWorkRun("owner", startRun.id);
    const submitted = await authority.checkpointWorkRunStart({
      expected_item: reservedItem, expected_run: reservedRun,
      kind: "submitted", external_run_id: "external-run", now,
    });
    assert.equal(submitted.outcome, "applied");
    const completed = await authority.commitWorkObservation({
      expected_item: submitted.item,
      expected_run: submitted.run,
      handle: {
        status: "completed", external_run_id: "external-run",
        result: { summary: "Done" },
      },
      can_write_back: true,
      trigger_kind: "push",
      now,
    });
    assert.equal(completed.outcome, "applied");
    const item = completed.transition.item;
    const delivery = await authority.getWorkDeliveryByItem("owner", item.id);
    const runtime = { orgId: () => item.org_id, requireHost: () => ({ get: () => authority }) };
    return { authority, item, delivery, flush: new PersonalWorkFlush(runtime, channel, onWorkUpdated) };
  }

  it("publishes a work update after delivery settlement commits", async () => {
    const updates = [];
    const f = await flushFixture(
      { writeBack: async () => "sent" },
      (workItemId) => updates.push(workItemId),
    );

    await f.flush.flushOne(f.item, undefined, f.delivery);

    assert.equal((await f.authority.getWorkDelivery("owner", f.delivery.id)).status, "acked");
    assert.deepEqual(updates, [f.item.id]);
  });

  it("allows only one flusher to enter external sending, including overlapping calls by the same worker", async () => {
    let release;
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const sending = new Promise((resolve) => { release = resolve; });
    let sends = 0;
    const f = await flushFixture({ writeBack: async () => {
      sends++;
      started();
      await sending;
      return "sent";
    } });
    const first = f.flush.flushOne(f.item, undefined, f.delivery);
    await entered;
    const runtime = { requireHost: () => ({ get: () => f.authority }) };
    await Promise.all([
      f.flush.flushOne(f.item, undefined, f.delivery),
      new PersonalWorkFlush(runtime, { writeBack: async () => { sends++; return "sent"; } }, () => {})
        .flushOne(f.item, undefined, f.delivery),
    ]);
    assert.equal(sends, 1);
    release();
    await first;
    assert.equal((await f.authority.getWorkDelivery("owner", f.delivery.id)).status, "acked");
  });

  it("pauses unknown acceptance on timeout and uses a late receipt only for local recovery", async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let finish;
    const waiting = new Promise((resolve) => { finish = resolve; });
    let callbacks;
    const f = await flushFixture({ writeBack: async (_item, _summary, _content, _delivery, onReceipt) => {
      callbacks = onReceipt;
      entered();
      await waiting;
      return "sent";
    } });
    const send = f.flush.flushOne(f.item, undefined, f.delivery);
    await started;
    t.mock.timers.tick(WORK_DELIVERY_SEND_TIMEOUT_MS + 1);
    await send;
    assert.equal((await f.authority.getWorkDelivery("owner", f.delivery.id)).status, "uncertain");
    assert.deepEqual(await f.authority.listDueWorkDeliveries("owner", new Date().toISOString()), []);
    await assert.rejects(f.flush.flushOne(f.item, undefined, f.delivery, true), /requires reconciliation/);
    await callbacks({ accepted: true, rpc_id: "late" });
    finish();
    let recoveries = 0;
    const runtime = { orgId: () => "owner", requireHost: () => ({ get: () => f.authority }) };
    await new PersonalWorkFlush(runtime, { writeBack: async (_item, _summary, _content, row) => {
      recoveries++;
      assert.equal(row.channel_receipt.rpc_id, "late");
      return "sent";
    } }, () => {}).flushDeliveries();
    assert.equal(recoveries, 1);
    assert.equal((await f.authority.getWorkDelivery("owner", f.delivery.id)).write_back, "sent");
  });

  it("does not automatically retry a connection error with unknown channel acceptance", async (t) => {
    t.mock.method(console, "error", () => {});
    let sends = 0;
    const f = await flushFixture({ writeBack: async () => { sends++; throw new Error("connection reset"); } });
    await f.flush.flushDeliveries();
    await f.flush.flushDeliveries();
    assert.equal(sends, 1);
    const row = await f.authority.getWorkDelivery("owner", f.delivery.id);
    assert.equal(row.status, "uncertain");
    assert.equal(row.write_back, "pending");
    assert.match(row.last_error, /connection reset/);
  });

  it("retries proven pre-send failures without treating them as unknown acceptance", async (t) => {
    t.mock.method(console, "error", () => {});
    const f = await flushFixture({ writeBack: async () => {
      throw new WorkDeliveryNotSentError("no_sender", "Installation disabled", 409);
    } });
    await f.flush.flushDeliveries();
    const row = await f.authority.getWorkDelivery("owner", f.delivery.id);
    assert.equal(row.status, "write_back");
    assert.equal(row.write_back, "failed");
    assert.ok(row.next_retry_at);
    assert.equal((await f.authority.transitionWorkDelivery({
      org_id: "owner", delivery_id: row.id, kind: "claim", owner: "worker",
      now: new Date().toISOString(),
    })).outcome, "conflict");
  });

  it("does not send externally again when an accepted receipt only needs local ingestion", async () => {
    let sends = 0;
    let localAttempts = 0;
    let storedReceipt;
    const installation = { id: "original" };
    const driver = {
      source: "source", capabilities: () => ({ reply: true }),
      bindEgress: async () => ({ send: async () => { sends++; return { accepted: true, rpc_id: "request" }; } }),
      outboundId: () => "outbound",
    };
    const ports = {
      authority: { listInstallations: async () => [installation] },
      ingest: { ingest: async () => {
        localAttempts++;
        if (localAttempts === 1) throw new Error("local persistence failed");
      } },
    };
    const runtime = { orgId: () => "owner", requireHost: () => ({ get: (name) => ports[name] }) };
    const channel = new PersonalWorkChannel(runtime, { findForThread: () => ({ installation, driver }) });
    channel.destinationStamp = async () => ({});
    const options = {
      installationId: "original", idempotency_key: "immutable-key",
      onReceipt: async (receipt) => { storedReceipt = receipt; },
    };
    await assert.rejects(channel.sendText({ source: "source", target: "room" }, "Done", options),
      /local persistence failed/);
    assert.equal(storedReceipt.accepted, true);
    await channel.sendText({ source: "source", target: "room" }, "Done", { ...options, receipt: storedReceipt });
    assert.equal(sends, 1);
    assert.equal(localAttempts, 2);
  });

  it("uses the frozen installation and destination even if its recipe is edited or removed", async () => {
    for (const recipe of [null, { can_write_back: false, write_back_thread_id: "source:new-room" }]) {
      const target = { installation_id: "original", source: "source", target: "original-room" };
      let installations = [{ id: "replacement" }, { id: "original" }];
      const authority = {
        getRecipe: async () => recipe,
        getWorkItem: async () => ({ status: "done" }),
        listInstallations: async () => installations,
      };
      const runtime = {
        orgId: () => "owner",
        requireHost: () => ({ get: () => authority }),
      };
      const drivers = { findForThread: (rows) => rows.length ? ({
        installation: rows[0], driver: {
          capabilities: () => ({ reply: true }), bindEgress() {}, outboundId: () => "outbound",
        },
      }) : undefined };
      const channel = new PersonalWorkChannel(runtime, drivers);
      let sent;
      channel.sendText = async (thread, _text, options) => { sent = { thread, options }; };
      const delivery = { id: "delivery", run_id: "run", target, idempotency_key: "request" };
      const item = { id: "work", org_id: "owner", recipe_id: "rule", thread_id: "source:trigger" };
      assert.equal(await channel.writeBack(item, "Done", undefined, delivery), "sent");
      assert.equal(sent.thread.target, "original-room");
      assert.equal(sent.options.installationId, "original");
      assert.equal(sent.options.idempotency_key, "request");
      installations = [{ id: "replacement" }];
      await assert.rejects(channel.writeBack(item, "Done", undefined, delivery),
        /Frozen write-back installation is unavailable/);
    }
  });

  it("settles a delayed receipt against its original delivery rather than the current item delivery", async () => {
    const now = new Date().toISOString();
    const item = { id: "work", org_id: "owner", recipe_id: "rule", status: "done" };
    const make = (run) => enqueueWriteBack({
      org_id: item.org_id, work_item_id: item.id, recipe_id: "rule", kind: "push",
      unit_key: "unit", payload: { summary: "Same result" }, run_id: run, now,
      target: { installation_id: "sender", source: "source", target: "room" },
    });
    const original = make("old-run");
    const current = make("new-run");
    const rows = new Map([[original.id, original]]);
    const authority = {
      listDueWorkDeliveries: async () => [original],
      listRecipes: async () => [],
      getWorkItem: async () => item,
      getWorkDelivery: async (_org, id) => rows.get(id),
      getWorkDeliveryByItem: async () => { throw new Error("Must not settle by item"); },
      transitionWorkDelivery: async (input) => {
        const result = planWorkDeliveryCommand(rows.get(input.delivery_id) ?? null, item.status, input);
        if (result.outcome === "applied") rows.set(input.delivery_id, result.delivery);
        return result;
      },
    };
    const runtime = { orgId: () => item.org_id, requireHost: () => ({ get: () => authority }) };
    const channel = { writeBack: async (_item, _summary, _content, _delivery, onReceipt) => {
      rows.set(current.id, current);
      await onReceipt({ accepted: true, rpc_id: "old-message" }, now);
      return "sent";
    } };
    await new PersonalWorkFlush(runtime, channel, () => {}).flushDeliveries();
    assert.equal(rows.get(original.id).status, "acked");
    assert.equal(rows.get(original.id).channel_receipt.rpc_id, "old-message");
    assert.deepEqual(rows.get(current.id), current);
  });

  it("shows the current run's delivery while retaining attention for unresolved history", () => {
    const item = {
      id: "work", org_id: "owner", thread_id: "source:room", current_run_id: "current",
      status: "done", recipe_id: "rule", created_at: "2026-11-09T08:00:00.000Z",
    };
    const input = {
      threadIds: [item.thread_id], items: [item],
      runs: [
        { id: "current", work_item_id: item.id, result: { summary: "Current result" }, write_back_required: true },
        { id: "old", work_item_id: item.id, result: { summary: "Old result" }, updated_at: "2099-01-01" },
      ],
      recipes: [{ id: "rule", can_write_back: false }],
      deliveries: [
        { id: "current-delivery", work_item_id: item.id, run_id: "current", status: "acked", write_back: "sent", attempts: 1 },
        { id: "old-delivery", work_item_id: item.id, run_id: "old", status: "dead", write_back: "failed", attempts: 3 },
      ],
    };
    const face = workInboxFaces(input).get(item.thread_id);
    assert.equal(face.work.run_id, "current");
    assert.equal(face.work.result_summary, "Current result");
    assert.equal(face.work.can_write_back, true);
    assert.equal(face.work.delivery.status, "acked");
    assert.equal(face.attention, "waiting_you");
    const unknown = workInboxFaces({
      ...input, items: [{ ...item, current_run_id: undefined }],
    }).get(item.thread_id);
    assert.equal(unknown.work.run_id, undefined);
  });

  it("uses the configured destination and otherwise keeps the triggering conversation", async () => {
    for (const [writeBackThreadId, expectedTarget] of [
      ["feishu:results", "results"],
      [undefined, "source"],
    ]) {
      let sentThread;
      const recipe = {
        can_write_back: true,
        ...(writeBackThreadId ? { write_back_thread_id: writeBackThreadId } : {}),
      };
      const authority = {
        getRecipe: async () => recipe,
        getWorkItem: async () => ({ status: "done" }),
        listInstallations: async () => [{ id: "feishu-installation" }],
      };
      const runtime = {
        orgId: () => "local-owner",
        requireHost: () => ({ get: () => authority }),
      };
      const drivers = {
        findForThread: (_installations, thread) => ({
          driver: {
            capabilities: () => ({ reply: true }),
            bindEgress: () => {},
            outboundId: () => "outbound",
          },
          installation: { id: "feishu-installation" },
        }),
      };
      const channel = new PersonalWorkChannel(runtime, drivers);
      channel.sendText = async (thread) => {
        sentThread = thread;
      };

      const outcome = await channel.writeBack(
        {
          id: "work-1",
          org_id: "local-owner",
          recipe_id: "recipe-1",
          thread_id: "feishu:source",
        },
        "Done",
        [{ role: "body", media_type: "text/plain", text: "Done" }],
      );

      assert.equal(outcome, "sent");
      assert.equal(sentThread.source, "feishu");
      assert.equal(sentThread.target, expectedTarget);
    }
  });
});
