const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryAuthorityStore } = require("../dist");

describe("conversation prefs", () => {
  it("patches title and pin independently", async () => {
    const store = new MemoryAuthorityStore();
    const first = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: "Release",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(first.pinned, false);
    assert.equal(first.last_read_at, null);
    const read = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      last_read_external_id: "sess-a:3",
      last_read_at: "2026-08-22T00:00:30.000Z",
      updated_at: "2026-08-22T00:00:30.000Z",
    });
    assert.equal(read.title, "Release");
    assert.equal(read.last_read_external_id, "sess-a:3");
    const pinned = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      pinned: true,
      updated_at: "2026-08-22T00:01:00.000Z",
    });
    assert.equal(pinned.title, "Release");
    assert.equal(pinned.pinned, true);
    const cleared = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: null,
      updated_at: "2026-08-22T00:02:00.000Z",
    });
    assert.equal(cleared.title, null);
    assert.equal(cleared.pinned, true);
    const listed = await store.listConversationPrefs("local-owner");
    assert.equal(listed.length, 1);
    assert.equal(await store.getConversationPref("other", "dsh:session-a"), null);
  });
});
