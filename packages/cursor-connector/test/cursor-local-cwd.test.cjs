const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { describe, it, afterEach } = require("node:test");
const {
  lookupCursorAgentCwdFromIndexes,
  listCursorLocalAgents,
  resolveCursorAgentCwd,
  rememberCursorAgentCwd,
  setCursorAgentCwdMapForTests,
  setCursorSdkIndexPathsForTests,
} = require("../dist/cursor-local-cwd");

describe("cursor local cwd lookup", () => {
  afterEach(() => {
    setCursorAgentCwdMapForTests();
    setCursorSdkIndexPathsForTests();
  });

  it("reads workspace_ref from the SDK local index", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-index-"));
    const file = join(dir, "index.db");
    const database = new DatabaseSync(file);
    database.exec(
      "CREATE TABLE agents (agent_id TEXT, workspace_ref TEXT)",
    );
    database
      .prepare("INSERT INTO agents VALUES (?, ?)")
      .run(
        "agent-182aa8cb-b404-4e59-82f0-8998c8eac13e",
        "/Users/bioby/Projects/the-last-scarcity/.work/regenic-stub/apps/desktop",
      );
    database.close();
    setCursorSdkIndexPathsForTests([file]);
    setCursorAgentCwdMapForTests({});
    assert.equal(
      lookupCursorAgentCwdFromIndexes("agent-182aa8cb-b404-4e59-82f0-8998c8eac13e"),
      "/Users/bioby/Projects/the-last-scarcity/.work/regenic-stub/apps/desktop",
    );
    assert.equal(
      resolveCursorAgentCwd("agent-182aa8cb-b404-4e59-82f0-8998c8eac13e", process.cwd()),
      "/Users/bioby/Projects/the-last-scarcity/.work/regenic-stub/apps/desktop",
    );
  });

  it("prefers a remembered cwd over the current process", () => {
    setCursorAgentCwdMapForTests({
      "agent-1": "/tmp/remembered-workspace",
    });
    assert.equal(resolveCursorAgentCwd("agent-1", "/tmp/wrong"), "/tmp/remembered-workspace");
    rememberCursorAgentCwd("agent-2", "/tmp/created");
    assert.equal(resolveCursorAgentCwd("agent-2"), "/tmp/created");
  });

  it("lists local agents and can filter by workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-index-"));
    const file = join(dir, "index.db");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE agents (agent_id TEXT, workspace_ref TEXT)");
    database
      .prepare("INSERT INTO agents VALUES (?, ?), (?, ?)")
      .run(
        "agent-one",
        "/tmp/workspace-a",
        "agent-two",
        "/tmp/workspace-b",
      );
    database.close();
    setCursorSdkIndexPathsForTests([file]);
    setCursorAgentCwdMapForTests({});
    assert.deepEqual(
      listCursorLocalAgents().map((agent) => agent.agentId).sort(),
      ["agent-one", "agent-two"],
    );
    assert.deepEqual(listCursorLocalAgents({ cwd: "/tmp/workspace-a" }), [
      { agentId: "agent-one", cwd: "/tmp/workspace-a" },
    ]);
  });

  it("skips agents whose workspace is the OS temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-index-"));
    const file = join(dir, "index.db");
    const ephemeral = join(tmpdir(), "ephemeral-workspace");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE agents (agent_id TEXT, workspace_ref TEXT)");
    database
      .prepare("INSERT INTO agents VALUES (?, ?), (?, ?)")
      .run("agent-temp", ephemeral, "agent-keep", "/tmp/workspace-keep");
    database.close();
    setCursorSdkIndexPathsForTests([file]);
    setCursorAgentCwdMapForTests({});
    assert.deepEqual(listCursorLocalAgents(), [
      { agentId: "agent-keep", cwd: "/tmp/workspace-keep" },
    ]);
  });
});
