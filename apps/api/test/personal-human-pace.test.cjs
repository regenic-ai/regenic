const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  HUMAN_IDLE_MS,
  PRESENCE_TTL_MS,
  conversationPresenceFromBody,
  isHumanIdle,
  markKernelReady,
  noteHumanActivity,
  reportConversationPresence,
  resetHumanPace,
} = require("../dist/personal-human-pace");

afterEach(() => {
  resetHumanPace();
});

describe("human pace", () => {
  it("stays busy until the kernel has been quiet since listen", () => {
    assert.equal(isHumanIdle(1_000), false);
    markKernelReady(1_000);
    assert.equal(isHumanIdle(1_000 + HUMAN_IDLE_MS - 1), false);
    assert.equal(isHumanIdle(1_000 + HUMAN_IDLE_MS), true);
  });

  it("treats opening a thread as activity that defers background work", () => {
    markKernelReady(1_000);
    noteHumanActivity(5_000);
    assert.equal(isHumanIdle(5_000 + HUMAN_IDLE_MS - 1), false);
    assert.equal(isHumanIdle(5_000 + HUMAN_IDLE_MS), true);
  });

  it("parses desktop presence reports", () => {
    assert.deepEqual(
      conversationPresenceFromBody({ looking: true, thread_id: " feishu:oc_1 " }),
      { looking: true, thread_id: "feishu:oc_1" },
    );
    assert.deepEqual(conversationPresenceFromBody({ looking: false, thread_id: "feishu:oc_1" }), {
      looking: false,
      thread_id: null,
    });
    assert.deepEqual(conversationPresenceFromBody({}), { looking: false, thread_id: null });
  });

  it("lets a fresh looking report freeze catch-up and a not-looking report resume it immediately", () => {
    markKernelReady(1_000);
    reportConversationPresence({ looking: true, thread_id: "feishu:oc_1", now: 5_000 });
    assert.equal(isHumanIdle(5_000), false);
    reportConversationPresence({ looking: false, now: 5_100 });
    assert.equal(isHumanIdle(5_100), true);
  });

  it("expires a stale looking report so catch-up can resume", () => {
    markKernelReady(1_000);
    reportConversationPresence({ looking: true, thread_id: "feishu:oc_1", now: 5_000 });
    assert.equal(isHumanIdle(5_000 + PRESENCE_TTL_MS - 1), false);
    assert.equal(isHumanIdle(5_000 + PRESENCE_TTL_MS), true);
  });
});
