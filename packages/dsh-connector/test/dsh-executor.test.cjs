const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { dshTaskExecutor } = require("../dist");

describe("dshTaskExecutor", () => {
  it("starts a session through the executor context, not a private HTTP client", async () => {
    const created = [];
    const sent = [];
    const handle = await dshTaskExecutor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: { id: "r1", executor_type: "dsh", executor_config: {} },
        evidence_text: "please handle the ticket",
      },
      {
        org_id: "local-owner",
        env: {},
        createThread: async () => {
          created.push("dsh:session-1");
          return { source: "dsh", target: "session-1" };
        },
        sendText: async (thread, text) => {
          sent.push(`${thread.source}:${thread.target}:${text}`);
        },
        listPrompts: async () => [],
        latestVisible: async () => null,
      },
    );
    assert.equal(handle.status, "running");
    assert.equal(handle.agent_thread_id, "dsh:session-1");
    assert.equal(created.length, 1);
    assert.match(sent[0], /please handle the ticket/);
    assert.equal(dshTaskExecutor.catalog().executor_type, "dsh");
    assert.equal(dshTaskExecutor.capabilities().prompts, true);
  });

  it("maps a live prompt to waiting_human and an assistant face to completed", async () => {
    const waiting = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      {
        org_id: "local-owner",
        env: {},
        createThread: async () => ({ source: "dsh", target: "session-1" }),
        sendText: async () => undefined,
        listPrompts: async () => [
          { prompt_id: "p1", presentation: "choice", questions: [] },
        ],
        latestVisible: async () => null,
      },
    );
    assert.equal(waiting.status, "waiting_human");
    assert.equal(waiting.prompts[0].prompt_id, "p1");

    const done = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      {
        org_id: "local-owner",
        env: {},
        createThread: async () => ({ source: "dsh", target: "session-1" }),
        sendText: async () => undefined,
        listPrompts: async () => [],
        latestVisible: async () => ({ kind: "assistant", text: "done" }),
      },
    );
    assert.equal(done.status, "completed");
    assert.equal(done.result.summary, "done");
  });
});
