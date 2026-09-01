const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { shouldHydrateOpenedInbox } = require("../dist/personal-inbox-query");

describe("personal inbox HTTP query", () => {
  it("hydrates a cold open only", () => {
    assert.equal(
      shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1" }),
      true,
    );
    assert.equal(
      shouldHydrateOpenedInbox({
        thread_id: "feishu:oc_1",
        since: "2026-01-01T00:00:00.000Z",
      }),
      false,
    );
    assert.equal(
      shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1", live: true }),
      false,
    );
  });
});
