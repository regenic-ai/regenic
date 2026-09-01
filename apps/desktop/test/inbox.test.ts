import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupInboxThreads,
  groupThreadsByAttention,
  evictThreadCache,
  keepSelectedThreadId,
  latestInboundOf,
  markInboxThreadRead,
  messagesForAttentionAck,
  orderThreadMessages,
  openedThreadView,
  overlayThreadMessages,
  holdOpenedThread,
  filterInboxThreadsByTitle,
  mergeInboxThreadLists,
  adjacentInboxThreadId,
  canMoveInboxThread,
  inboxListNavDelta,
  applyPrefOverlay,
  resolveSelectedThread,
  resolveThreadAttention,
  sortInboxThreads,
  workThreadId,
  type InboxThread,
} from "../src/renderer/src/inbox.ts";
import {
  applyOpenedAt,
  createConversationTargets,
  draftFromForward,
  localDraftConversation,
  localDraftOutbound,
  mergeDraftThreads,
} from "../src/renderer/src/inbox-drafts.ts";
import { reuseInboxList } from "../src/renderer/src/thread-window.ts";
import type { InboxViewItem } from "../src/renderer/src/types.ts";

function feishuHead(
  id: string,
  occurredAt: string,
  threadId: string,
  conversationLabel: string | null,
): InboxViewItem {
  const item = message(id, occurredAt, threadId);
  const target = threadId.slice("feishu:".length);
  return {
    ...item,
    event: {
      ...item.event,
      source: "feishu",
      external_id: `${target}:${id}`,
    },
    channel: "feishu",
    channel_label: "Feishu",
    conversation_label: conversationLabel,
    list_title: "conversation",
  };
}

function message(
  id: string,
  occurredAt: string,
  threadId = "dsh:old",
): InboxViewItem {
  return {
    decision: {
      event_id: id,
      org_id: "org",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: [],
      score: 1,
      decided_at: occurredAt,
    },
    event: {
      id,
      org_id: "org",
      source: "dsh",
      external_id: `${threadId}:${id}`,
      operation: "create",
      occurred_at: occurredAt,
      ingested_at: occurredAt,
    },
    body_text: id,
    channel: "dsh",
    channel_label: "DSH",
    kind: "user",
    direction: "outbound",
    can_send: true,
    thread_id: threadId,
  };
}

function install(input: {
  id: string;
  connector_type?: string;
  channel?: string;
  channel_label?: string;
  label: string;
  can_create: boolean;
}) {
  return {
    id: input.id,
    connector_type: input.connector_type ?? "dsh-session",
    status: "enabled" as const,
    label: input.label,
    detail: null,
    syncable: true,
    can_reply: true,
    can_create: input.can_create,
    channel: input.channel,
    channel_label: input.channel_label,
    last_attempt: null,
  };
}

function thread(input: {
  id: string;
  pinned?: boolean;
  opened_at?: string;
  occurred_at?: string;
}): InboxThread {
  const messages = input.occurred_at
    ? [message(`${input.id}-m`, input.occurred_at, input.id)]
    : [];
  return {
    id: input.id,
    source: "dsh",
    channel: "dsh",
    channel_label: "DSH",
    label: input.id,
    title: null,
    conversation_label: null,
    conversation_kind: null,
    unit_kind: null,
    unit_kind_label: null,
    pinned: input.pinned === true,
    hidden: false,
    can_send: true,
    opened_at: input.opened_at,
    messages,
    prompts: [],
    unread: false,
    unread_count: 0,
  };
}

describe("opened conversation identity", () => {
  it("keeps the current thread when the visible list no longer includes it", () => {
    assert.equal(keepSelectedThreadId("feishu:open", "feishu:other"), "feishu:open");
    assert.equal(keepSelectedThreadId(null, "feishu:first"), "feishu:first");
    assert.equal(keepSelectedThreadId(null, null), null);
  });

  it("resolves an open thread from the catalog or the last held face", () => {
    const open = thread({ id: "feishu:open" });
    const other = thread({ id: "feishu:other" });
    assert.equal(resolveSelectedThread("feishu:open", [other, open], null), open);
    const held = { ...open, hidden: true };
    assert.equal(
      resolveSelectedThread("feishu:open", [other], held)?.id,
      "feishu:open",
    );
    assert.equal(resolveSelectedThread("feishu:open", [other], null), null);
    assert.equal(resolveSelectedThread(null, [open], open), null);
    assert.equal(
      resolveSelectedThread("feishu:open", [other], other),
      null,
    );
  });
});

describe("inbox title search", () => {
  it("matches custom and automatic titles without regard to case", () => {
    const named = { ...thread({ id: "dsh:named" }), title: "Weekly Sync" };
    const labeled = {
      ...thread({ id: "dsh:label" }),
      title: null,
      conversation_label: "Order 42",
      list_title: "conversation" as const,
    };
    const hidden = { ...named, id: "dsh:hidden", hidden: true, title: "Old Weekly" };
    const renamed = {
      ...thread({ id: "dsh:renamed" }),
      title: "Project X",
      conversation_label: "Weekly Sync",
    };
    const hits = filterInboxThreadsByTitle(
      mergeInboxThreadLists([named], [hidden, labeled, renamed]),
      "  weekly ",
      (item) => item.title ?? item.conversation_label ?? item.label,
    );
    assert.deepEqual(
      hits.map((item) => item.id),
      ["dsh:named", "dsh:hidden", "dsh:renamed"],
    );
    assert.deepEqual(
      filterInboxThreadsByTitle([named, labeled], "   ", (item) => item.title ?? item.label).map(
        (item) => item.id,
      ),
      ["dsh:named", "dsh:label"],
    );
  });

  it("stays on the current thread at the ends of the visible list", () => {
    const ids = ["a", "b", "c"];
    assert.equal(adjacentInboxThreadId(ids, "b", 1), "c");
    assert.equal(adjacentInboxThreadId(ids, "b", -1), "a");
    assert.equal(adjacentInboxThreadId(ids, "c", 1), "c");
    assert.equal(adjacentInboxThreadId(ids, "a", -1), "a");
    assert.equal(adjacentInboxThreadId([], "a", 1), "a");
    assert.equal(canMoveInboxThread(ids, "a", -1), false);
    assert.equal(canMoveInboxThread(ids, "a", 1), true);
  });

  it("maps Gmail J/K and Alt arrows, and ignores modified keys", () => {
    assert.equal(inboxListNavDelta({ key: "j", altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false }), 1);
    assert.equal(inboxListNavDelta({ key: "K", altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false }), -1);
    assert.equal(
      inboxListNavDelta({ key: "ArrowDown", altKey: true, metaKey: false, ctrlKey: false, defaultPrevented: false }),
      1,
    );
    assert.equal(
      inboxListNavDelta({ key: "j", altKey: true, metaKey: false, ctrlKey: false, defaultPrevented: false }),
      null,
    );
    assert.equal(
      inboxListNavDelta({ key: "j", altKey: false, metaKey: true, ctrlKey: false, defaultPrevented: false }),
      null,
    );
  });
});

describe("workThreadId", () => {
  it("keeps a DSH session with colons on one thread for inbound and outbound", () => {
    assert.equal(
      workThreadId("dsh", "workspace:session:49", "evt"),
      workThreadId("dsh", "workspace:session:out:rpc-1", "evt"),
    );
    assert.equal(
      workThreadId("dsh", "workspace:session:out:rpc-1", "evt"),
      "dsh:workspace:session",
    );
  });
});

describe("inbox sort", () => {
  it("ranks attention before recency when asked", () => {
    const quiet = thread({
      id: "feishu:old",
      occurred_at: "2026-08-25T12:00:00.000Z",
    });
    const waiting = {
      ...thread({
        id: "feishu:need",
        occurred_at: "2026-08-25T10:00:00.000Z",
      }),
      attention: "waiting_you" as const,
      work: { id: "work-1", status: "waiting_human" as const },
    };
    const running = {
      ...thread({
        id: "feishu:run",
        occurred_at: "2026-08-25T13:00:00.000Z",
      }),
      attention: "running" as const,
      work: { id: "work-2", status: "running" as const },
    };
    const sorted = sortInboxThreads([quiet, running, waiting], "attention");
    assert.equal(sorted[0].id, "feishu:need");
    assert.equal(sorted[1].id, "feishu:run");
    assert.equal(sorted[2].id, "feishu:old");
    const normal = sortInboxThreads([quiet, running, waiting], "normal");
    assert.equal(normal[0].id, "feishu:run");
  });

  it("uses unread and prompts even when attention is missing", () => {
    const olderUnread = {
      ...thread({
        id: "feishu:old",
        occurred_at: "2026-08-25T09:00:00.000Z",
      }),
      unread: true,
    };
    const newerQuiet = thread({
      id: "feishu:new",
      occurred_at: "2026-08-25T13:00:00.000Z",
    });
    assert.equal(
      resolveThreadAttention({
        ...thread({ id: "feishu:dead" }),
        work: {
          id: "work-dead",
          status: "done",
          delivery: { status: "dead", write_back: "failed", attempts: 3 },
        },
      }),
      "waiting_you",
    );
    assert.equal(
      resolveThreadAttention({
        ...olderUnread,
        attention: "waiting_you",
      }),
      "waiting_you",
    );
    assert.equal(resolveThreadAttention(olderUnread), "unread");
    assert.equal(sortInboxThreads([newerQuiet, olderUnread], "attention")[0].id, "feishu:old");
    assert.equal(sortInboxThreads([newerQuiet, olderUnread], "normal")[0].id, "feishu:new");
    const grouped = groupThreadsByAttention(
      sortInboxThreads([newerQuiet, olderUnread], "attention"),
    );
    assert.deepEqual(
      grouped.map((section) => section.label),
      ["Unread", "The rest"],
    );
  });

  it("puts a just-opened empty conversation above older unpinned threads", () => {
    const older = thread({
      id: "dsh:old",
      occurred_at: "2026-08-21T00:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
    });
    const sorted = sortInboxThreads([older, created]);
    assert.equal(sorted[0].id, "dsh:new");
    assert.equal(sorted[1].id, "dsh:old");
  });

  it("keeps a new conversation at the top even if its first event is older", () => {
    const older = thread({
      id: "dsh:old",
      occurred_at: "2026-08-23T11:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
      occurred_at: "2026-08-20T00:00:00.000Z",
    });
    const sorted = sortInboxThreads([older, created]);
    assert.equal(sorted[0].id, "dsh:new");
  });

  it("keeps pinned threads above a new empty conversation", () => {
    const pinned = thread({
      id: "feishu:oc_1",
      pinned: true,
      occurred_at: "2026-08-22T00:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
    });
    const sorted = sortInboxThreads([created, pinned]);
    assert.equal(sorted[0].id, "feishu:oc_1");
    assert.equal(sorted[1].id, "dsh:new");
  });

  it("folds a Feishu thread-reply alias into the parent chat so pin is one row", () => {
    const parent = {
      ...feishuHead(
        "om_face",
        "2026-08-27T17:21:00.000Z",
        "feishu:oc_abc",
        "内部达人审核AgentSkill",
      ),
      pinned: true,
      pref_updated_at: "2026-08-27T17:22:00.000Z",
    };
    const alias = {
      ...feishuHead(
        "om_reply",
        "2026-08-27T17:21:00.000Z",
        "feishu:oc_abc",
        "内部达人审核AgentSkill",
      ),
      thread_id: "feishu:oc_abc:om_root",
      pinned: false,
    };
    const threads = groupInboxThreads([parent, alias]);
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "feishu:oc_abc");
    assert.equal(threads[0]?.pinned, true);
  });

  it("keeps the conversation title when a new head has no name", () => {
    const named = feishuHead(
      "in-1",
      "2026-08-27T17:20:00.000Z",
      "feishu:oc_abc",
      "交付运营沟通群",
    );
    const outbound = feishuHead(
      "out-1",
      "2026-08-27T17:27:00.000Z",
      "feishu:oc_abc",
      null,
    );
    const previous = groupInboxThreads([named]);
    assert.equal(previous[0]?.conversation_label, "交付运营沟通群");
    const next = groupInboxThreads([outbound], previous);
    assert.equal(next[0]?.conversation_label, "交付运营沟通群");
    const rawId = feishuHead(
      "out-2",
      "2026-08-27T17:28:00.000Z",
      "feishu:oc_abc",
      "oc_abc",
    );
    assert.equal(groupInboxThreads([rawId], previous)[0]?.conversation_label, "交付运营沟通群");
  });

  it("does not let an outbound head flip a direct chat to group", () => {
    const inbound = {
      ...feishuHead(
        "in-1",
        "2026-08-27T17:20:00.000Z",
        "feishu:oc_abc",
        "李诗婷",
      ),
      direction: "inbound" as const,
      conversation_kind: "direct",
    };
    const outbound = {
      ...feishuHead(
        "out-1",
        "2026-08-27T17:27:00.000Z",
        "feishu:oc_abc",
        "李诗婷",
      ),
      conversation_kind: "group",
    };
    const previous = groupInboxThreads([inbound]);
    assert.equal(previous[0]?.conversation_kind, "direct");
    const next = groupInboxThreads([outbound], previous);
    assert.equal(next[0]?.conversation_kind, "direct");
    const both = groupInboxThreads([inbound, outbound], previous);
    assert.equal(both[0]?.conversation_kind, "direct");
  });

  it("keeps a stamped unit_kind on the thread from inbound", () => {
    const inbound = {
      ...feishuHead(
        "in-1",
        "2026-08-27T17:20:00.000Z",
        "feishu:oc_abc",
        "李诗婷",
      ),
      direction: "inbound" as const,
      unit_kind: "crm.order_review",
      unit_kind_label: "Order review",
    };
    const outbound = {
      ...feishuHead(
        "out-1",
        "2026-08-27T17:27:00.000Z",
        "feishu:oc_abc",
        "李诗婷",
      ),
      unit_kind: "crm.lead_followup",
      unit_kind_label: "Lead follow-up",
    };
    const previous = groupInboxThreads([inbound]);
    assert.equal(previous[0]?.unit_kind, "crm.order_review");
    assert.equal(previous[0]?.unit_kind_label, "Order review");
    const next = groupInboxThreads([outbound], previous);
    assert.equal(next[0]?.unit_kind, "crm.order_review");
    assert.equal(next[0]?.unit_kind_label, "Order review");
  });

  it("appends into one thread without rebuilding the others", () => {
    const first = [
      message("a", "2026-08-23T10:00:00.000Z", "dsh:one"),
      message("b", "2026-08-23T10:01:00.000Z", "dsh:two"),
    ];
    const extra = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const previous = groupInboxThreads(first);
    const reused = reuseInboxList(first, [...first, extra]);
    const next = groupInboxThreads(reused.items, previous, reused);
    assert.equal(
      next.find((entry) => entry.id === "dsh:two"),
      previous.find((entry) => entry.id === "dsh:two"),
    );
    assert.notEqual(
      next.find((entry) => entry.id === "dsh:one"),
      previous.find((entry) => entry.id === "dsh:one"),
    );
    assert.equal(next.find((entry) => entry.id === "dsh:one")?.messages[1], extra);
  });

  it("overlays a loaded thread without rebuilding the other rows", () => {
    const first = [
      message("a", "2026-08-23T10:00:00.000Z", "dsh:one"),
      message("b", "2026-08-23T10:01:00.000Z", "dsh:two"),
    ];
    const threads = groupInboxThreads(first);
    const extra = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const next = overlayThreadMessages(threads, { "dsh:one": [first[0], extra] });
    assert.equal(next.find((entry) => entry.id === "dsh:two"), threads.find((entry) => entry.id === "dsh:two"));
    assert.equal(next.find((entry) => entry.id === "dsh:one")?.messages.length, 2);
  });

  it("shows a loaded thread oldest-first even if the payload arrived newest-first", () => {
    const older = message("a", "2026-08-23T10:00:00.000Z", "dsh:one");
    const newer = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const other = message("b", "2026-08-23T10:01:00.000Z", "dsh:two");
    const threads = groupInboxThreads([older, other]);
    const next = overlayThreadMessages(threads, { "dsh:one": [newer, older] });
    const messages = next.find((entry) => entry.id === "dsh:one")?.messages ?? [];
    assert.equal(messages[0], older);
    assert.equal(messages[1], newer);
    assert.deepEqual(
      orderThreadMessages([newer, older]).map((item) => item.event.id),
      ["a", "c"],
    );
  });

  it("joins a source-side forward trace onto the original messages", () => {
    const source = message("ev-1", "2026-08-23T10:00:00.000Z", "dsh:one");
    const later = {
      thread_id: "dsh:created-1",
      event_ids: ["ev-1"],
      source: "dsh",
      channel_label: "DSH",
    };
    const first = {
      ...message("st-1", "2026-08-23T10:01:00.000Z", "dsh:one"),
      body_text: undefined,
      kind: "system" as const,
      record_class: "status" as const,
      forwarded_to: {
        thread_id: "dsh:sess-b",
        event_ids: ["ev-1"],
        source: "dsh",
        channel_label: "DSH",
      },
    };
    const newest = {
      ...message("st-2", "2026-08-23T10:02:00.000Z", "dsh:one"),
      body_text: undefined,
      kind: "system" as const,
      record_class: "status" as const,
      forwarded_to: later,
    };
    const ordered = orderThreadMessages([source, newest, first]);
    assert.deepEqual(
      ordered.find((item) => item.event.id === "ev-1")?.forwarded_to,
      later,
    );
  });

  it("does not treat the list head as the opened transcript", () => {
    const head = message("a", "2026-08-23T10:00:00.000Z", "feishu:oc_yiki");
    const extra = message("b", "2026-08-23T10:01:00.000Z", "feishu:oc_yiki");
    const [row] = groupInboxThreads([head]);
    const opening = openedThreadView(row, undefined, true);
    assert.deepEqual(opening.messages, []);
    const failed = openedThreadView(row, undefined, false);
    assert.deepEqual(failed.messages, []);
    const loaded = openedThreadView(row, [head, extra], false);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[1], extra);
  });

  it("keeps an already-opened transcript when the cache is briefly missing", () => {
    const head = message("a", "2026-08-23T10:00:00.000Z", "feishu:oc_yiki");
    const extra = message("b", "2026-08-23T10:01:00.000Z", "feishu:oc_yiki");
    const [row] = groupInboxThreads([head]);
    const previous = openedThreadView(row, [head, extra], false);
    const held = holdOpenedThread(previous, row, undefined);
    assert.equal(held.messages.length, 2);
    assert.equal(held.messages[1], extra);
    const cold = holdOpenedThread(previous, row, []);
    assert.deepEqual(cold.messages, []);
    const firstOpen = holdOpenedThread(null, row, undefined);
    assert.deepEqual(firstOpen.messages, []);
  });

  it("evicts older thread caches and keeps the open one", () => {
    const cache = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`dsh:${index}`, [message(String(index), "2026-08-23T10:00:00.000Z", `dsh:${index}`)]]),
    );
    const next = evictThreadCache(cache, ["dsh:9", "dsh:0"], 3);
    assert.equal(Object.keys(next).length, 3);
    assert.ok(next["dsh:9"]);
    assert.ok(next["dsh:0"]);
  });

  it("merges a created draft until the store lists that thread", () => {
    const older = thread({
      id: "dsh:old",
      occurred_at: "2026-08-21T00:00:00.000Z",
    });
    const merged = mergeDraftThreads([older], [
      {
        thread_id: "dsh:new",
        channel: "dsh",
        channel_label: "DSH",
        can_send: true,
        opened_at: "2026-08-23T12:00:00.000Z",
      },
    ]);
    assert.equal(merged[0].id, "dsh:new");
    assert.equal(merged[0].opened_at, "2026-08-23T12:00:00.000Z");
    assert.equal(
      mergeDraftThreads(merged, [
        {
          thread_id: "dsh:new",
          channel: "dsh",
          channel_label: "DSH",
          can_send: true,
        },
      ]).length,
      2,
    );
  });

  it("stamps opened_at onto an existing thread without rewriting others", () => {
    const older = thread({ id: "dsh:old" });
    const created = thread({ id: "dsh:new" });
    const stamped = applyOpenedAt([older, created], {
      "dsh:new": "2026-08-23T12:00:00.000Z",
    });
    assert.equal(stamped[0], older);
    assert.equal(stamped[1].opened_at, "2026-08-23T12:00:00.000Z");
    assert.equal(applyOpenedAt(stamped, { "dsh:new": "2026-08-23T12:00:00.000Z" }), stamped);
  });

  it("lists one create target per installation that can open a thread", () => {
    assert.deepEqual(createConversationTargets(null), []);
    assert.deepEqual(
      createConversationTargets({
        kernel: "running",
        org_id: "local-owner",
        database_path: null,
        inbox_count: 0,
        installations: [
          install({
            id: "dsh-1",
            channel: "dsh",
            channel_label: "DSH",
            label: "web",
            can_create: true,
          }),
          install({
            id: "dsh-1",
            channel: "dsh",
            channel_label: "DSH",
            label: "dup",
            can_create: true,
          }),
          install({
            id: "feishu-1",
            connector_type: "feishu-chat",
            channel: "feishu",
            channel_label: "Feishu",
            label: "chats",
            can_create: false,
          }),
        ],
        catalog: [],
      }),
      [{ id: "dsh-1", channel: "dsh", channel_label: "DSH", label: "web", create_with_task: false }],
    );
    const draft = localDraftConversation({
      id: "dsh-1",
      channel: "dsh",
      channel_label: "DSH",
      label: "web",
      create_with_task: true,
    });
    assert.match(draft.thread_id, /^draft:dsh-1:/);
    assert.equal(draft.draft_installation_id, "dsh-1");
    assert.equal(draft.list_title, "prompt");
    const outbound = localDraftOutbound(
      { ...draft, thread_id: "dsh:sess-new" },
      "Fix the login bug",
    );
    assert.equal(outbound.body_text, "Fix the login bug");
    assert.equal(outbound.event.source, "dsh");
    assert.equal(outbound.kind, "user");
    assert.equal(outbound.direction, "outbound");
    const forwarded = draftFromForward({
      accepted: true,
      source_thread_id: "feishu:oc",
      target_thread_id: "dsh:created-1",
      created: true,
      item: {
        ...outbound,
        channel: "dsh",
        channel_label: "DSH",
        can_send: true,
        await_reply: true,
        list_title: "prompt",
      },
    });
    assert.equal(forwarded.thread_id, "dsh:created-1");
    assert.equal(forwarded.channel, "dsh");
    assert.equal(forwarded.can_send, true);
    assert.equal(forwarded.list_title, "prompt");
  });

  it("carries live prompts and unread from inbox heads", () => {
    const head = message("q1", "2026-08-24T10:00:00.000Z", "dsh:sess");
    head.prompts = [
      {
        prompt_id: "q:rpc",
        presentation: "choice",
        questions: [{ id: "go", prompt: "Continue?" }],
      },
    ];
    head.unread = true;
    head.unread_count = 1;
    const [row] = groupInboxThreads([head]);
    assert.equal(row.unread, true);
    assert.equal(row.prompts[0]?.prompt_id, "q:rpc");
    const opened = openedThreadView(row, [head], false);
    assert.equal(opened.prompts[0]?.prompt_id, "q:rpc");
    const overlaid = overlayThreadMessages([row], {
      "dsh:sess": [message("later", "2026-08-24T10:01:00.000Z", "dsh:sess")],
    });
    assert.equal(overlaid[0].prompts[0]?.prompt_id, "q:rpc");
  });

  it("acks from the just-loaded page, not a stale opened list", () => {
    const stale = message("old", "2026-08-24T10:00:00.000Z", "feishu:oc_1");
    stale.direction = "inbound";
    const incoming = message("new", "2026-08-24T12:00:00.000Z", "feishu:oc_1");
    incoming.direction = "inbound";
    const outbound = message("out", "2026-08-24T12:01:00.000Z", "feishu:oc_1");
    outbound.direction = "outbound";
    const items = messagesForAttentionAck([stale, incoming, outbound], [stale], []);
    assert.equal(latestInboundOf(items)?.event.id, "new");
  });

  it("clears unread on a thread without changing other rows", () => {
    const unread = message("in", "2026-08-24T10:00:00.000Z", "feishu:oc_1");
    unread.unread = true;
    unread.unread_count = 1;
    unread.thread_id = "feishu:oc_1";
    const other = message("other", "2026-08-24T09:00:00.000Z", "feishu:oc_2");
    other.unread = true;
    other.thread_id = "feishu:oc_2";
    const next = markInboxThreadRead([unread, other], "feishu:oc_1");
    assert.equal(next[0].unread, false);
    assert.equal(next[1].unread, true);
  });
});

describe("pref overlay", () => {
  it("applies a hide fold without waiting for the next poll", () => {
    const row = thread({ id: "crm:order-1" });
    const next = applyPrefOverlay([row], {
      "crm:order-1": {
        title: null,
        pinned: false,
        hidden: true,
        updated_at: "2026-08-29T04:00:00.000Z",
      },
    });
    assert.equal(next[0].hidden, true);
    assert.equal(next[0].pref_updated_at, "2026-08-29T04:00:00.000Z");
  });
});

describe("inbox reuse", () => {
  it("does not reuse a row when only the channel label changed", () => {
    const english = feishuHead(
      "m1",
      "2026-08-24T10:00:00.000Z",
      "feishu:oc_1",
      "熊峰",
    );
    const chinese = { ...english, channel_label: "飞书" };
    const reused = reuseInboxList([english], [chinese]);
    assert.equal(reused.same, false);
    assert.equal(reused.items[0].channel_label, "飞书");
  });
});

describe("prompt answers", () => {
  it("keeps single-select custom exclusive of a picked option", async () => {
    const { togglePromptOption, typePromptCustom } = await import(
      "../src/renderer/src/thread-prompts.ts"
    );
    const question = {
      id: "mode",
      prompt: "Which?",
      options: [{ label: "A" }],
    };
    const picked = togglePromptOption({}, question, "A");
    assert.deepEqual(picked.mode.selected, ["A"]);
    const typed = typePromptCustom(picked, question, "Other");
    assert.deepEqual(typed.mode.selected, []);
    assert.equal(typed.mode.custom, "Other");
    const multi = {
      id: "mode",
      prompt: "Which?",
      multi_select: true,
    };
    const both = typePromptCustom(
      togglePromptOption({}, multi, "A"),
      multi,
      "Also",
    );
    assert.deepEqual(both.mode.selected, ["A"]);
    assert.equal(both.mode.custom, "Also");
  });

  it("prefers human description over machine option keys", async () => {
    const {
      optionPrimaryLabel,
      optionSecondaryLabel,
      shouldShowQuestionLegend,
      decisionDisplayLabel,
      promptTitleDisplay,
      humanizePromptProse,
      foldPromptDetail,
    } = await import("../src/renderer/src/thread-prompts.ts");
    assert.equal(
      optionPrimaryLabel({
        label: "SEND_AND_CLOSE",
        description: "用 CRM scene 模板回邮后关单",
      }),
      "用 CRM scene 模板回邮后关单",
    );
    assert.equal(
      optionSecondaryLabel({
        label: "SEND_AND_CLOSE",
        description: "用 CRM scene 模板回邮后关单",
      }),
      "SEND_AND_CLOSE",
    );
    assert.equal(
      optionPrimaryLabel({
        label: "leave_pending",
        description: "不发信、不关单",
      }),
      "不发信、不关单",
    );
    assert.equal(optionPrimaryLabel({ label: "Allow" }), "Allow");
    const t = (key: "prompt.approve" | "prompt.reject" | "prompt.confirmResult") =>
      ({
        "prompt.approve": "通过",
        "prompt.reject": "驳回",
        "prompt.confirmResult": "确认结果",
      })[key];
    assert.equal(decisionDisplayLabel("APPROVED", t), "通过");
    assert.equal(decisionDisplayLabel("REJECTED", t), "驳回");
    assert.equal(decisionDisplayLabel("Allow", t), "通过");
    assert.equal(promptTitleDisplay("写回", t), "确认结果");
    assert.equal(foldPromptDetail("approval"), true);
    assert.equal(foldPromptDetail("choice"), false);
    assert.equal(foldPromptDetail("plan_review"), false);
    assert.equal(
      humanizePromptProse(
        "只改本订单内审（APPROVED / REJECTED）。不得 complete 关联运营任务。",
        "zh",
      ),
      "只改本订单内审（通过 / 驳回）。不要结束关联运营任务。",
    );
    assert.equal(
      humanizePromptProse("Do not complete related work.", "en"),
      "Do not complete related work.",
    );
    assert.equal(
      shouldShowQuestionLegend(
        {
          prompt_id: "p1",
          presentation: "choice",
          title: "邮件提报待审",
          questions: [{ id: "q1", prompt: "根据工单正文判断…" }],
        },
        { id: "q1", prompt: "根据工单正文判断…" },
      ),
      true,
    );
    assert.equal(
      shouldShowQuestionLegend(
        {
          prompt_id: "p1",
          presentation: "choice",
          title: "邮件提报待审",
          questions: [{ id: "q1", prompt: "邮件提报待审" }],
        },
        { id: "q1", prompt: "邮件提报待审" },
      ),
      false,
    );
  });
});
