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

  it("clears operational data and keeps recipes", async () => {
    const store = new MemoryAuthorityStore();
    await store.append({
      org_id: "local-owner",
      source: "regenic",
      external_id: "ask-1",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 4,
      occurred_at: "2026-08-26T00:00:00.000Z",
      expected_head_id: null,
    });
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "regenic:ask-1",
      title: "Scratch",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await store.putRecipe({
      id: "keep-recipe",
      org_id: "local-owner",
      name: "Keep me",
      match: { record_class: "task" },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await store.putWorkItem({
      id: "drop-work",
      org_id: "local-owner",
      thread_id: "regenic:ask-1",
      unit_key: "unit-1",
      record_class: "utterance",
      thread_facet: "chat",
      status: "open",
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    const before = await store.summarizeStore("local-owner");
    const cleared = await store.clearOperationalData(
      "local-owner",
      "2026-08-26T00:01:00.000Z",
    );
    const after = await store.summarizeStore("local-owner");
    assert.equal(before.events, 1);
    assert.equal(before.work_items, 1);
    assert.equal(cleared.cleared.events, 1);
    assert.equal(cleared.kept.recipes, 1);
    assert.equal(after.events, 0);
    assert.equal(after.work_items, 0);
    assert.equal(after.recipes, 1);
    assert.equal(await store.getConversationPref("local-owner", "regenic:ask-1"), null);
    assert.equal((await store.listRecipes("local-owner"))[0].id, "keep-recipe");
  });
});
