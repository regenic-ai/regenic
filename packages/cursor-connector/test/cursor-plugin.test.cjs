const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { describe, it } = require("node:test");
const {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  verifyChannelDriverConformance,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { cursorAgentPlugin } = require("../dist/plugin");
const { cursorAgentDriver } = require("../dist/cursor-agent-driver");
const { setCursorSecretStoreForTests } = require("../dist/cursor-credentials");
const { setCursorLocalClientForTests } = require("../dist/cursor-local-client");
const {
  setCursorAgentCwdMapForTests,
  setCursorSdkIndexPathsForTests,
} = require("../dist/cursor-local-cwd");

function installation(config = {}) {
  return {
    id: "cursor-1",
    org_id: "local-owner",
    connector_type: "cursor-agent",
    status: "enabled",
    config,
    credentials_ref: "env:CURSOR_API_KEY",
    created_at: "2026-08-21T00:00:00.000Z",
  };
}

describe("cursorAgentPlugin", () => {
  it("registers on connectors and egress and unregisters when disposed", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));

    const mounted = await host.plugin(cursorAgentPlugin, {
      installation_id: "cursor-1",
      org_id: "local-owner",
      api_key: "key-1",
      agents: [{ id: "bc-1", name: "Add README" }],
    });

    assert.equal(connectors.get("cursor-1")?.source, "cursor");
    assert.equal(connectors.getStream("cursor-1")?.stream_key, "agent:bc-1");
    assert.equal(connectors.getStream("cursor-1")?.thread_id, "cursor:bc-1");
    assert.equal(connectors.getStream("cursor-1")?.label, "Add README");
    assert.equal(egress.get("cursor-1")?.source, "cursor");
    await mounted.dispose();
    assert.equal(connectors.get("cursor-1"), undefined);
    assert.equal(egress.get("cursor-1"), undefined);
    await host.dispose();
  });

  it("mounts a known local agent through the host registries", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const agentId = "agent-00000000-0000-4000-8000-000000000001";
    const streams = await cursorAgentDriver.resolveStreams(
      installation({ model: "grok-4.6" }),
      host,
      { CURSOR_API_KEY: "key-1" },
      { threads: [{ source: "cursor", target: agentId }] },
    );
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, `cursor:${agentId}`);
    const again = await cursorAgentDriver.resolveStreams(
      installation({ model: "grok-4.6" }),
      host,
      { CURSOR_API_KEY: "key-1" },
      { threads: [{ source: "cursor", target: agentId }] },
    );
    assert.equal(again.length, 1);
    assert.equal(connectors.listStreams("cursor-1").length, 1);
    await host.dispose();
  });
});

describe("cursorAgentDriver", () => {
  it("declares a session-agent surface and can open a conversation when unpinned", () => {
    const enabled = installation({ runtime: "local" });
    assert.deepEqual(cursorAgentDriver.capabilities(enabled), {
      sync: true,
      reply: true,
      create: true,
      await_reply: true,
      list_title: "prompt",
      create_with_task: true,
      hold_while_working: true,
    });
    assert.equal(
      cursorAgentDriver.capabilities(installation({ model: "grok-4.6" })).create,
      true,
    );
    verifyChannelDriverConformance({
      driver: cursorAgentDriver,
      enabled,
      disabled: { ...enabled, status: "disabled" },
    });
  });

  it("installs with an env credential ref and no token in config", () => {
    const secrets = new Map();
    setCursorSecretStoreForTests({
      read: async (_service, account) => secrets.get(account),
      write: (_service, account, secret) => {
        secrets.set(account, secret);
      },
    });
    const created = cursorAgentDriver.install({
      id: "cursor-1",
      org_id: "local-owner",
      config: { runtime: "local", api_key: "cursor_secret", token: "should-not-store" },
      now: "2026-08-21T00:00:00.000Z",
    });
    assert.equal(created.credentials_ref, "keychain:regenic-cursor:cursor-1");
    assert.deepEqual(created.config, { model: "composer-2.5" });
    assert.equal(JSON.stringify(created).includes("cursor_secret"), false);
    assert.equal(JSON.stringify(created).includes("should-not-store"), false);
    assert.equal(secrets.get("cursor-1"), "cursor_secret");
    setCursorSecretStoreForTests();
  });

  it("matches every Cursor thread", () => {
    const open = installation();
    assert.equal(
      cursorAgentDriver.matchesThread(open, { source: "cursor", target: "agent-9" }),
      true,
    );
    assert.equal(
      cursorAgentDriver.ownsThread(open, { source: "cursor", target: "agent-9" }),
      false,
    );
    assert.equal(
      cursorAgentDriver.matchesThread(open, { source: "dsh", target: "s1" }),
      false,
    );
  });

  it("advertises Cursor on the Engine catalog", () => {
    const catalog = cursorAgentDriver.installCatalog();
    assert.equal(catalog.channel_label, "Cursor");
    assert.equal(catalog.fields[0].key, "api_key");
    assert.equal(catalog.fields[0].secret, true);
    assert.equal(catalog.fields[1].key, "model");
    assert.equal(catalog.fields[1].default, "composer-2.5");
    assert.equal(catalog.fields[1].options[0].value, "composer-2.5");
    assert.ok(catalog.fields[1].options.some((item) => item.value === "grok-4.6"));
    assert.ok(catalog.fields[1].options.some((item) => item.value === "claude-4.6-sonnet-thinking"));
    assert.equal(catalog.prerequisites[0].required, false);
    assert.equal(catalog.fields.some((field) => field.key === "runtime"), false);
    assert.equal(catalog.fields.some((field) => field.key === "agent_id"), false);
  });

  it("creates a local agent from the first task", async () => {
    const calls = [];
    setCursorLocalClientForTests({
      async create(input) {
        calls.push(input);
        return { agentId: "agent-local-1" };
      },
      async send() {
        throw new Error("should not send twice");
      },
      async getAgent() {
        return { id: "agent-local-1", status: "ACTIVE" };
      },
      async getConversation() {
        return { id: "agent-local-1", messages: [] };
      },
    });
    const thread = await cursorAgentDriver.createThread(
      installation({ runtime: "local" }),
      {},
      { CURSOR_API_KEY: "key-1" },
      { text: "Fix the login bug", cwd: "/tmp/repo" },
    );
    assert.deepEqual(thread, { source: "cursor", target: "agent-local-1" });
    assert.equal(calls[0].text, "Fix the login bug");
    assert.equal(calls[0].cwd, "/tmp/repo");
    assert.equal(calls[0].model, "composer-2.5");
    const custom = await cursorAgentDriver.createThread(
      installation({ runtime: "local", model: "composer-2" }),
      {},
      { CURSOR_API_KEY: "key-1" },
      { text: "Use the pinned model" },
    );
    assert.equal(custom.target, "agent-local-1");
    assert.equal(calls[1].model, "composer-2");
    await assert.rejects(
      () => cursorAgentDriver.createThread(installation({ runtime: "local" }), {}, {}, {}),
    );
    setCursorLocalClientForTests();
  });

  it("discovers local agents from the SDK index when sync asks to look around", async () => {
    const agentId = "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92";
    const dir = mkdtempSync(join(tmpdir(), "cursor-index-"));
    const file = join(dir, "index.db");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE agents (agent_id TEXT, workspace_ref TEXT)");
    database.prepare("INSERT INTO agents VALUES (?, ?)").run(agentId, "/tmp/workspace-a");
    database.close();
    setCursorSdkIndexPathsForTests([file]);
    setCursorAgentCwdMapForTests({});

    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const none = await cursorAgentDriver.resolveStreams(
      installation(),
      host,
      { CURSOR_API_KEY: "key-1" },
    );
    assert.deepEqual(none, []);
    const streams = await cursorAgentDriver.resolveStreams(
      installation(),
      host,
      { CURSOR_API_KEY: "key-1" },
      {
        discover: true,
        threads: [{ source: "cursor", target: `${agentId}:0` }],
      },
    );
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, `cursor:${agentId}`);
    await host.dispose();
    setCursorSdkIndexPathsForTests();
    setCursorAgentCwdMapForTests();
  });
});
