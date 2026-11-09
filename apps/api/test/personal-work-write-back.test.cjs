const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalWorkFlush } = require("../dist/personal-work-flush");
const { enqueueWriteBack } = require("@regenic/domain");
const { workInboxFaces } = require("../dist/personal-work-faces");

function recipeServiceFixture() {
  const recipes = new Map();
  const items = [];
  const capabilities = new Map([["writable", true], ["readonly", false]]);
  const authority = {
    getRecipe: async (_org, id) => recipes.get(id),
    putRecipe: async (recipe) => { recipes.set(recipe.id, recipe); return recipe; },
    listInstallations: async () => [],
    getWorkItemByThread: async () => null,
    listInbox: async () => [],
    putWorkItem: async (item) => { items.push(item); return item; },
    getWorkDeliveryByItem: async () => null,
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
  service.runWorkItem = async () => ({ status: "running" });
  const input = {
    name: "Result delivery",
    match: { thread_id: "readonly:source" },
    executor_type: "test",
    executor_config: { prompt: "Handle the task." },
    trigger: { kind: "manual" },
    can_write_back: true,
    write_back_thread_id: "writable:results",
  };
  return { service, recipes, items, capabilities, input, authority };
}

describe("recipe destination validation", () => {
  it("saves a read-only source to a writable destination, independent of the executor", async () => {
    const { service, input } = recipeServiceFixture();
    const saved = await service.putRecipe(input);
    assert.equal(saved.can_write_back, true);
    assert.equal(saved.write_back_thread_id, "writable:results");
    const trial = await service.tryRecipe(saved.id, { write_back: true });
    assert.equal(trial.thread_id, "readonly:source");
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
    const { service, input, capabilities, items } = recipeServiceFixture();
    const saved = await service.putRecipe(input);
    capabilities.delete("writable");
    await assert.rejects(service.tryRecipe(saved.id, { write_back: true }),
      /Write-back destination is unavailable/);
    assert.equal(items.length, 0);
    await service.tryRecipe(saved.id, { write_back: false });
    assert.equal(items.length, 1);
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
    await service.tryRecipe(saved.id, { thread_id: "writable:source", write_back: true });
    assert.equal(items.length, 1);
  });
});

describe("personal work write-back", () => {
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
      putWorkDelivery: async (row) => { rows.set(row.id, row); return row; },
    };
    const runtime = { orgId: () => item.org_id, requireHost: () => ({ get: () => authority }) };
    const channel = { writeBack: async (_item, _summary, _content, _delivery, onReceipt) => {
      rows.set(current.id, current);
      await onReceipt({ accepted: true, rpc_id: "old-message" }, now);
      return "sent";
    } };
    await new PersonalWorkFlush(runtime, channel).flushDeliveries();
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
