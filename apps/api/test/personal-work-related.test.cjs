const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalWorkRelated } = require("../dist/personal-work-related");

function related(searchExpanded, labels = {}) {
  const lookup = new PersonalWorkRelated({}, {});
  lookup.context = { searchExpanded };
  lookup.labels = {
    describe: async () => ({
      threads: new Map(Object.entries(labels.threads ?? {})),
      actors: new Map(Object.entries(labels.actors ?? {})),
    }),
  };
  return lookup;
}

function message(eventId, threadId, text, extra = {}) {
  return {
    event_id: eventId,
    thread_id: threadId,
    text,
    occurred_at: "2026-10-30T09:00:00.000Z",
    ...extra,
  };
}

describe("work related lookup", () => {
  it("searches messages and formats other conversations", async () => {
    const requests = [];
    const lookup = related(async (input) => {
      requests.push(input);
      return {
        conversations: [
          {
            thread_id: "slack:C1",
            messages: [
              message("e2", "slack:C1", "refund for order 42 approved", { actor_id: "U1" }),
              message("e3", "slack:C1", "thanks", { reply_to_event_id: "e2" }),
            ],
          },
        ],
      };
    }, {
      threads: { "slack:C1": { title: "#billing", channel_label: "Slack" } },
      actors: { e2: "Ann", e3: "Bo" },
    });
    const text = await lookup.lookup({ thread_id: "feishu:oc_1", current: "  where is\n my refund  " });
    assert.deepEqual(requests.map((r) => r.query), ["where is my refund"]);
    assert.equal(requests[0].kind, "messages");
    assert.match(text, /^## Slack · #billing\n/);
    assert.match(text, /Ann.*refund for order 42 approved/);
    assert.match(text, /Bo.*reply to Ann.*thanks/);
  });

  it("drops covered messages but keeps older parts of the same thread", async () => {
    const lookup = related(async () => ({
      conversations: [
        {
          thread_id: "feishu:oc_1",
          messages: [
            message("old", "feishu:oc_1", "order 20261030123 shipped via SF", {
              occurred_at: "2026-10-01T09:00:00.000Z",
            }),
            message("now", "feishu:oc_1", "still not here?"),
          ],
        },
        { thread_id: "feishu:oc_1b", messages: [message("seen", "feishu:oc_1b", "seen")] },
      ],
    }), { threads: { "feishu:oc_1": { title: "Ann", channel_label: "Feishu" } } });
    const text = await lookup.lookup({
      thread_id: "feishu:oc_1",
      current: "still not here?",
      covered_event_ids: ["now", "seen"],
    });
    assert.match(text, /^## Feishu · Ann \(earlier in this conversation\)\n/);
    assert.match(text, /shipped via SF/);
    assert.equal(text.includes("still not here?"), false);
    assert.equal(text.includes("seen"), false);
  });

  it("enriches short follow-ups, searches identifiers and fuses by rank", async () => {
    const queries = [];
    const lookup = related(async ({ query }) => {
      queries.push(query);
      if (query === "20261030123") {
        return {
          conversations: [
            { thread_id: "mail:t9", messages: [message("m1", "mail:t9", "SF waybill for 20261030123")] },
            { thread_id: "slack:C1", messages: [message("s2", "slack:C1", "warehouse delay", {
              occurred_at: "2026-10-30T10:00:00.000Z",
            })] },
          ],
        };
      }
      if (query.includes("20261030123")) {
        return {
          conversations: [
            { thread_id: "mail:t9", messages: [message("m1", "mail:t9", "SF waybill for 20261030123")] },
          ],
        };
      }
      return {
        conversations: [
          { thread_id: "slack:C1", messages: [message("s1", "slack:C1", "is anything late?")] },
        ],
      };
    }, {
      threads: {
        "mail:t9": { title: "Waybill", channel_label: "Mail" },
        "slack:C1": { title: "#ops", channel_label: "Slack" },
      },
    });
    const text = await lookup.lookup({
      thread_id: "feishu:oc_1",
      current: "还没到？",
      recent: ["我的订单 20261030123 发货了吗"],
    });
    assert.deepEqual(queries.sort(), [
      "20261030123",
      "我的订单 20261030123 发货了吗 还没到？",
      "还没到？",
    ].sort());
    assert.ok(text.indexOf("## Mail · Waybill") < text.indexOf("## Slack · #ops"));
    assert.equal(text.match(/SF waybill/g).length, 1);
    assert.ok(text.indexOf("is anything late?") < text.indexOf("warehouse delay"));
  });

  it("returns nothing for blank queries, empty hits and failures", async () => {
    let calls = 0;
    const counted = related(async () => { calls += 1; return { conversations: [] }; });
    assert.equal(await counted.lookup({ thread_id: "t", current: " " }), undefined);
    assert.equal(calls, 0);
    assert.equal(await counted.lookup({ thread_id: "t", current: "refund" }), undefined);
    assert.equal(calls, 1);
    const onlyCovered = related(async () => ({
      conversations: [{ thread_id: "t", messages: [message("e1", "t", "x")] }],
    }));
    assert.equal(
      await onlyCovered.lookup({ thread_id: "t", current: "refund", covered_event_ids: ["e1"] }),
      undefined,
    );
    const failing = related(async () => { throw new Error("index offline"); });
    assert.equal(await failing.lookup({ thread_id: "t", current: "refund" }), undefined);
    let partial = 0;
    const halfFailing = related(async ({ query }) => {
      partial += 1;
      if (query === "A-12345") throw new Error("boom");
      return { conversations: [{ thread_id: "x", messages: [message("x1", "x", "hit")] }] };
    });
    assert.match(await halfFailing.lookup({ thread_id: "t", current: "ticket A-12345" }), /hit/);
    assert.equal(partial, 2);
  });
});
