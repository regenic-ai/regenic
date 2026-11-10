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

  it("increments only explicit visibility commands and rejects stale versions", async () => {
    const store = new MemoryAuthorityStore();
    const first = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: true,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });

    assert.equal(first.outcome, "applied");
    assert.equal(first.pref.visibility_version, 1);
    assert.equal(first.pref.hidden, true);

    const stale = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.deepEqual(stale, { outcome: "conflict", current_version: 1 });

    const patched = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: "Release",
      pinned: true,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    assert.equal(patched.visibility_version, 1);
    assert.equal(patched.hidden, true);

    const shown = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    assert.equal(shown.outcome, "applied");
    assert.equal(shown.pref.visibility_version, 2);
    assert.equal(shown.pref.hidden, false);
    assert.equal(shown.pref.title, "Release");
    assert.equal(shown.pref.pinned, true);
  });

  it("replays a visibility command by command id and rejects changed parameters", async () => {
    const store = new MemoryAuthorityStore();
    const command = {
      org_id: "local-owner",
      thread_id: "dsh:session-command",
      hidden: true,
      expected_version: 0,
      command_id: "visibility-command-1",
      issued_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    };
    const applied = await store.setConversationVisibility(command);
    assert.equal(applied.outcome, "applied");
    const later = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-command",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.equal(later.outcome, "applied");

    const replay = await store.setConversationVisibility(command);
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.pref.hidden, true);
    assert.equal(replay.pref.visibility_version, 1);
    assert.equal(
      (await store.getConversationPref("local-owner", "dsh:session-command")).hidden,
      false,
    );
    const changed = await store.setConversationVisibility({
      ...command,
      hidden: false,
    });
    assert.deepEqual(changed, { outcome: "command_conflict" });
  });

  it("applies policy folding only against the visibility version it observed", async () => {
    const store = new MemoryAuthorityStore();
    const shown = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(shown.outcome, "applied");
    const stale = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.deepEqual(stale, { outcome: "conflict", current_version: 1 });
    assert.equal((await store.getConversationPref("local-owner", "dsh:session-a")).hidden, false);

    const folded = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 1,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    assert.equal(folded.outcome, "applied");
    assert.equal(folded.pref.visibility_version, 1);
    assert.equal(folded.pref.hidden_reason, "policy");

    const humanShow = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    assert.equal(humanShow.outcome, "applied");
    const lateFold = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 1,
      updated_at: "2026-08-22T00:00:04.000Z",
    });
    assert.deepEqual(lateFold, { outcome: "conflict", current_version: 2 });
    assert.equal((await store.getConversationPref("local-owner", "dsh:session-a")).hidden, false);
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
      trigger: { kind: "push", coalesce: true },
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
