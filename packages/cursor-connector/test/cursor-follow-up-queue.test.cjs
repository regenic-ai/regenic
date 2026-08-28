const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { cursorLocalClient } = require("../dist/cursor-local-client");
const {
  resetCursorLocalClientStateForTests,
  setCursorLocalClientForTests,
  setCursorSdkModuleForTests,
} = require("../dist/cursor-local-client");
const { setCursorAgentCwdMapForTests } = require("../dist/cursor-local-cwd");
const {
  enqueueCursorPendingSend,
  listCursorPendingSends,
  setCursorPendingSendsForTests,
} = require("../dist/cursor-pending-sends");

const AGENT_ID = "agent-00000000-0000-4000-8000-000000000099";

function fakeSdk(options = {}) {
  const sends = [];
  const resumes = [];
  let waitGate = Promise.resolve();
  let releaseWait = () => undefined;
  if (options.hangWait) {
    waitGate = new Promise((resolve) => {
      releaseWait = resolve;
    });
  }
  const agent = {
    agentId: AGENT_ID,
    async send(text, sendOptions) {
      sends.push({ text, options: sendOptions });
      if (typeof options.sendImpl === "function") {
        return options.sendImpl(text, sendOptions);
      }
      return {
        id: `run-${sends.length}`,
        async wait() {
          await waitGate;
        },
        async *stream() {},
      };
    },
  };
  return {
    sends,
    resumes,
    releaseWait,
    Agent: {
      async create() {
        return agent;
      },
      async resume(id) {
        resumes.push(id);
        return agent;
      },
      async get() {
        return { status: options.status ?? "IDLE", cwd: "/tmp/ws" };
      },
      messages: {
        async list() {
          return [];
        },
      },
    },
  };
}

async function eventually(check, timeoutMs = 1000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw last;
}

describe("cursor follow-up queue", () => {
  afterEach(() => {
    setCursorSdkModuleForTests();
    setCursorLocalClientForTests();
    resetCursorLocalClientStateForTests();
    setCursorPendingSendsForTests();
    setCursorAgentCwdMapForTests();
  });

  it("queues a follow-up when inspect says ACTIVE and does not resume or send", async () => {
    const sdk = fakeSdk({ status: "ACTIVE" });
    setCursorSdkModuleForTests(sdk);
    setCursorPendingSendsForTests({});
    setCursorAgentCwdMapForTests({ [AGENT_ID]: "/tmp/ws" });
    const receipt = await cursorLocalClient().send({
      apiKey: "key-1",
      agentId: AGENT_ID,
      text: "follow up later",
      cwd: "/tmp/ws",
    });
    assert.equal(typeof receipt.id, "string");
    assert.equal(receipt.id.length > 0, true);
    assert.deepEqual(sdk.resumes, []);
    assert.deepEqual(sdk.sends, []);
    assert.deepEqual(
      listCursorPendingSends(AGENT_ID).map((item) => item.text),
      ["follow up later"],
    );
  });

  it("queues when the SDK reports busy instead of forcing the live run", async () => {
    const sdk = fakeSdk({
      async sendImpl() {
        const error = new Error("already has an active run");
        error.name = "AgentBusyError";
        throw error;
      },
    });
    setCursorSdkModuleForTests(sdk);
    setCursorPendingSendsForTests({});
    setCursorAgentCwdMapForTests({ [AGENT_ID]: "/tmp/ws" });
    const receipt = await cursorLocalClient().send({
      apiKey: "key-1",
      agentId: AGENT_ID,
      text: "do not force",
      cwd: "/tmp/ws",
    });
    assert.equal(sdk.sends.length, 1);
    assert.equal(sdk.sends[0].options?.local?.force, undefined);
    assert.deepEqual(
      listCursorPendingSends(AGENT_ID).map((item) => item.text),
      ["do not force"],
    );
    assert.equal(receipt.id.length > 0, true);
  });

  it("does not flush on getAgent; flushPending starts only one queued follow-up", async () => {
    const sdk = fakeSdk({ hangWait: true });
    setCursorSdkModuleForTests(sdk);
    setCursorPendingSendsForTests({});
    setCursorAgentCwdMapForTests({ [AGENT_ID]: "/tmp/ws" });
    enqueueCursorPendingSend({
      id: "rpc-1",
      agentId: AGENT_ID,
      text: "first queued",
      cwd: "/tmp/ws",
    });
    enqueueCursorPendingSend({
      id: "rpc-2",
      agentId: AGENT_ID,
      text: "second queued",
      cwd: "/tmp/ws",
    });
    const agent = await cursorLocalClient().getAgent({
      apiKey: "key-1",
      agentId: AGENT_ID,
      cwd: "/tmp/ws",
    });
    assert.equal(agent.status, "IDLE");
    assert.deepEqual(sdk.sends, []);
    assert.equal(listCursorPendingSends(AGENT_ID).length, 2);
    await cursorLocalClient().flushPending({
      apiKey: "key-1",
      agentId: AGENT_ID,
      cwd: "/tmp/ws",
    });
    assert.deepEqual(
      sdk.sends.map((item) => item.text),
      ["first queued"],
    );
    assert.deepEqual(
      listCursorPendingSends(AGENT_ID).map((item) => item.text),
      ["second queued"],
    );
    sdk.releaseWait();
  });

  it("flushes one queued follow-up after the live run finishes wait", async () => {
    const sdk = fakeSdk({ hangWait: true });
    setCursorSdkModuleForTests(sdk);
    setCursorPendingSendsForTests({});
    setCursorAgentCwdMapForTests({ [AGENT_ID]: "/tmp/ws" });
    await cursorLocalClient().send({
      apiKey: "key-1",
      agentId: AGENT_ID,
      text: "start long job",
      cwd: "/tmp/ws",
    });
    await cursorLocalClient().send({
      apiKey: "key-1",
      agentId: AGENT_ID,
      text: "hold until idle",
      cwd: "/tmp/ws",
    });
    assert.deepEqual(
      sdk.sends.map((item) => item.text),
      ["start long job"],
    );
    assert.deepEqual(
      listCursorPendingSends(AGENT_ID).map((item) => item.text),
      ["hold until idle"],
    );
    sdk.releaseWait();
    await eventually(() => {
      assert.deepEqual(
        sdk.sends.map((item) => item.text),
        ["start long job", "hold until idle"],
      );
      assert.deepEqual(listCursorPendingSends(AGENT_ID), []);
    });
  });
});
