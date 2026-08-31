import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboxThread } from "../src/renderer/src/inbox.ts";
import {
  readingMessages,
  receiptCopy,
  heldWhileWorkingCount,
  threadActivityCopy,
  threadActivityNote,
  threadActivityOf,
  threadLoadedCountCopy,
  threadPaneEmptyCopy,
  conversationKindLabel,
  unitKindChip,
  listPreview,
  threadFaceTags,
  threadFacetLabel,
  threadPreview,
  threadTitle,
  parseRichBlocks,
  heldFollowUpCount,
  workNextStepCopy,
  workStatusLabel,
} from "../src/renderer/src/message-view.ts";
import type { InboxViewItem, ThreadActivity } from "../src/renderer/src/types.ts";

function item(input: {
  id: string;
  external_id: string;
  text: string;
  kind?: InboxViewItem["kind"];
  direction?: InboxViewItem["direction"];
  activity?: ThreadActivity;
  occurred_at?: string;
  reason_codes?: string[];
}): InboxViewItem {
  return {
    decision: {
      event_id: input.id,
      org_id: "org",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: input.reason_codes ?? [],
      score: 1,
      decided_at: "2026-08-23T12:00:00.000Z",
    },
    event: {
      id: input.id,
      org_id: "org",
      source: "dsh",
      external_id: input.external_id,
      operation: "create",
      occurred_at: input.occurred_at ?? "2026-08-23T12:00:00.000Z",
      ingested_at: input.occurred_at ?? "2026-08-23T12:00:00.000Z",
    },
    body_text: input.text,
    channel: "dsh",
    channel_label: "DSH",
    kind: input.kind ?? "user",
    direction: input.direction ?? "outbound",
    can_send: true,
    thread_id: "dsh:session-1",
    activity: input.activity,
  };
}

function thread(
  messages: InboxViewItem[],
  extras: Partial<InboxThread> = {},
): InboxThread {
  return {
    id: "dsh:session-1",
    source: "dsh",
    channel: "dsh",
    channel_label: "DSH",
    label: "session",
    title: null,
    conversation_label: null,
    conversation_kind: null,
    unit_kind: null,
    unit_kind_label: null,
    pinned: false,
    can_send: true,
    await_reply: true,
    messages,
    prompts: [],
    unread: false,
    unread_count: 0,
    ...extras,
  };
}

describe("receipt copy", () => {
  it("shows Sent/Read only on outbound when the channel can receipt", () => {
    assert.equal(
      receiptCopy(item({ id: "in-1", external_id: "om_1", text: "hi", direction: "inbound" })),
      undefined,
    );
    assert.equal(
      receiptCopy(item({ id: "out-1", external_id: "oc:out:om_1", text: "hi" })),
      undefined,
    );
    assert.equal(
      receiptCopy({
        ...item({ id: "out-2", external_id: "oc:out:om_2", text: "hi" }),
        can_receipt: true,
      }),
      "Sent",
    );
    assert.equal(
      receiptCopy({
        ...item({ id: "out-3", external_id: "oc:out:om_3", text: "hi" }),
        can_receipt: true,
        receipt: { state: "read", read_count: 1 },
      }),
      "Read",
    );
  });
});

describe("reading messages", () => {
  it("hides a pulled user echo of the same outbound text", () => {
    const outbound = item({
      id: "out-1",
      external_id: "session-1:out:rpc",
      text: "背景: Ahacreator的介绍",
    });
    const echo = item({
      id: "hist-2",
      external_id: "session-1:2",
      text: "背景: Ahacreator的介绍",
    });
    const reading = readingMessages(thread([outbound, echo]));
    assert.equal(reading.length, 1);
    assert.equal(reading[0].event.id, "out-1");
  });

  it("keeps two different user messages from the same speaker", () => {
    const first = item({
      id: "out-1",
      external_id: "session-1:out:a",
      text: "ping",
    });
    const second = item({
      id: "out-2",
      external_id: "session-1:out:b",
      text: "pong",
    });
    const reading = readingMessages(thread([first, second]));
    assert.equal(reading.length, 2);
  });

  it("hides working markers from the reading list", () => {
    const outbound = item({
      id: "out-1",
      external_id: "session-1:out:rpc",
      text: "Continue",
    });
    const working = item({
      id: "work-1",
      external_id: "session-1:9",
      text: "Still working.",
      kind: "system",
      direction: "inbound",
      activity: "working",
    });
    const reading = readingMessages(thread([outbound, working]));
    assert.deepEqual(reading.map((entry) => entry.event.id), ["out-1"]);
  });

  it("does not treat a heads-only row with no body as readable", () => {
    const head = item({
      id: "head-1",
      external_id: "oc_1:om_1",
      text: "",
    });
    head.body_text = undefined;
    assert.deepEqual(readingMessages(thread([head])), []);
  });
});

describe("thread pane empty copy", () => {
  it("says opening while the kernel is still reading the thread", () => {
    assert.equal(threadPaneEmptyCopy(true), "Opening conversation…");
    assert.equal(
      threadPaneEmptyCopy(false),
      "This conversation has no displayable messages.",
    );
    assert.equal(
      threadPaneEmptyCopy(false, "Could not open this conversation."),
      "Could not open this conversation.",
    );
  });

  it("names a recent window instead of the whole history", () => {
    assert.equal(
      threadLoadedCountCopy({ opening: true, loaded: 0, hasOlder: false }),
      "Opening…",
    );
    assert.equal(
      threadLoadedCountCopy({ opening: true, loaded: 1, hasOlder: false }),
      "1 messages",
    );
    assert.equal(
      threadLoadedCountCopy({ opening: false, loaded: 50, hasOlder: true }),
      "50 recent messages",
    );
    assert.equal(
      threadLoadedCountCopy({ opening: false, loaded: 3, hasOlder: false }),
      "3 messages",
    );
  });
});

describe("thread activity", () => {
  it("reads connector activity without using the channel name", () => {
    const waiting = thread([
      item({
        id: "ask-1",
        external_id: "session-1:12",
        text: "Which channel?",
        kind: "assistant",
        direction: "inbound",
        activity: "awaiting_user",
      }),
    ]);
    assert.equal(threadActivityOf(waiting), "awaiting_user");
    assert.match(threadActivityCopy(threadActivityOf(waiting)) ?? "", /original channel/);
    const now = Date.parse("2026-08-23T12:05:00.000Z");
    const working = thread([
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
      }),
    ]);
    assert.equal(threadActivityOf(working, now), "working");
    assert.match(threadActivityCopy(threadActivityOf(working, now)) ?? "", /still working/i);
  });

  it("does not keep working after a visible assistant reply", () => {
    const now = Date.parse("2026-08-23T12:05:00.000Z");
    const replied = thread([
      item({
        id: "out-1",
        external_id: "session-1:7",
        text: "只用一句话回复：pong",
      }),
      item({
        id: "in-1",
        external_id: "session-1:140",
        text: "我是 deepseek-v4-flash 模型，运行在 DeepSeek Harness 环境中为你服务。",
        kind: "assistant",
        direction: "inbound",
      }),
      item({
        id: "work-1",
        external_id: "session-1:300",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(replied, now), undefined);
    assert.equal(threadPreview(replied), "只用一句话回复：pong");
  });

  it("does not keep a stale working marker as current activity", () => {
    const now = Date.parse("2026-08-23T13:00:00.000Z");
    const stale = thread([
      item({
        id: "out-1",
        external_id: "session-1:8",
        text: "只用一句话回复: pong",
      }),
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
        occurred_at: "2026-08-22T10:44:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(stale, now), undefined);
    assert.equal(threadTitle(stale), "只用一句话回复: pong");
    assert.equal(threadPreview(stale), "只用一句话回复: pong");
  });

  it("keeps a working marker for hours, then drops it after a day", () => {
    const working = thread(
      [
        item({
          id: "out-1",
          external_id: "session-1:1",
          text: "run for hours",
        }),
        item({
          id: "work-1",
          external_id: "session-1:2",
          text: "Still working.",
          kind: "system",
          direction: "inbound",
          activity: "working",
          occurred_at: "2026-08-23T12:00:00.000Z",
        }),
      ],
      { hold_while_working: true },
    );
    const threeHours = Date.parse("2026-08-23T15:00:00.000Z");
    const twentySixHours = Date.parse("2026-08-24T14:00:00.000Z");
    assert.equal(threadActivityOf(working, threeHours), "working");
    assert.match(threadActivityNote(working, threeHours) ?? "", /still working/i);
    assert.equal(threadActivityOf(working, twentySixHours), undefined);
  });

  it("keeps working after outbound follow-ups and counts how many are held", () => {
    const now = Date.parse("2026-08-23T15:00:00.000Z");
    const follow = thread(
      [
        item({
          id: "out-1",
          external_id: "session-1:1",
          text: "start the long job",
          occurred_at: "2026-08-23T12:00:00.000Z",
        }),
        item({
          id: "work-1",
          external_id: "session-1:2",
          text: "Still working.",
          kind: "system",
          direction: "inbound",
          activity: "working",
          occurred_at: "2026-08-23T12:00:01.000Z",
        }),
        item({
          id: "out-2",
          external_id: "session-1:3",
          text: "also check the tests",
          occurred_at: "2026-08-23T12:05:00.000Z",
        }),
        item({
          id: "out-3",
          external_id: "session-1:4",
          text: "and the docs",
          occurred_at: "2026-08-23T12:06:00.000Z",
        }),
      ],
      { hold_while_working: true },
    );
    assert.equal(threadActivityOf(follow, now), "working");
    assert.equal(heldWhileWorkingCount(follow, now), 2);
    assert.match(threadActivityNote(follow, now) ?? "", /2 newer messages/);
  });

  it("treats a follow-up as sent when the connector does not hold while working", () => {
    const now = Date.parse("2026-08-23T12:10:00.000Z");
    const follow = thread([
      item({
        id: "out-1",
        external_id: "session-1:1",
        text: "start the long job",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
      item({
        id: "work-1",
        external_id: "session-1:2",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
        occurred_at: "2026-08-23T12:00:01.000Z",
      }),
      item({
        id: "out-2",
        external_id: "session-1:3",
        text: "also check the tests",
        occurred_at: "2026-08-23T12:05:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(follow, now), "sent");
    assert.equal(heldWhileWorkingCount(follow, now), 0);
  });

  it("drops a working marker after 30 minutes when the connector does not hold", () => {
    const now = Date.parse("2026-08-23T12:35:00.000Z");
    const stale = thread([
      item({
        id: "out-1",
        external_id: "session-1:1",
        text: "run",
      }),
      item({
        id: "work-1",
        external_id: "session-1:2",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(stale, now), undefined);
  });

  it("clears working when the latest thread_status has ended", () => {
    const now = Date.parse("2026-08-23T15:00:00.000Z");
    const ended = thread([
      item({
        id: "out-1",
        external_id: "session-1:1",
        text: "start the long job",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
      item({
        id: "work-1",
        external_id: "session-1:2",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
        occurred_at: "2026-08-23T12:00:01.000Z",
      }),
      item({
        id: "end-1",
        external_id: "session-1:ended",
        text: "",
        kind: "system",
        direction: "inbound",
        reason_codes: ["thread_status"],
        occurred_at: "2026-08-23T14:00:00.000Z",
      }),
      item({
        id: "out-2",
        external_id: "session-1:3",
        text: "next please",
        occurred_at: "2026-08-23T14:50:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(ended, now), "sent");
    assert.equal(heldWhileWorkingCount(ended, now), 0);
  });

  it("does not title a heads-only working row as Still working", () => {
    const only = thread([
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
      }),
    ]);
    assert.equal(threadTitle(only), "session");
    assert.equal(threadPreview(only), "session");
  });

  it("treats a recent outbound as waiting only when the connector awaits a reply", () => {
    const now = Date.parse("2026-08-23T12:05:00.000Z");
    const outbound = item({
      id: "out-1",
      external_id: "session-1:out:rpc",
      text: "Continue",
      occurred_at: "2026-08-23T12:00:00.000Z",
    });
    const sent = thread([outbound]);
    assert.equal(threadActivityOf(sent, now), "sent");
    assert.match(threadActivityCopy(threadActivityOf(sent, now)) ?? "", /Waiting for a reply/);
    const chat = thread([outbound], {
      id: "feishu:oc_1",
      source: "feishu",
      channel: "feishu",
      channel_label: "Feishu",
      await_reply: false,
    });
    assert.equal(threadActivityOf(chat, now), undefined);
  });

  it("does not keep a stale outbound in the waiting state", () => {
    const now = Date.parse("2026-08-23T13:00:00.000Z");
    const stale = thread([
      item({
        id: "out-1",
        external_id: "session-1:out:rpc",
        text: "thanks",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(stale, now), undefined);
  });

  it("titles a conversation-mode thread from the connector label, not the first message", () => {
    const chat = thread(
      [
        item({
          id: "m1",
          external_id: "oc_1:om_1",
          text: "写邮件的功能里加个颜色呗",
        }),
      ],
      {
        id: "feishu:oc_1",
        source: "feishu",
        channel: "feishu",
        channel_label: "Feishu",
        label: "oc_1",
        conversation_label: "Ada",
        list_title: "conversation",
        await_reply: false,
      },
    );
    assert.equal(threadTitle(chat), "Ada");
    assert.equal(threadPreview(chat), "写邮件的功能里加个颜色呗");
    assert.equal(listPreview(chat, "Ada"), "写邮件的功能里加个颜色呗");
    assert.equal(threadFacetLabel("chat"), null);
    assert.equal(threadFacetLabel("agent"), "Agent");
    assert.equal(conversationKindLabel("direct"), null);
    assert.equal(conversationKindLabel("group"), "Group");
    assert.equal(conversationKindLabel("order"), null);
    assert.equal(
      unitKindChip({
        unit_kind: "crm.order_review",
        unit_kind_label: "Order review",
      }),
      "Order review",
    );
    assert.equal(
      unitKindChip({ unit_kind: "crm.order_review", unit_kind_label: null }),
      "crm.order_review",
    );
    assert.equal(unitKindChip({ unit_kind: null, unit_kind_label: null }), null);
    assert.deepEqual(
      threadFaceTags({
        channel: "crm",
        channel_label: "CRM",
        conversation_kind: "order",
        thread_facet: "ticket",
        unit_kind: "crm.order_review",
        unit_kind_label: "订单 AI 内审",
        work: { status: "running" },
      }).map((tag) => tag.label),
      ["CRM", "订单 AI 内审", "Running"],
    );
    assert.deepEqual(
      threadFaceTags({
        channel: "feishu",
        channel_label: "飞书",
        conversation_kind: "group",
        thread_facet: "ticket",
        unit_kind: null,
        unit_kind_label: null,
        work: { status: "waiting_human" },
      }).map((tag) => tag.label),
      ["飞书", "Group", "Ticket", "Waiting"],
    );
    assert.equal(workStatusLabel("open"), null);
    assert.equal(workStatusLabel("waiting_human"), "Waiting");
    assert.equal(workStatusLabel("done"), "Done");
    assert.equal(
      workStatusLabel({
        status: "done",
        delivery: { status: "dead", write_back: "failed" },
      }),
      "Not sent",
    );
    assert.equal(
      workStatusLabel({
        status: "done",
        delivery: { status: "write_back", write_back: "failed" },
      }),
      "Not sent",
    );
    assert.equal(
      listPreview(
        thread(chat.messages, {
          work: { id: "work-1", status: "done", result_summary: "审核不通过：地区不符" },
        }),
        "Ada",
      ),
      "审核不通过：地区不符",
    );
    assert.match(workNextStepCopy({ record_class: "task" }) ?? "", /Set a rule/);
    assert.match(
      workNextStepCopy({ work: { status: "running" } }) ?? "",
      /chat reply is not the same as finishing/i,
    );
    assert.match(
      workNextStepCopy({ work: { status: "skipped" } }) ?? "",
      /Removed from current work/i,
    );
    assert.equal(workNextStepCopy({ record_class: "utterance" }), null);
    assert.match(
      workNextStepCopy({
        work: {
          status: "done",
          delivery: { status: "write_back", write_back: "failed" },
        },
      }) ?? "",
      /Send again/,
    );
    assert.match(
      workNextStepCopy({
        work: {
          status: "done",
          delivery: { status: "dead", write_back: "failed" },
        },
      }) ?? "",
      /three tries/,
    );
    assert.equal(
      heldFollowUpCount({
        work: { status: "running", head_event_id: "m1" },
        messages: [
          item({ id: "m1", external_id: "e1", text: "first" }),
          item({
            id: "m2",
            external_id: "e2",
            text: "follow-up",
            kind: "user",
            direction: "inbound",
          }),
        ],
      }),
      1,
    );
    assert.match(
      workNextStepCopy({
        work: { status: "running", head_event_id: "m1" },
        messages: [
          item({ id: "m1", external_id: "e1", text: "first" }),
          item({
            id: "m2",
            external_id: "e2",
            text: "follow-up",
            kind: "user",
            direction: "inbound",
          }),
        ],
      }) ?? "",
      /newer messages/,
    );
  });

  it("does not fall back to the first message when conversation title is missing", () => {
    const chat = thread(
      [
        item({
          id: "m1",
          external_id: "oc_1:om_1",
          text: "写邮件的功能里加个颜色呗",
        }),
      ],
      {
        id: "feishu:oc_1",
        source: "feishu",
        channel: "feishu",
        channel_label: "Feishu",
        label: "oc_1",
        conversation_label: null,
        list_title: "conversation",
        await_reply: false,
      },
    );
    assert.equal(threadTitle(chat), "oc_1");
  });

  it("titles a prompt-mode thread from the first user message, not the last reply", () => {
    const extras = {
      conversation_label: "只用一句话回复：pong",
      list_title: "prompt" as const,
    };
    const session = thread(
      [
        item({
          id: "out-1",
          external_id: "session-1:7",
          text: "只用一句话回复：pong",
        }),
        item({
          id: "in-1",
          external_id: "session-1:49",
          text: "pong",
          kind: "assistant",
          direction: "inbound",
        }),
      ],
      extras,
    );
    assert.equal(threadTitle(session), "只用一句话回复：pong");
    assert.equal(listPreview(session, "只用一句话回复：pong"), "pong");
    assert.equal(listPreview(thread([session.messages[0]], extras), "只用一句话回复：pong"), null);
    const answered = thread(
      [
        item({
          id: "out-2",
          external_id: "session-1:80",
          text: "2,228.00 美元是多少欧元",
        }),
        item({
          id: "in-2",
          external_id: "session-1:81",
          text: "2,228.00 美元大约是 2,050 欧元",
          kind: "assistant",
          direction: "inbound",
        }),
      ],
      extras,
    );
    assert.equal(
      listPreview(answered, "2,228.00 美元是多少欧元"),
      "2,228.00 美元大约是 2,050 欧元",
    );
    const headsOnly = thread(
      [
        item({
          id: "in-1",
          external_id: "session-1:49",
          text: "pong",
          kind: "assistant",
          direction: "inbound",
        }),
      ],
      {
        conversation_label: "只用一句话回复：pong",
        list_title: "prompt",
      },
    );
    assert.equal(threadTitle(headsOnly), "只用一句话回复：pong");
  });

  it("falls back to the visible face when a prompt title is missing", () => {
    const session = thread(
      [
        item({
          id: "in-1",
          external_id: "session-1:49",
          text: "这是对方给我的初稿：一、Bioby AI品牌端介绍",
          kind: "assistant",
          direction: "inbound",
        }),
      ],
      {
        conversation_label: null,
        list_title: "prompt",
        label: "session-…af07",
      },
    );
    assert.equal(threadTitle(session), "这是对方给我的初稿：一、Bioby AI品牌端介绍");
  });

  it("does not title the thread from a working marker", () => {
    const titled = thread([
      item({
        id: "out-1",
        external_id: "session-1:out:rpc",
        text: "Optimize the outline",
      }),
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
      }),
    ]);
    assert.equal(threadTitle(titled), "Optimize the outline");
  });

  it("titles an empty prompt-mode draft from its label", () => {
    const draft = thread([], {
      label: "New conversation",
      list_title: "prompt",
      conversation_label: null,
    });
    assert.equal(threadTitle(draft), "New conversation");
    assert.equal(threadPreview(draft), "New conversation");
    assert.equal(listPreview(draft, "New conversation"), null);
  });
});

describe("rich message body", () => {
  it("renders headings, tables, and lists from markdown line breaks", () => {
    const blocks = parseRichBlocks(
      [
        "对多数普通企业来说，今天不会立刻改日常经营。",
        "----",
        "## 先看结论",
        "| 法律 | 何时生效 | 一般企业 |",
        "| ---- | ---- | ---- |",
        "| 《国防动员法》修订 | 2026年10月1日 | 配合统计调查 |",
        "",
        "## 1. 所有企业都可能碰到",
        "- 职工医保参保仍是法定义务",
        "- **长护险**已按全国方案推进",
      ].join("\n"),
    );
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["paragraph", "heading", "table", "heading", "list"],
    );
    const heading = blocks[1];
    const table = blocks[2];
    const list = blocks[4];
    assert.equal(heading.type, "heading");
    assert.equal(heading.type === "heading" ? heading.text : "", "先看结论");
    assert.equal(table.type, "table");
    assert.deepEqual(table.type === "table" ? table.headers : [], [
      "法律",
      "何时生效",
      "一般企业",
    ]);
    assert.equal(table.type === "table" ? table.rows[0][1] : "", "2026年10月1日");
    assert.equal(list.type, "list");
    assert.equal(list.type === "list" ? list.items[0] : "", "职工医保参保仍是法定义务");
  });
});
