const assert = require("node:assert/strict");
const { join } = require("node:path");
const { it } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");
const {
  createRoot,
  restoreEnv,
  startDshWebStub,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

function flowBody(body) {
  const params = body.executor_config ?? {};
  const task = typeof params.prompt === "string" ? params.prompt : undefined;
  return {
    name: body.name,
    config: {
      source: { installations: "all" },
      scope: { kind: "new_messages", match: body.match },
      handler: {
        kind: "agent",
        executor_type: body.executor_type,
        ...(task !== undefined ? { task } : {}),
        ...(Object.keys(params).length ? { params } : {}),
      },
      destination: {
        kind: "reply",
        thread: body.write_back_thread_id || "origin",
        confirm: false,
        send: body.can_write_back === true,
      },
      trigger: body.trigger,
      hide_on_success: false,
      include_context: false,
      enabled: body.enabled !== false,
    },
  };
}

function withDestination(config, thread) {
  return {
    config: {
      ...config,
      destination: { kind: "reply", thread, confirm: false, send: true },
    },
  };
}

function replyThread(flow) {
  const thread = flow.config?.destination?.thread;
  return !thread || thread === "origin" ? undefined : thread;
}

it("persists HTTP recipe destinations through list, unrelated edits and API restart, and uses them for delivery", async () => {
  const root = await createRoot();
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const stub = await startDshWebStub();
  let running;
  let id;

  async function post(path, body) {
    const response = await fetch(`${running.origin}/v1/me/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const saved = await response.json();
    assert.equal(response.status, 201, JSON.stringify(saved));
    return saved;
  }

  async function checkPersisted(expected) {
    const response = await fetch(`${running.origin}/v1/me/flows`);
    assert.equal(response.status, 200);
    const listed = (await response.json()).find((recipe) => recipe.id === id);
    assert.ok(listed);
    assert.equal(replyThread(listed), expected);

    const sql = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(sql.prepare("SELECT write_back_thread_id FROM recipes WHERE id = ?")
        .get(id).write_back_thread_id, expected ?? null);
    } finally {
      sql.close();
    }

    // Delivery resolves the recipe again from SQL, not from POST's echoed object.
    const store = new SqliteAuthorityStore(database);
    try {
      assert.equal((await store.getRecipe("local-owner", id)).write_back_thread_id, expected);
      const channel = new PersonalWorkChannel({
        orgId: () => "local-owner",
        requireHost: () => ({ get: () => store }),
      }, {
        findForThread: () => ({
          driver: {
            capabilities: () => ({ reply: true }),
            bindEgress: () => {},
            outboundId: () => "stub-only",
          },
          installation: {},
        }),
      });
      const sent = [];
      channel.sendText = async (thread, text) => { sent.push({ thread, text }); };
      assert.equal(await channel.writeBack({
        id: "stub-work", org_id: "local-owner", recipe_id: id, thread_id: "dsh:source",
      }, "Done", undefined), "sent");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].thread.source, "dsh");
      assert.equal(sent[0].thread.target, (expected ?? "dsh:source").slice(4));
      assert.equal(sent[0].text, "Done");
    } finally {
      store.close();
    }
    assert.equal(stub.prompts.length, 0, "No real executor or outbound message should run");
  }

  async function restartAndCheck(expected) {
    await running.app.close();
    running = undefined;
    restoreEnv();
    running = await startPersonalApi(database, blobRoot);
    await checkPersisted(expected);
  }

  try {
    running = await startPersonalApi(database, blobRoot);
    await post("connectors", {
      connector_type: "dsh-session", config: { transport: "web", base_url: stub.origin },
    });
    const created = await post("flows", flowBody({
      name: "Persist destination",
      match: { thread_id: "dsh:source" },
      trigger: { kind: "manual" },
      executor_type: "dsh", executor_config: { prompt: "Summarize updates." },
      can_write_back: true, write_back_thread_id: "dsh:results", enabled: false,
    }));
    id = created.id;
    let config = created.config;
    assert.equal(replyThread(created), "dsh:results");
    await checkPersisted("dsh:results");
    await restartAndCheck("dsh:results");

    for (const [patch, expected] of [
      [withDestination(config, "dsh:other"), "dsh:other"],
      [{ name: "Unrelated edit" }, "dsh:other"],
      [withDestination(config, "origin"), undefined],
      [{ name: "Still original" }, undefined],
    ]) {
      const saved = await post(`flows/${id}`, patch);
      if (patch.config) config = saved.config;
      assert.equal(replyThread(saved), expected);
      await checkPersisted(expected);
      await restartAndCheck(expected);
    }
  } finally {
    if (running) await running.app.close();
    await stub.close();
  }
});
