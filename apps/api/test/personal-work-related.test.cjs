const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PersonalWorkRelated,
  WORK_RELATED_QUERY_MAX,
  workRelatedQuery,
} = require("../dist/personal-work-related");

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
  it("searches messages and drops the work item's own thread", async () => {
    const requests = [];
    const lookup = related(async (input) => {
      requests.push(input);
      return {
        conversations: [
          { thread_id: "feishu:oc_1", messages: [message("e1", "feishu:oc_1", "own thread")] },
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
    const text = await lookup.lookup("feishu:oc_1", "  where is\n my refund  ");
    assert.equal(requests[0].query, "where is my refund");
    assert.equal(requests[0].kind, "messages");
    assert.equal(text.includes("own thread"), false);
    assert.match(text, /^## Slack · #billing\n/);
    assert.match(text, /Ann.*refund for order 42 approved/);
    assert.match(text, /Bo.*reply to Ann.*thanks/);
  });

  it("returns nothing for blank queries, empty hits and failures", async () => {
    let calls = 0;
    const counted = related(async () => { calls += 1; return { conversations: [] }; });
    assert.equal(await counted.lookup("t", " "), undefined);
    assert.equal(calls, 0);
    assert.equal(await counted.lookup("t", "refund"), undefined);
    assert.equal(calls, 1);
    const onlyOwn = related(async () => ({
      conversations: [{ thread_id: "t", messages: [message("e1", "t", "x")] }],
    }));
    assert.equal(await onlyOwn.lookup("t", "refund"), undefined);
    const failing = related(async () => { throw new Error("index offline"); });
    assert.equal(await failing.lookup("t", "refund"), undefined);
  });

  it("bounds the query", () => {
    assert.equal(workRelatedQuery("x".repeat(WORK_RELATED_QUERY_MAX + 50)).length, WORK_RELATED_QUERY_MAX);
    assert.equal(workRelatedQuery("a"), undefined);
    assert.equal(workRelatedQuery(undefined), undefined);
  });
});
