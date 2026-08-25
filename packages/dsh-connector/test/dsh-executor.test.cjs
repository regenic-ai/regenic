const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { dshTaskExecutor } = require("../dist");

function ctx(overrides = {}) {
  return {
    org_id: "local-owner",
    env: {},
    spawnSysout: async () => ({ source: "dsh", target: "session-1" }),
    writeStdin: async () => undefined,
    listPrompts: async () => [],
    readTranscript: async () => null,
    ...overrides,
  };
}

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
      ctx({
        spawnSysout: async () => {
          created.push("dsh:session-1");
          return { source: "dsh", target: "session-1" };
        },
        writeStdin: async (thread, text) => {
          sent.push(`${thread.source}:${thread.target}:${text}`);
        },
      }),
    );
    assert.equal(handle.status, "running");
    assert.equal(handle.agent_thread_id, "dsh:session-1");
    assert.equal(created.length, 1);
    assert.match(sent[0], /please handle the ticket/);
    assert.equal(dshTaskExecutor.catalog().executor_type, "dsh");
    assert.equal(dshTaskExecutor.catalog().attach, "absentee");
    assert.equal(dshTaskExecutor.capabilities().prompts, true);
  });

  it("maps a live prompt to waiting_human and DSH turn/end to exit", async () => {
    const waiting = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        listPrompts: async () => [
          { prompt_id: "p1", presentation: "choice", questions: [] },
        ],
      }),
    );
    assert.equal(waiting.status, "waiting_human");
    assert.equal(waiting.prompts[0].prompt_id, "p1");

    const spoken = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "The travel request is approved.",
        }),
      }),
    );
    assert.equal(spoken.status, "running");
    assert.equal(spoken.result, undefined);

    const ended = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "The travel request is approved.",
          turn: { state: "ended", ok: true, reason: "completed" },
        }),
      }),
    );
    assert.equal(ended.status, "completed");
    assert.equal(ended.result.summary, "The travel request is approved.");

    const failed = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "provider down",
          turn: { state: "ended", ok: false, reason: "error" },
        }),
      }),
    );
    assert.equal(failed.status, "failed");

    const working = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "Looking now.",
          turn: { state: "open" },
        }),
      }),
    );
    assert.equal(working.status, "running");
    assert.equal(working.result, undefined);

    const onlyOurAsk = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({ kind: "user", text: "please handle" }),
      }),
    );
    assert.equal(onlyOurAsk.status, "running");
  });
});
