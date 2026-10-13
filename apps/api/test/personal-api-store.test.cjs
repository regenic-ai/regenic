const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  createRoot,
  ingestActionable,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("clears local store data and keeps connectors and recipes", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await (
        await fetch(`${origin}/v1/me/recipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Keep me",
            match: { record_class: "task" },
            executor_type: "dsh",
            can_write_back: false,
            enabled: true,
          }),
        })
      ).json();
      assert.equal(created.name, "Keep me");
      assert.equal(created.include_context, false);

      const before = await (await fetch(`${origin}/v1/me/store`)).json();
      assert.ok(before.events >= 1);
      assert.ok(before.connectors >= 1);
      assert.ok(before.executors >= 1);
      assert.equal(before.recipes, 1);

      const clearResponse = await fetch(`${origin}/v1/me/store/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const cleared = await clearResponse.json();
      assert.equal(
        clearResponse.status,
        201,
        JSON.stringify(cleared),
      );
      assert.ok(cleared.cleared.events >= 1);
      assert.equal(cleared.kept.recipes, 1);
      assert.ok(cleared.kept.connectors >= 1);
      assert.ok(cleared.kept.executors >= 1);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const after = await (await fetch(`${origin}/v1/me/store`)).json();
      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      const recipes = await (await fetch(`${origin}/v1/me/recipes`)).json();
      assert.equal(inbox.length, 0);
      assert.equal(after.events, 0);
      assert.equal(after.conversations, 0);
      assert.equal(after.work_items, 0);
      assert.equal(after.recipes, 1);
      assert.ok(after.connectors >= 1);
      assert.equal(engine.inbox_count, 0);
      assert.equal(engine.installations[0].id, "slack-1");
      assert.equal(recipes[0].name, "Keep me");
    } finally {
      await app.close();
    }
  });
});
