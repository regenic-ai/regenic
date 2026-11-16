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

  it("keeps the existing tail when start is called again", async () => {
    const seen = [];
    const first = {
      stream_key: "chat:first",
      connector: {
        source: "fake",
        async poll() {
          seen.push("first");
          return { batch: { records: [] } };
        },
      },
    };
    const replacement = {
      stream_key: "chat:replacement",
      connector: {
        source: "fake",
        async poll() {
          seen.push("replacement");
          return { batch: { records: [] } };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-idempotent",
      intervalMs: 0,
      listStreams: () => [first],
      push: async () => undefined,
    });
    startConnectorLivePush({
      installationId: "install-idempotent",
      intervalMs: 0,
      listStreams: () => [replacement],
      push: async () => undefined,
    });
    try {
      assert.equal(
        await nudgeConnectorLivePush("install-idempotent", "chat:first"),
        true,
      );
      assert.equal(
        await nudgeConnectorLivePush("install-idempotent", "chat:replacement"),
        false,
      );
      assert.deepEqual(seen, ["first"]);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("replaces a tail when its installation generation changes", async () => {
    const seen = [];
    const stream = (key) => ({
      stream_key: key,
      connector: {
        source: "fake",
        async poll() {
          seen.push(key);
          return { batch: { records: [] } };
        },
      },
    });
    startConnectorLivePush({
      installationId: "install-generation",
      generation: "v1",
      intervalMs: 0,
      listStreams: () => [stream("chat:v1")],
      push: async () => undefined,
    });
    startConnectorLivePush({
      installationId: "install-generation",
      generation: "v2",
      intervalMs: 0,
      listStreams: () => [stream("chat:v2")],
      push: async () => undefined,
    });
    try {
      assert.equal(
        await nudgeConnectorLivePush("install-generation", "chat:v1"),
        false,
      );
      assert.equal(
        await nudgeConnectorLivePush("install-generation", "chat:v2"),
        true,
      );
      assert.deepEqual(seen, ["chat:v2"]);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("polls a pass concurrently and yields while core pressure is critical", async () => {
    let pressure = "critical";
    let active = 0;
    let peak = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const streams = Array.from({ length: 4 }, (_, index) => ({
      stream_key: `chat:${index}`,
      connector: {
        source: "fake",
        async poll() {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return { batch: { records: [] } };
        },
      },
    }));
    startConnectorLivePush({
      installationId: "install-concurrent",
      intervalMs: 10,
      batchSize: 4,
      pressure: () => pressure,
      listStreams: () => streams,
      push: async () => undefined,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(active, 0);
      pressure = "ok";
      const deadline = Date.now() + 500;
      while (active < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(active, 4);
      assert.equal(peak, 4);
    } finally {
      release();
      stopAllConnectorLivePushes();
    }
  });

  it("honors idle_ms after an empty page", async () => {
    let polls = 0;
    const stream = {
      stream_key: "chat:idle",
      pace: { idle_ms: 1_000 },
      connector: {
        source: "fake",
        async poll() {
          polls += 1;
          return { batch: { records: [] } };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-idle",
      intervalMs: 10,
      listStreams: () => [stream],
      push: async () => undefined,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(polls, 1);
    } finally {
      stopAllConnectorLivePushes();
    }
  });

  it("honors retry-after backpressure before polling again", async () => {
    let polls = 0;
    let healthyPolls = 0;
    const errors = [];
    const stream = {
      stream_key: "chat:backpressure",
      connector: {
        source: "fake",
        async poll() {
          polls += 1;
          return {
            batch: {
              records: [{
                operation: "create",
                source: "fake",
                external_id: "m-backpressure",
                occurred_at: "2026-11-16T00:00:00.000Z",
                actor: { id: "user" },
                scope: { id: "personal" },
                type: "message",
                content: [{ role: "body", media_type: "text/plain", text: "hi" }],
              }],
            },
          };
        },
      },
    };
    const healthy = {
      stream_key: "chat:healthy",
      connector: {
        source: "fake",
        async poll() {
          healthyPolls += 1;
          return { batch: { records: [] } };
        },
      },
    };
    startConnectorLivePush({
      installationId: "install-backpressure",
      intervalMs: 10,
      listStreams: () => [stream, healthy],
      onError: (error, streamKey) => errors.push([error.message, streamKey]),
      push: async () => {
        const error = new Error("busy");
        error.retryAfterMs = 1_000;
        throw error;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(polls, 1);
      assert.ok(healthyPolls > 1);
      assert.deepEqual(errors, [["busy", "chat:backpressure"]]);
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
