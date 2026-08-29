const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createMemoryEgressQueue } = require("../dist/memory-egress-queue");

describe("createMemoryEgressQueue", () => {
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
