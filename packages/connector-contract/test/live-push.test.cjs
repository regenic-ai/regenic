const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  nudgeConnectorLivePush,
  startConnectorLivePush,
  stopAllConnectorLivePushes,
} = require("../dist/live-push");

describe("connector live push", () => {
  it("pushes a latest page and does not poll again until the next pass", async () => {
    const previous = process.env.REGENIC_CONNECTOR_PULL_MS;
    process.env.REGENIC_CONNECTOR_PULL_MS = "1000";
    const pushed = [];
    let polls = 0;
    const stream = {
      stream_key: "chat:1",
      connector: {
        source: "fake",
        async poll(_cursor, options) {
          assert.equal(options.latest, true);
          assert.equal(options.media, false);
          polls += 1;
          return {
            batch: {
              records: [{
                operation: "create",
                source: "fake",
                external_id: "m-1",
                occurred_at: "2026-11-16T00:00:00.000Z",
                actor: { id: "user" },
                scope: { id: "personal" },
                type: "message",
                content: [{ role: "body", media_type: "text/plain", text: "hi" }],
              }],
            },
            next_cursor: "cursor-1",
            media_pending: false,
          };
        },
      },
    };
    try {
      startConnectorLivePush({
        installationId: "install-live",
        intervalMs: 60_000,
        listStreams: () => [stream],
        push: async (batch) => {
          pushed.push(batch);
        },
      });
      const deadline = Date.now() + 1_000;
      while (pushed.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(polls, 1);
      assert.equal(pushed.length, 1);
      assert.equal(pushed[0].stream_key, "chat:1");
      assert.equal(pushed[0].watermark, "cursor-1");
      assert.equal(pushed[0].media_pending, false);
      assert.equal(pushed[0].events[0].external_id, "m-1");
    } finally {
      stopAllConnectorLivePushes();
      if (previous === undefined) {
        delete process.env.REGENIC_CONNECTOR_PULL_MS;
      } else {
        process.env.REGENIC_CONNECTOR_PULL_MS = previous;
      }
    }
  });

  it("resumes from the acked watermark and nudges one stream without a tail timer", async () => {
    const seen = [];
    const stream = {
      stream_key: "chat:9",
      connector: {
        source: "fake",
        async poll(cursor, options) {
          seen.push({ cursor: cursor?.value, latest: options.latest });
          return {
            batch: { records: [] },
            next_cursor: "cursor-2",
          };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-nudge",
      intervalMs: 0,
      listStreams: () => [stream],
      push: async () => undefined,
      resumeCursor: async () => "cursor-1",
    });
    try {
      assert.equal(await nudgeConnectorLivePush("install-nudge", "chat:9"), true);
      assert.equal(await nudgeConnectorLivePush("install-nudge", "chat:9"), true);
      assert.equal(await nudgeConnectorLivePush("install-nudge", "missing"), false);
      assert.deepEqual(seen, [
        { cursor: "cursor-1", latest: true },
        { cursor: "cursor-2", latest: true },
      ]);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("retries the same cursor when the ack does not echo a watermark", async () => {
    const seen = [];
    const stream = {
      stream_key: "chat:9",
      connector: {
        source: "fake",
        async poll(cursor) {
          seen.push(cursor?.value);
          return {
            batch: {
              records: [{
                operation: "create",
                source: "fake",
                external_id: "m-1",
                occurred_at: "2026-11-16T00:00:00.000Z",
                actor: { id: "user" },
                scope: { id: "personal" },
                type: "message",
                content: [{ role: "body", media_type: "text/plain", text: "hi" }],
              }],
            },
            next_cursor: "cursor-2",
          };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-retry",
      intervalMs: 0,
      listStreams: () => [stream],
      push: async () => ({ watermark: undefined }),
    });
    try {
      assert.equal(await nudgeConnectorLivePush("install-retry", "chat:9"), true);
      assert.equal(await nudgeConnectorLivePush("install-retry", "chat:9"), true);
      assert.deepEqual(seen, [undefined, undefined]);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("advances after core echoes the watermark", async () => {
    const seen = [];
    const stream = {
      stream_key: "chat:9",
      connector: {
        source: "fake",
        async poll(cursor) {
          seen.push(cursor?.value);
          return {
            batch: {
              records: [{
                operation: "create",
                source: "fake",
                external_id: "m-1",
                occurred_at: "2026-11-16T00:00:00.000Z",
                actor: { id: "user" },
                scope: { id: "personal" },
                type: "message",
                content: [{ role: "body", media_type: "text/plain", text: "hi" }],
              }],
            },
            next_cursor: "cursor-2",
          };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-acked",
      intervalMs: 0,
      listStreams: () => [stream],
      push: async (batch) => ({ watermark: batch.watermark }),
    });
    try {
      assert.equal(await nudgeConnectorLivePush("install-acked", "chat:9"), true);
      assert.equal(await nudgeConnectorLivePush("install-acked", "chat:9"), true);
      assert.deepEqual(seen, [undefined, "cursor-2"]);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("releases a hung poll so the next nudge still runs", async () => {
    let calls = 0;
    const stream = {
      stream_key: "chat:9",
      connector: {
        source: "fake",
        poll() {
          calls += 1;
          if (calls === 1) {
            return new Promise(() => undefined);
          }
          return Promise.resolve({ batch: { records: [] }, next_cursor: "cursor-2" });
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-hung",
      intervalMs: 0,
      pollTimeoutMs: 20,
      listStreams: () => [stream],
      push: async () => undefined,
    });
    try {
      await assert.rejects(nudgeConnectorLivePush("install-hung", "chat:9"));
      assert.equal(await nudgeConnectorLivePush("install-hung", "chat:9"), true);
      assert.equal(calls, 2);
    } finally {
      stopAllConnectorLivePushes();
    }
  });
});
