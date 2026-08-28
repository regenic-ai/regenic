const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  dequeueCursorPendingSend,
  enqueueCursorPendingSend,
  listCursorPendingSends,
  setCursorPendingSendsForTests,
  setCursorPendingSendsPathForTests,
} = require("../dist/cursor-pending-sends");

describe("cursor pending sends", () => {
  afterEach(() => {
    setCursorPendingSendsForTests();
    setCursorPendingSendsPathForTests();
  });

  it("appends follow-ups and shifts one at a time", () => {
    setCursorPendingSendsForTests({});
    enqueueCursorPendingSend({
      id: "rpc-1",
      agentId: "agent-1",
      text: "first",
      cwd: "/tmp/ws",
      model: "composer-2.5",
    });
    enqueueCursorPendingSend({
      id: "rpc-2",
      agentId: "agent-1",
      text: "second",
    });
    assert.deepEqual(
      listCursorPendingSends("agent-1").map((item) => item.id),
      ["rpc-1", "rpc-2"],
    );
    assert.equal(dequeueCursorPendingSend("agent-1")?.text, "first");
    assert.deepEqual(listCursorPendingSends("agent-1"), [
      { id: "rpc-2", agentId: "agent-1", text: "second" },
    ]);
    assert.equal(dequeueCursorPendingSend("agent-1")?.id, "rpc-2");
    assert.deepEqual(listCursorPendingSends("agent-1"), []);
  });

  it("reloads the queue file after a restart and never stores an api key", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cursor-pending-")), "queue.json");
    setCursorPendingSendsPathForTests(file);
    enqueueCursorPendingSend({
      id: "rpc-1",
      agentId: "agent-1",
      text: "later",
      cwd: "/tmp/ws",
    });
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("apiKey"), false);
    assert.equal(raw.includes("sk-"), false);
    setCursorPendingSendsForTests();
    assert.deepEqual(listCursorPendingSends("agent-1"), [
      { id: "rpc-1", agentId: "agent-1", text: "later", cwd: "/tmp/ws" },
    ]);
  });
});
