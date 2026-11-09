const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");
const { PersonalWorkService } = require("../dist/personal-work.service");

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
