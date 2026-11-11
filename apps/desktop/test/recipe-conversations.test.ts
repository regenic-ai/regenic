import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRecipeConversations } from "../src/renderer/src/recipe-conversations.ts";
import { conversationChoices, emptyDraft, writeBackAvailable, writeBackChoices } from "../src/renderer/src/recipe-draft.ts";
import type { InboxHeadsPage } from "../src/renderer/src/api.ts";
import type { InboxViewItem } from "../src/renderer/src/types.ts";

function head(id: string, canSend?: boolean): InboxViewItem {
  return {
    event: {
      id, org_id: "local", source: "chat", external_id: `${id}:message`,
      operation: "create", occurred_at: "2026-11-11T00:00:00Z",
      ingested_at: "2026-11-11T00:00:00Z",
    },
    decision: {
      event_id: id, org_id: "local", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: "2026-11-11T00:00:00Z",
    },
    thread_id: `chat:${id}`,
    title: `Title ${id}`,
    conversation_label: `Channel ${id}`,
    body_text: "Message text is not a conversation search index",
    can_send: canSend,
  };
}

function page(live: InboxViewItem[], extra: Partial<InboxHeadsPage> = {}): InboxHeadsPage {
  return { live, pinned: [], active_work: [], next_before: null, has_older: false, ...extra };
}

describe("recipe conversation discovery", () => {
  it("traverses every shown and hidden page, including pinned and active work outside the inbox page", async () => {
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const conversations = await loadRecipeConversations(async (query, init) => {
      assert.equal(init.signal, signal);
      assert.equal(query.limit, 200);
      calls.push(`${query.list}:${query.before_id ?? ""}`);
      if (query.list === "shown" && !query.before) {
        return page(Array.from({ length: 200 }, (_, index) => head(`shown-${index}`, true)), {
          pinned: [head("pinned", true)],
          active_work: [head("working", false)],
          next_before: { before: "2026-01-01", before_id: "shown-cursor" },
          has_older: true,
        });
      }
      if (query.list === "shown") {
        assert.equal(query.before_id, "shown-cursor");
        return page([head("beyond-200", true)], { pinned: [head("pinned", true)] });
      }
      if (!query.before) {
        return page([head("hidden", false)], {
          next_before: { before: "2025-01-01", before_id: "hidden-cursor" },
          has_older: true,
        });
      }
      assert.equal(query.before_id, "hidden-cursor");
      return page([head("older-hidden")]);
    }, signal);
    assert.equal(calls.length, 4);
    assert.equal(conversations.length, 205);
    assert.equal(conversations.find((item) => item.id === "chat:beyond-200")?.label, "Title beyond-200");
    assert.equal(conversations.find((item) => item.id === "chat:older-hidden")?.source, "chat");
    assert.equal(conversations.find((item) => item.id === "chat:hidden")?.can_send, false);
    assert.equal(conversations.find((item) => item.id === "chat:older-hidden")?.can_send, false);
    const draft = { ...emptyDraft(), thread_id: "chat:hidden" };
    assert.equal(writeBackAvailable(draft, conversations), false);
    const targets = writeBackChoices(draft, conversations, (key) => key);
    assert.ok(targets.some((item) => item.value === "chat:beyond-200"));
    assert.ok(!targets.some((item) => ["chat:hidden", "chat:older-hidden", "chat:working"].includes(item.value)));
    assert.equal(conversationChoices(conversations, {
      thread_id: "chat:missing", thread_title: "Saved selection",
    })[0]?.label, "Saved selection");
  });

  it("does not return partial success on request errors or non-advancing cursors", async () => {
    await assert.rejects(loadRecipeConversations(async () => {
      throw new Error("inbox 503");
    }, new AbortController().signal), /inbox 503/);
    await assert.rejects(loadRecipeConversations(async () =>
      page([], { has_older: true }), new AbortController().signal), /pagination did not advance/);
    await assert.rejects(loadRecipeConversations(async () =>
      page([head("repeat")], {
        has_older: true, next_before: { before: "2026-01-01", before_id: "same" },
      }), new AbortController().signal), /pagination did not advance/);
  });

  it("discards late results after cancellation even if the transport ignores abort", async () => {
    const controller = new AbortController();
    const pending = loadRecipeConversations(async () => {
      controller.abort();
      return page([head("late", true)]);
    }, controller.signal);
    await assert.rejects(pending, { name: "AbortError" });
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(loadRecipeConversations(async () => {
      assert.fail("Cancelled searches must not issue requests");
    }, cancelled.signal), { name: "AbortError" });
  });
});
