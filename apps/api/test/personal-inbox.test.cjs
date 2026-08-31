const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { parseConversationThread } = require("@regenic/domain");
const {
  CHANGED_INBOX_EVENT_CAP,
  CHANGED_INBOX_THREAD_CAP,
  collectChangedInboxThreadIds,
  shouldFallbackChangedInboxHeads,
  inboxStoreQuery,
  headsNextBefore,
  parseSinceInboxDigest,
  shouldLoadChangedInboxHeads,
  shouldSplitInboxHeads,
  splitInboxHeadViews,
  splitChangedInboxHeads,
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

  it("drops page cursors when heads ask for specific threads", () => {
    assert.deepEqual(
      inboxStoreQuery(
        {
          heads: true,
          limit: 40,
          before: "2026-08-23T00:00:00.000Z",
          before_id: "e1",
          thread_ids: ["crm:order-2", "crm:order-pin"],
        },
        undefined,
      ),
      {
        heads: true,
        list: "shown",
        before: undefined,
        before_id: undefined,
        limit: undefined,
        thread_ids: ["crm:order-2", "crm:order-pin"],
      },
    );
  });
});

describe("changed inbox heads", () => {
  it("loads a patch only when split heads carry a previous digest", () => {
    assert.equal(
      shouldLoadChangedInboxHeads({
        heads: true,
        split: true,
        changed: true,
        since_digest: "1:2026-08-23T00:00:00.000Z:e1:0:",
      }),
      true,
    );
    assert.equal(
      shouldLoadChangedInboxHeads({ heads: true, split: true, changed: true }),
      false,
    );
    assert.equal(
      shouldLoadChangedInboxHeads({
        heads: true,
        split: true,
        changed: true,
        since_digest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        before: "2026-08-23T00:00:00.000Z",
      }),
      false,
    );
  });

  it("keeps ISO timestamps that contain colons", () => {
    assert.deepEqual(
      parseSinceInboxDigest("1:2026-08-23T00:00:01.000Z:e2:1:2026-08-23T00:01:00.000Z&s=dsh:2"),
      {
        latest_at: "2026-08-23T00:00:01.000Z",
        latest_id: "e2",
        pref_updated_at: "2026-08-23T00:01:00.000Z",
      },
    );
    assert.equal(parseSinceInboxDigest("0:::0:"), null);
  });

  it("collects threads from new ingest and later prefs", () => {
    const collected = collectChangedInboxThreadIds({
      events: [
        { source: "crm", external_id: "order-2:n2", id: "n2" },
      ],
      prefs: [
        { thread_id: "crm:order-pin", updated_at: "2026-08-23T00:01:00.000Z" },
        { thread_id: "crm:old", updated_at: "2026-08-22T00:00:00.000Z" },
      ],
      prefSince: "2026-08-23T00:00:30.000Z",
    });
    assert.deepEqual(collected.ids.sort(), ["crm:order-2", "crm:order-pin"]);
    assert.equal(collected.tooMany, false);
  });

  it("falls back when too many events or threads changed", () => {
    const events = Array.from({ length: CHANGED_INBOX_EVENT_CAP }, (_, i) => ({
      source: "crm",
      external_id: `order-${i}:n`,
      id: `n${i}`,
    }));
    assert.equal(
      collectChangedInboxThreadIds({
        events,
        prefs: [],
        prefSince: "2026-08-23T00:00:00.000Z",
      }).tooMany,
      true,
    );
    const prefs = Array.from({ length: CHANGED_INBOX_THREAD_CAP + 1 }, (_, i) => ({
      thread_id: `crm:order-${i}`,
      updated_at: "2026-08-23T00:02:00.000Z",
    }));
    assert.equal(
      collectChangedInboxThreadIds({
        events: [],
        prefs,
        prefSince: "2026-08-23T00:00:00.000Z",
      }).tooMany,
      true,
    );
    assert.equal(
      shouldFallbackChangedInboxHeads({ ids: [], tooMany: false }),
      false,
    );
    assert.equal(
      shouldFallbackChangedInboxHeads({ ids: [], tooMany: true }),
      true,
    );
    assert.equal(
      shouldFallbackChangedInboxHeads({ ids: ["crm:order-2"], tooMany: false }),
      false,
    );
  });

  it("keeps a missing projection off gone and splits active work extras", () => {
    const live = {
      thread_id: "crm:order-2",
      pinned: false,
      hidden: false,
    };
    const hidden = {
      thread_id: "crm:order-hid",
      pinned: false,
      hidden: true,
    };
    const work = {
      thread_id: "dsh:job",
      pinned: false,
      hidden: false,
    };
    const page = splitChangedInboxHeads({
      views: [live, hidden, work],
      collectedIds: ["crm:order-2", "crm:order-hid", "crm:miss"],
      prefs: [{ thread_id: "crm:order-hid", hidden: true }],
      workIds: ["dsh:job"],
      list: "shown",
    });
    assert.deepEqual(
      page.live.map((item) => item.thread_id),
      ["crm:order-2"],
    );
    assert.deepEqual(
      page.active_work.map((item) => item.thread_id),
      ["dsh:job"],
    );
    assert.deepEqual(page.gone.sort(), ["crm:order-hid"]);
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
