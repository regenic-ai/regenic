const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { parseConversationThread } = require("@regenic/domain");
const {
  inboxStoreQuery,
  headsNextBefore,
  shouldSplitInboxHeads,
  splitInboxHeadViews,
} = require("../dist/personal-inbox.service");

describe("inboxStoreQuery", () => {
  it("opens a conversation by stored thread_id instead of an external_id prefix", () => {
    const thread = parseConversationThread("feishu:oc_yiki");
    assert.deepEqual(
      inboxStoreQuery({ thread_id: "feishu:oc_yiki", limit: 50 }, thread),
      {
        thread_ids: ["feishu:oc_yiki"],
        since: undefined,
        since_id: undefined,
        before: undefined,
        before_id: undefined,
        limit: 50,
        siblings: true,
      },
    );
  });

  it("keeps heads on the stored thread_id", () => {
    const thread = parseConversationThread("feishu:oc_yiki");
    assert.deepEqual(inboxStoreQuery({ heads: true, thread_id: "feishu:oc_yiki" }, thread), {
      heads: true,
      list: "shown",
      before: undefined,
      before_id: undefined,
      limit: undefined,
      thread_ids: ["feishu:oc_yiki"],
    });
    assert.deepEqual(
      inboxStoreQuery(
        { heads: true, list: "hidden", thread_id: "feishu:oc_yiki" },
        thread,
      ),
      {
        heads: true,
        list: "hidden",
        before: undefined,
        before_id: undefined,
        limit: undefined,
        thread_ids: ["feishu:oc_yiki"],
      },
    );
    assert.deepEqual(
      inboxStoreQuery(
        {
          heads: true,
          list: "hidden",
          limit: 40,
          before: "2026-08-23T00:00:00.000Z",
          before_id: "e1",
        },
        undefined,
      ),
      {
        heads: true,
        list: "hidden",
        before: "2026-08-23T00:00:00.000Z",
        before_id: "e1",
        limit: 40,
      },
    );
  });
});

describe("split inbox heads", () => {
  it("only splits heads without a thread_id", () => {
    assert.equal(shouldSplitInboxHeads({ heads: true, split: true }), true);
    assert.equal(shouldSplitInboxHeads({ heads: true }), false);
    assert.equal(
      shouldSplitInboxHeads({ heads: true, split: true, thread_id: "dsh:s" }),
      false,
    );
  });

  it("keeps extras off the live cursor", () => {
    const live = {
      thread_id: "crm:a",
      event: { id: "n2", occurred_at: "2026-08-23T00:02:00.000Z" },
    };
    const pinned = {
      thread_id: "crm:pin",
      event: { id: "pin", occurred_at: "2026-08-20T00:00:00.000Z" },
    };
    const work = {
      thread_id: "dsh:job",
      event: { id: "job", occurred_at: "2026-08-19T00:00:00.000Z" },
    };
    const page = splitInboxHeadViews([pinned, live, work], {
      liveIds: ["crm:a"],
      pinnedIds: ["crm:pin"],
      workIds: ["dsh:job"],
      liveCount: 1,
      limit: 1,
    });
    assert.deepEqual(
      page.live.map((item) => item.thread_id),
      ["crm:a"],
    );
    assert.deepEqual(
      page.pinned.map((item) => item.thread_id),
      ["crm:pin"],
    );
    assert.deepEqual(
      page.active_work.map((item) => item.thread_id),
      ["dsh:job"],
    );
    assert.equal(page.has_older, true);
    assert.deepEqual(page.next_before, {
      before: "2026-08-23T00:02:00.000Z",
      before_id: "n2",
    });
    assert.deepEqual(headsNextBefore([live]), page.next_before);
    assert.equal(headsNextBefore([work, live])?.before_id, "job");
  });
});
