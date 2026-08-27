const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverRegistry,
  collectLatestInbound,
  computeThreadUnread,
  normalizeMessageReceipt,
  normalizePromptAnswers,
  withSurfaceGeneration,
} = require("../dist");

function stubDriver(partial) {
  return {
    install() {
      throw new Error("not used");
    },
    resolveStreams() {
      return Promise.resolve([]);
    },
    resolveThreadStream() {
      return Promise.reject(new Error("not used"));
    },
    bindEgress() {
      return Promise.reject(new Error("not used"));
    },
    outboundId() {
      return "out";
    },
    capabilities() {
      return { sync: true, reply: false, create: false };
    },
    createThread() {
      return Promise.reject(new Error("not used"));
    },
    matchesThread: () => false,
    ownsThread: () => false,
    canReply: () => false,
    ...partial,
  };
}

describe("thread surface", () => {
  it("treats awaiting_user and live prompts as unread", () => {
    const fromPrompt = computeThreadUnread({
      prompts: [{ prompt_id: "q:1", presentation: "choice", questions: [] }],
    });
    assert.equal(fromPrompt.unread, true);
    const fromWait = computeThreadUnread({
      activity: "awaiting_user",
      pref: { last_read_at: "2026-08-24T00:00:00.000Z", last_read_external_id: "a:1" },
      latestInbound: { external_id: "a:1", occurred_at: "2026-08-24T00:00:00.000Z" },
    });
    assert.equal(fromWait.unread, true);
  });

  it("does not let a source 'read' overlay hide a never-opened inbound", () => {
    const hidden = computeThreadUnread({
      source: { unread: false, unread_count: 0 },
      latestInbound: { external_id: "om_new", occurred_at: "2026-08-24T12:00:00.000Z" },
    });
    assert.equal(hidden.unread, true);
    const opened = computeThreadUnread({
      source: { unread: true, unread_count: 3 },
      latestInbound: { external_id: "om_new", occurred_at: "2026-08-24T12:00:00.000Z" },
      pref: {
        last_read_at: "2026-08-24T12:00:00.000Z",
        last_read_external_id: "om_new",
      },
    });
    assert.equal(opened.unread, false);
    const sourceOnly = computeThreadUnread({
      source: { unread: true, unread_count: 2 },
    });
    assert.equal(sourceOnly.unread, true);
    assert.equal(sourceOnly.unread_count, 2);
    const officialReadWithoutInbound = computeThreadUnread({
      source: { unread: false, unread_count: 0 },
    });
    assert.equal(officialReadWithoutInbound.unread, false);
  });

  it("picks the latest inbound on the thread, not the list face", () => {
    const latest = collectLatestInbound([
      {
        thread_id: "agent:s1",
        external_id: "s1:in",
        occurred_at: "2026-08-24T10:00:00.000Z",
        direction: "inbound",
      },
      {
        thread_id: "agent:s1",
        external_id: "s1:out:1",
        occurred_at: "2026-08-24T12:00:00.000Z",
        direction: "outbound",
      },
    ]);
    assert.deepEqual(latest.get("agent:s1"), {
      external_id: "s1:in",
      occurred_at: "2026-08-24T10:00:00.000Z",
    });
    const unread = computeThreadUnread({
      latestInbound: latest.get("agent:s1"),
    });
    assert.equal(unread.unread, true);
    const read = computeThreadUnread({
      latestInbound: latest.get("agent:s1"),
      pref: {
        last_read_at: "2026-08-24T10:00:00.000Z",
        last_read_external_id: "s1:in",
      },
    });
    assert.equal(read.unread, false);
  });

  it("lets custom replace selected on a single-select prompt", () => {
    const answers = normalizePromptAnswers(
      [{ id: "mode", prompt: "Which?", options: [{ label: "A" }] }],
      [{ id: "mode", selected: ["A"], custom: "Other" }],
    );
    assert.deepEqual(answers, [{ id: "mode", selected: [], custom: "Other" }]);
    const multi = normalizePromptAnswers(
      [{ id: "mode", prompt: "Which?", multi_select: true }],
      [{ id: "mode", selected: ["A"], custom: "Also" }],
    );
    assert.deepEqual(multi, [{ id: "mode", selected: ["A"], custom: "Also" }]);
  });

  it("falls back to the local read cursor", () => {
    const unread = computeThreadUnread({
      latestInbound: { external_id: "om_2", occurred_at: "2026-08-24T12:00:00.000Z" },
      pref: { last_read_at: "2026-08-24T11:00:00.000Z", last_read_external_id: "om_1" },
    });
    assert.equal(unread.unread, true);
    const read = computeThreadUnread({
      latestInbound: { external_id: "om_1", occurred_at: "2026-08-24T11:00:00.000Z" },
      pref: { last_read_at: "2026-08-24T11:00:00.000Z", last_read_external_id: "om_1" },
    });
    assert.equal(read.unread, false);
  });

  it("appends a live surface generation without breaking the event digest", () => {
    const base = "1:2026-08-24T00:00:00.000Z:e1:0:";
    assert.equal(withSurfaceGeneration(base, ""), base);
    assert.equal(withSurfaceGeneration(base, "dsh:3"), `${base}&s=dsh:3`);
    assert.equal(withSurfaceGeneration(`${base}&s=old`, "new"), `${base}&s=new`);
  });

  it("answers prompts through the driver, not a channel name", async () => {
    const drivers = new ChannelDriverRegistry().register(
      stubDriver({
        connector_type: "agent-session",
        source: "agent",
        capabilities: () => ({
          sync: true,
          reply: true,
          create: false,
          prompts: true,
        }),
        matchesThread: (_installation, thread) => thread.source === "agent",
        ownsThread: () => true,
        canReply: () => true,
        async listPrompts() {
          return [{
            prompt_id: "q:rpc",
            presentation: "choice",
            questions: [{ id: "one", prompt: "Go?", options: [{ label: "Yes" }] }],
          }];
        },
        async answerPrompt(_installation, _thread, answer) {
          assert.equal(answer.prompt_id, "q:rpc");
          assert.deepEqual(answer.answers, [
            { id: "one", selected: [], custom: "Later" },
          ]);
          return { accepted: true };
        },
      }),
    );
    const installation = {
      id: "a1",
      org_id: "local-owner",
      connector_type: "agent-session",
      status: "enabled",
      config: {},
      created_at: "2026-08-24T00:00:00.000Z",
    };
    const thread = { source: "agent", target: "s1" };
    const listed = await drivers.listPrompts([installation], thread, {});
    assert.equal(listed[0].prompt_id, "q:rpc");
    const answered = await drivers.answerPrompt(
      [installation],
      thread,
      { prompt_id: "q:rpc", answers: [{ id: "one", selected: ["Yes"], custom: "Later" }] },
      {},
    );
    assert.equal(answered.accepted, true);
    assert.equal(drivers.canPrompt([installation], thread), true);
    assert.equal(drivers.canAttention([installation], thread), false);
    assert.equal(drivers.canReceipt([installation], thread), false);
  });

  it("keeps peer-read receipts off the unread cursor", () => {
    assert.deepEqual(normalizeMessageReceipt({ state: "read", read_count: 2 }), {
      state: "read",
      read_count: 2,
    });
    assert.equal(normalizeMessageReceipt({ state: "opened" }), undefined);
    const unread = computeThreadUnread({
      latestInbound: { external_id: "in:1", occurred_at: "2026-08-24T10:00:00.000Z" },
    });
    assert.equal(unread.unread, true);
  });

  it("reads receipts through the driver, not a channel name", async () => {
    const drivers = new ChannelDriverRegistry().register(
      stubDriver({
        connector_type: "chat",
        source: "chat",
        capabilities: () => ({
          sync: true,
          reply: true,
          create: false,
          receipts: true,
        }),
        matchesThread: (_installation, thread) => thread.source === "chat",
        ownsThread: () => true,
        canReply: () => true,
        async readReceipts(_installation, threads) {
          const receipts = new Map();
          receipts.set(threads[0].outbound[0].external_id, {
            state: "read",
            read_count: 1,
          });
          return receipts;
        },
      }),
    );
    const installation = {
      id: "c1",
      org_id: "local-owner",
      connector_type: "chat",
      status: "enabled",
      config: {},
      created_at: "2026-08-24T00:00:00.000Z",
    };
    const thread = { source: "chat", target: "oc_1" };
    assert.equal(drivers.canReceipt([installation], thread), true);
    const receipts = await drivers.readReceipts(
      [installation],
      [
        {
          ...thread,
          outbound: [
            { external_id: "oc_1:out:om_1", occurred_at: "2026-08-24T12:00:00.000Z" },
          ],
        },
      ],
      {},
    );
    assert.deepEqual(receipts.get("oc_1:out:om_1"), {
      state: "read",
      read_count: 1,
    });
  });
});
