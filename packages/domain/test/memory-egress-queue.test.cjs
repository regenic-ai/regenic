const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createMemoryEgressQueue } = require("../dist/memory-egress-queue");
const { EgressQueueRejectedError } = require("@regenic/connector-contract");
const { SendNotAcceptedError } = require("../dist/channel-driver");

describe("createMemoryEgressQueue", () => {
  it("rejects capacity and rate limits before enqueue without claiming whole-send safety", () => {
    let now = 10_000;
    const queue = createMemoryEgressQueue({ max_pending: 1, rate_limit_ms: 2_000, now: () => now });
    const input = { installation_id: "wa-1", thread_id: "thread", chat_id: "chat", text: "hello" };
    const first = queue.enqueue(input);
    const rejected = (error) => error instanceof EgressQueueRejectedError &&
      !(error instanceof SendNotAcceptedError) && error.code === "throttled";
    assert.throws(() => queue.enqueue({ ...input, chat_id: "other" }), rejected);
    assert.equal(queue.list("wa-1").length, 1);
    queue.ack("wa-1", first.id);
    assert.throws(() => queue.enqueue(input), rejected);
    assert.equal(queue.list("wa-1").length, 0);
    now += 2_000;
    assert.ok(queue.enqueue(input).id);
  });

  it("rejects invalid text without enqueuing a command", () => {
    const queue = createMemoryEgressQueue({ max_text_chars: 4 });
    const input = { installation_id: "wa-1", thread_id: "thread", chat_id: "chat" };
    for (const text of ["", "     ", "12345"]) {
      assert.throws(() => queue.enqueue({ ...input, text }),
        (error) => error instanceof EgressQueueRejectedError && error.code === "invalid_config");
    }
    assert.equal(queue.list("wa-1").length, 0);
  });

  it("enqueues, lists, and acks by installation", () => {
    const queue = createMemoryEgressQueue({ rate_limit_ms: 0 });
    const item = queue.enqueue({
      installation_id: "wa-1",
      thread_id: "whatsapp-personal:1555@c.us",
      chat_id: "1555@c.us",
      text: "hello",
    });
    assert.equal(queue.list("wa-1")[0].id, item.id);
    assert.equal(queue.list("other").length, 0);
    assert.deepEqual(queue.ack("wa-1", item.id), { acknowledged: true });
    assert.equal(queue.list("wa-1").length, 0);
  });
});
