const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalEventsService } = require("../dist/personal-events.service");

describe("PersonalEventsService", () => {
  it("delivers inbox.digest and thread.updated to subscribers", () => {
    const service = new PersonalEventsService();
    const seen = [];
    const off = service.subscribe((type, payload) => {
      seen.push({ type, payload });
    });
    service.inboxDigest("1:abc");
    service.threadUpdated("feishu:oc_1");
    off();
    service.inboxDigest("1:def");
    assert.deepEqual(seen, [
      { type: "inbox.digest", payload: { digest: "1:abc" } },
      { type: "thread.updated", payload: { thread_id: "feishu:oc_1" } },
    ]);
  });

  it("ignores empty payloads", () => {
    const service = new PersonalEventsService();
    const seen = [];
    service.subscribe((type, payload) => {
      seen.push({ type, payload });
    });
    service.inboxDigest("   ");
    service.threadUpdated("");
    assert.equal(seen.length, 0);
  });
});
