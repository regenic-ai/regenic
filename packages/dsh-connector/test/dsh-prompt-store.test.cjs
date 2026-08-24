const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DshMuxSubscriber,
  DshPromptStore,
  DshWebRpcClient,
  answerDshPrompt,
  approvalPromptId,
  dropDshPromptStore,
  dshPromptStoreFor,
  dshRespondValue,
  muxFrameFromMessage,
  parseDshPromptId,
  questionPromptId,
} = require("../dist");

describe("DSH thread prompts", () => {
  it("maps question and approval mux frames into channel-agnostic prompts", () => {
    const store = new DshPromptStore();
    const question = muxFrameFromMessage({
      type: "server-request",
      rpcId: "rpc-q",
      method: "question/requested",
      payload: {
        sessionId: "sess-1",
        questions: [
          {
            id: "mode",
            question: "Which mode?",
            options: [{ label: "Fast" }, { label: "Safe" }],
            intent: { kind: "plan-review", approve: "Safe" },
          },
        ],
      },
    });
    store.applyEnvelope(question.rpcId, question.frame);
    const listed = store.list("sess-1");
    assert.equal(listed[0].prompt_id, questionPromptId("rpc-q"));
    assert.equal(listed[0].presentation, "plan_review");
    assert.equal(listed[0].questions[0].options[1].label, "Safe");
    assert.equal(listed[0].questions[0].options[1].emphasized, true);
    assert.equal(listed[0].questions[0].options[0].emphasized, undefined);

    const approval = muxFrameFromMessage({
      type: "approval/requested",
      rpcId: "rpc-a",
      sessionId: "sess-1",
      approvalId: "appr-1",
      toolName: "bash",
      reason: "Run rm -rf /tmp/x",
    });
    store.applyEnvelope(approval.rpcId, approval.frame);
    assert.equal(store.list("sess-1").length, 2);
    store.applyEnvelope("done", {
      type: "approval/resolved",
      sessionId: "sess-1",
      approvalId: "appr-1",
    });
    assert.equal(store.list("sess-1").length, 1);
    assert.deepEqual(parseDshPromptId(approvalPromptId("rpc-a", "appr-1")), {
      kind: "approval",
      rpcId: "rpc-a",
      approvalId: "appr-1",
    });
    assert.deepEqual(
      dshRespondValue("sess-1", { kind: "approval", rpcId: "rpc-a", approvalId: "appr-1" }, {
        prompt_id: approvalPromptId("rpc-a", "appr-1"),
        answers: [{ id: "decision", selected: ["Allow"] }],
      }),
      { sessionId: "sess-1", approvalId: "appr-1", outcome: "allowed-once" },
    );
  });

  it("posts a client-response to /api/respond and treats not-pending as settled", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          async json() {
            return { accepted: false, reason: "not-pending" };
          },
        };
      },
    });
    const receipt = await client.respond({
      rpc_id: "rpc-q",
      value: { sessionId: "sess-1", answer: { answers: [] } },
    });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/respond");
    assert.equal(calls[0].body.type, "client-response");
    assert.equal(calls[0].body.rpcId, "rpc-q");
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.reason, "not-pending");
  });

  it("feeds mux text frames into the live store", () => {
    const store = new DshPromptStore();
    const mux = new DshMuxSubscriber(
      { muxUrl: () => "ws://127.0.0.1:3080/api/events.mux", accessToken: () => undefined },
      store,
      async () => ({ close() {} }),
    );
    mux.acceptMessage(JSON.stringify({
      type: "server-request",
      rpcId: "rpc-q",
      method: "question/requested",
      payload: {
        sessionId: "sess-9",
        questions: [{ id: "go", question: "Continue?" }],
      },
    }));
    assert.equal(store.list("sess-9")[0].questions[0].prompt, "Continue?");
    mux.stop();
  });

  it("replays still-pending mux frames from session/subscribed", () => {
    const store = new DshPromptStore();
    store.applyEnvelope("", {
      type: "session/subscribed",
      sessionId: "sess-2",
      pending: [
        {
          type: "question/requested",
          rpcId: "rpc-live",
          questions: [{ id: "go", question: "Still waiting?" }],
        },
      ],
    });
    assert.equal(store.list("sess-2")[0].prompt_id, questionPromptId("rpc-live"));
  });

  it("answers a live prompt through respond and treats not-pending as settled", async () => {
    dropDshPromptStore("dsh-1");
    const store = dshPromptStoreFor("dsh-1");
    store.put("sess-1", {
      prompt_id: questionPromptId("rpc-q"),
      presentation: "choice",
      questions: [{ id: "go", prompt: "Continue?" }],
    });
    const calls = [];
    const result = await answerDshPrompt(
      { id: "dsh-1", config: { transport: "web", base_url: "http://127.0.0.1:3080" } },
      { source: "dsh", target: "sess-1" },
      {
        prompt_id: questionPromptId("rpc-q"),
        answers: [{ id: "go", selected: ["Yes"] }],
      },
      {},
      {
        async fetch(url, init) {
          calls.push({ url, body: JSON.parse(init.body) });
          return {
            ok: true,
            status: 200,
            async json() {
              return { accepted: false, reason: "not-pending" };
            },
          };
        },
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/respond");
    assert.equal(calls[0].body.type, "client-response");
    assert.equal(store.list("sess-1").length, 0);
    dropDshPromptStore("dsh-1");
  });
});
