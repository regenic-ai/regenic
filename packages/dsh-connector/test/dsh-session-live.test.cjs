const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DshMuxSubscriber,
  DshPromptStore,
  DshSessionLiveHub,
  DshSessionPollConnector,
  dshMuxFrameWaits,
  sessionEventFromMuxFrame,
} = require("../dist");

function turnEndFrame(sessionId, seq) {
  return {
    type: "server-request",
    rpcId: `rpc-${seq}`,
    method: "session/event",
    payload: {
      type: "session/event",
      sessionId,
      event: {
        type: "turn/end",
        seq,
        time: 1_724_208_000_000 + seq,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    },
  };
}

describe("DSH mux wait", () => {
  it("unwraps harness session/event frames and treats turn/end as wait", () => {
    const parsed = sessionEventFromMuxFrame({
      type: "session/event",
      sessionId: "sess-1",
      event: {
        type: "turn/end",
        seq: 12,
        time: 1_724_208_000_000,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    });
    assert.equal(parsed.sessionId, "sess-1");
    assert.equal(parsed.event.type, "turn/end");
    assert.equal(parsed.event.seq, 12);
    assert.equal(dshMuxFrameWaits({ type: "session/event", event: parsed.event }), true);
    assert.equal(dshMuxFrameWaits({ type: "session/event", event: { type: "assistant/chunk" } }), false);
    assert.equal(dshMuxFrameWaits({ type: "question/requested", sessionId: "sess-1" }), true);
    assert.equal(dshMuxFrameWaits({ type: "assistant/chunk" }), false);
  });

  it("buffers mux session events and drains them on poll without calling history", async () => {
    const hub = new DshSessionLiveHub();
    const historyCalls = [];
    const connector = new DshSessionPollConnector(
      {
        async sessionHistory(input) {
          historyCalls.push(input);
          return { events: [], hasMore: false };
        },
      },
      {
        connector_id: "dsh-1",
        org_id: "local-owner",
        session_id: "sess-1",
        now: () => "2026-09-02T00:00:00.000Z",
        live: hub,
      },
    );
    hub.offer("sess-1", {
      type: "assistant/message",
      seq: 11,
      time: 1_724_208_000_100,
      data: { message: { content: [{ type: "text", text: "Approved." }] } },
    });
    hub.offer("sess-1", {
      type: "turn/end",
      seq: 12,
      time: 1_724_208_000_200,
      data: { turn: 1, reason: { kind: "completed" } },
    });
    const result = await connector.poll({ value: "10" });
    assert.equal(historyCalls.length, 0);
    assert.equal(result.next_cursor, "10");
    assert.deepEqual(result.poll_hint, { live_seeded: true, history_pending: false });
    assert.equal(result.batch.delivery_id.startsWith("dsh-live:sess-1:"), true);
    assert.equal(result.batch.records[0].external_id, "sess-1:11");
    assert.equal(result.batch.records[1].external_id, "sess-1:12");
    const again = await connector.poll({ value: "10" });
    assert.equal(historyCalls.length, 1);
    assert.equal(again.batch.records.length, 0);
  });

  it("notifies waiters on turn/end and prompt frames, not on chunks", async () => {
    const hub = new DshSessionLiveHub();
    const store = new DshPromptStore();
    const mux = new DshMuxSubscriber(
      { muxUrl: () => "ws://127.0.0.1:3080/api/events.mux", accessToken: () => undefined },
      store,
      async () => ({ close() {} }),
      hub,
    );
    const seen = [];
    const dispose = hub.wait("sess-1", () => {
      seen.push("wait");
    });
    mux.acceptMessage(JSON.stringify({
      type: "server-request",
      rpcId: "rpc-chunk",
      method: "session/event",
      payload: {
        type: "session/event",
        sessionId: "sess-1",
        event: { type: "assistant/chunk", seq: 8, time: 1, data: { chunk: {} } },
      },
    }));
    mux.acceptMessage(JSON.stringify(turnEndFrame("sess-1", 9)));
    mux.acceptMessage(JSON.stringify({
      type: "server-request",
      rpcId: "rpc-q",
      method: "question/requested",
      payload: {
        sessionId: "sess-1",
        questions: [{ id: "go", question: "Continue?" }],
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(seen.length, 1);
    assert.equal(hub.drain("sess-1").map((event) => event.seq).join(","), "9");
    assert.equal(store.list("sess-1").length, 1);
    dispose();
    mux.stop();
    hub.stop();
  });
});
