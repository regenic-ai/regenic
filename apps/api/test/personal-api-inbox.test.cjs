const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { createHttpApp } = require("../dist/http-app");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const {
  createRoot,
  ingestActionable,
  setEnv,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("lists current-work inbox items with Blob body text", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = await (await fetch(`${origin}/v1/me/inbox/${eventId}`)).json();

      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].event.external_id, "ask-1");
      assert.equal(inbox[0].decision.disposition, "current_work");
      assert.equal(inbox[0].body_text, "Please confirm the release.");
      assert.equal(inbox[0].can_send, false);
      assert.equal(item.event.id, eventId);
      assert.equal(item.body_text, "Please confirm the release.");
    } finally {
      await app.close();
    }
  });

  it("reads and updates a personal dispatch policy", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const defaults = await (await fetch(`${origin}/v1/me/dispatch-policy`)).json();
      assert.equal(defaults.version, 1);
      assert.equal(defaults.actionable_disposition, "current_work");
      const policy = {
        ...defaults,
        actionable_disposition: "pending",
        default_disposition: "outside_current_work",
      };
      const updated = await (
        await fetch(`${origin}/v1/me/dispatch-policy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policy }),
        })
      ).json();
      assert.deepEqual(updated, policy);
      assert.deepEqual(await (await fetch(`${origin}/v1/me/dispatch-policy`)).json(), policy);
    } finally {
      await app.close();
    }
  });

  it("reads and updates a personal follow-up policy", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const defaults = await (await fetch(`${origin}/v1/me/follow-up-policy`)).json();
      assert.equal(defaults.version, 1);
      assert.equal(defaults.wait_minutes, 1440);
      const policy = { ...defaults, wait_minutes: 120, include_initial_outbound: true };
      const updated = await (
        await fetch(`${origin}/v1/me/follow-up-policy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policy }),
        })
      ).json();
      assert.deepEqual(updated, policy);
      assert.deepEqual(await (await fetch(`${origin}/v1/me/follow-up-policy`)).json(), policy);
    } finally {
      await app.close();
    }
  });

  it("reviews overdue personal follow-ups without changing inbox disposition", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestFollowUpThread(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const followUps = await (await fetch(`${origin}/v1/me/follow-ups`)).json();
      assert.equal(followUps.length, 1);
      assert.equal(followUps[0].event.id, eventId);
      assert.equal(followUps[0].candidate.outbound_external_id, "thread-1:out-1");
      assert.deepEqual(followUps[0].candidate.reason_codes, ["awaiting_reply"]);
      assert.equal(followUps[0].body_text, "I will confirm it today.");
      const threadId = encodeURIComponent(followUps[0].candidate.thread_id);
      const snoozed = await (
        await fetch(`${origin}/v1/me/follow-ups/${threadId}/snooze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ until: "2099-01-01T00:00:00.000Z" }),
        })
      ).json();
      assert.equal(snoozed.snoozed_until, "2099-01-01T00:00:00.000Z");
      assert.deepEqual(await (await fetch(`${origin}/v1/me/follow-ups`)).json(), []);
      assert.deepEqual(await (await fetch(`${origin}/v1/me/follow-ups/snoozes`)).json(), {
        [followUps[0].candidate.thread_id]: snoozed.snoozed_until,
      });
      await fetch(`${origin}/v1/me/follow-ups/${threadId}/snooze`, { method: "DELETE" });
      assert.deepEqual(await (await fetch(`${origin}/v1/me/follow-ups/snoozes`)).json(), {});
      assert.equal((await (await fetch(`${origin}/v1/me/follow-ups`)).json()).length, 1);
    } finally {
      await app.close();
    }
  });

  it("reapplies the saved dispatch policy to an inbox event", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const defaults = await (await fetch(`${origin}/v1/me/dispatch-policy`)).json();
      await fetch(`${origin}/v1/me/dispatch-policy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: { ...defaults, actionable_disposition: "pending" } }),
      });
      const decision = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/dispatch-policy/reapply`, { method: "POST" })
      ).json();
      assert.equal(decision.disposition, "pending");
      assert.ok(decision.reason_codes.includes("policy_actionable"));
      assert.ok(decision.reason_codes.includes("personal_dispatch_policy"));
      assert.deepEqual(await (await fetch(`${origin}/v1/me/inbox`)).json(), []);
      const pending = await (await fetch(`${origin}/v1/me/inbox?disposition=pending`)).json();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].event.id, eventId);
      assert.equal(pending[0].decision.disposition, "pending");
    } finally {
      await app.close();
    }
  });

  it("lets a human triage an inbox event out of current work", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const triaged = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/triage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disposition: "outside_current_work" }),
        })
      ).json();
      assert.equal(triaged.disposition, "outside_current_work");
      assert.ok(triaged.reason_codes.includes("human_triage"));
      assert.deepEqual(await (await fetch(`${origin}/v1/me/inbox`)).json(), []);
      const reset = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/triage/reset`, {
          method: "POST",
        })
      ).json();
      assert.equal(reset.disposition, "current_work");
      assert.deepEqual(reset.reason_codes, ["actionable"]);
      assert.equal((await (await fetch(`${origin}/v1/me/inbox`)).json()).length, 1);
    } finally {
      await app.close();
    }
  });

  it("acknowledges an inbox event with its exact read cursor", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/inbox/${eventId}/ack`, {
        method: "POST",
      });
      if (!response.ok) assert.fail(await response.text());
      const pref = await response.json();
      assert.equal(pref.last_read_external_id, "ask-1");
      assert.equal(pref.last_read_at, "2026-08-21T00:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("folds and unfolds an inbox event's thread with human preference", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const folded = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/fold`, { method: "POST" })
      ).json();
      assert.equal(folded.hidden, true);
      assert.equal(folded.hidden_reason, "human");
      assert.deepEqual(await (await fetch(`${origin}/v1/me/inbox`)).json(), []);
      assert.equal((await (await fetch(`${origin}/v1/me/inbox?list=hidden`)).json()).length, 1);

      const unfolded = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/unfold`, { method: "POST" })
      ).json();
      assert.equal(unfolded.hidden, false);
      assert.equal(unfolded.hidden_reason, null);
      assert.equal((await (await fetch(`${origin}/v1/me/inbox`)).json()).length, 1);
    } finally {
      await app.close();
    }
  });

  it("pins and unpins an inbox event's thread", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const pinned = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/pin`, { method: "POST" })
      ).json();
      assert.equal(pinned.pinned, true);
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1&split=1`)).json();
      assert.equal(heads.pinned.length, 1);

      const unpinned = await (
        await fetch(`${origin}/v1/me/inbox/${eventId}/unpin`, { method: "POST" })
      ).json();
      assert.equal(unpinned.pinned, false);
      const after = await (await fetch(`${origin}/v1/me/inbox?heads=1&split=1`)).json();
      assert.equal(after.pinned.length, 0);
    } finally {
      await app.close();
    }
  });

  it("lists a tombstoned thread on the hidden list after policy fold", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const blobs = new FsBlobStore(blobRoot);
    const service = new IngestionService(blobs, authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "done-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "regenic",
          external_id: "order-9",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "task",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Review this order.",
            },
          ],
        },
      ],
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "done-2",
      received_at: "2026-08-21T00:02:00.000Z",
      records: [
        {
          operation: "tombstone",
          source: "regenic",
          external_id: "order-9",
          occurred_at: "2026-08-21T00:02:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "task",
        },
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const shown = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const hidden = await (
        await fetch(`${origin}/v1/me/inbox?heads=1&list=hidden`)
      ).json();
      assert.equal(shown.length, 0);
      assert.equal(hidden.length, 1);
      assert.equal(hidden[0].event.external_id, "order-9");
      assert.notEqual(hidden[0].event.operation, "tombstone");
      assert.equal(hidden[0].hidden, true);
      assert.match(hidden[0].body_text ?? "", /Review this order/);
    } finally {
      await app.close();
    }
  });

  it("returns inbox deltas, heads, and a light engine view", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(
      new FsBlobStore(blobRoot),
      authority,
    );
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-delta-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "first prompt for the desk",
        }),
      ],
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-delta-2",
      received_at: "2026-08-21T00:01:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-x:2",
          occurred_at: "2026-08-21T00:01:00.000Z",
          actor_id: "assistant",
          scope_id: "session-x",
          text: "second",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-y:1",
          occurred_at: "2026-08-21T00:02:00.000Z",
          actor_id: "user",
          scope_id: "session-y",
          text: "other thread stays current",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const all = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.ok(all.length >= 2);
      const first = [...all].sort((left, right) => {
        if (left.event.ingested_at === right.event.ingested_at) {
          return left.event.id < right.event.id ? -1 : 1;
        }
        return left.event.ingested_at < right.event.ingested_at ? -1 : 1;
      })[0];
      const delta = await (
        await fetch(
          `${origin}/v1/me/inbox?since=${encodeURIComponent(first.event.ingested_at)}&since_id=${encodeURIComponent(first.event.id)}`,
        )
      ).json();
      assert.ok(delta.every((item) => item.event.id !== first.event.id));
      assert.ok(delta.length < all.length);

      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const threads = new Set(heads.map((item) => item.thread_id));
      assert.equal(heads.length, threads.size);
      assert.ok(heads.length >= 2);
      assert.ok(
        heads.every((item) =>
          (item.attachments ?? []).every((file) => !file.data_base64),
        ),
      );

      const one = await (
        await fetch(`${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}`)
      ).json();
      assert.ok(one.length >= 2);
      assert.ok(one.every((item) => item.thread_id === "dsh:session-x"));
      const head = await (
        await fetch(
          `${origin}/v1/me/inbox?heads=1&thread_id=${encodeURIComponent("dsh:session-x")}`,
        )
      ).json();
      assert.equal(head.length, 1);
      assert.equal(head[0].thread_id, "dsh:session-x");
      assert.equal(head[0].event.external_id, "session-x:2");
      assert.equal(head[0].body_text, "second");
      const pagedHeads = await (
        await fetch(`${origin}/v1/me/inbox?heads=1&limit=1`)
      ).json();
      assert.equal(pagedHeads.length, 1);
      const olderHeads = await (
        await fetch(
          `${origin}/v1/me/inbox?heads=1&limit=1&before=${encodeURIComponent(pagedHeads[0].event.occurred_at)}&before_id=${encodeURIComponent(pagedHeads[0].event.id)}`,
        )
      ).json();
      assert.equal(olderHeads.length, 1);
      assert.notEqual(olderHeads[0].thread_id, pagedHeads[0].thread_id);
      const splitHeads = await (
        await fetch(`${origin}/v1/me/inbox?heads=1&limit=1&split=1`)
      ).json();
      assert.equal(splitHeads.live.length, 1);
      assert.equal(splitHeads.has_older, true);
      assert.equal(splitHeads.next_before.before_id, splitHeads.live[0].event.id);
      const olderSplit = await (
        await fetch(
          `${origin}/v1/me/inbox?heads=1&limit=1&split=1&before=${encodeURIComponent(splitHeads.next_before.before)}&before_id=${encodeURIComponent(splitHeads.next_before.before_id)}`,
        )
      ).json();
      assert.equal(olderSplit.live.length, 1);
      assert.notEqual(olderSplit.live[0].thread_id, splitHeads.live[0].thread_id);
      const recent = await (
        await fetch(
          `${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}&limit=1`,
        )
      ).json();
      assert.equal(recent.length, 1);
      assert.equal(recent[0].body_text, "second");
      const older = await (
        await fetch(
          `${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}&before=${encodeURIComponent(recent[0].event.occurred_at)}&before_id=${encodeURIComponent(recent[0].event.id)}&limit=1`,
        )
      ).json();
      assert.equal(older.length, 1);
      assert.equal(older[0].body_text, "first prompt for the desk");
      for (let index = 1; index < one.length; index += 1) {
        assert.ok(
          one[index - 1].event.occurred_at <= one[index].event.occurred_at,
          "thread messages should be oldest first",
        );
      }

      const light = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.deepEqual(
        light.catalog.map((item) => item.connector_type),
        ["dsh-session", "feishu-chat", "cursor-agent"],
      );
      assert.ok(light.installations.every((item) => item.last_attempt == null));
      assert.match(light.inbox_digest, /^\d+:/);

      const fullStarted = Date.now();
      const full = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.ok(Date.now() - fullStarted < 3_000);
      assert.ok(full.catalog.length >= 1);
      const feishu = full.catalog.find((item) => item.connector_type === "feishu-chat");
      const chatIds = feishu.fields.find((field) => field.key === "chat_ids");
      assert.equal((chatIds.options ?? []).length, 0);
      const optionRes = await fetch(
        `${origin}/v1/me/engine/catalog-options?connector_type=feishu-chat`,
      );
      assert.equal(optionRes.status, 200);
      const optionBody = await optionRes.json();
      assert.equal(typeof optionBody.field_options, "object");
    } finally {
      await app.close();
    }
  });

  it("marks a thread unread from its latest inbound, even when the list face is outbound", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-unread-head",
      received_at: "2026-08-24T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-unread:in",
          occurred_at: "2026-08-24T10:00:00.000Z",
          actor_id: "assistant",
          scope_id: "session-unread",
          text: "Need a decision",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-unread:out:1",
          occurred_at: "2026-08-24T12:00:00.000Z",
          actor_id: "user",
          scope_id: "session-unread",
          text: "Working through the decision now",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const row = heads.find((item) => item.thread_id === "dsh:session-unread");
      assert.equal(row.direction, "outbound");
      assert.equal(row.unread, true);
      assert.equal(row.can_receipt, false);
      assert.equal(row.receipt, undefined);
      const read = await fetch(`${origin}/v1/me/conversations/attention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-unread",
          last_read_at: "2026-08-24T10:00:00.000Z",
          last_read_external_id: "session-unread:in",
        }),
      });
      assert.ok(read.ok, await read.text());
      const after = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(
        after.find((item) => item.thread_id === "dsh:session-unread")?.unread,
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("includes pending siblings once a conversation is already current work", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-2",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-y:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-y" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-y:2",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-y" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "later" }],
        },
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const texts = inbox.map((item) => item.body_text).sort();
      assert.deepEqual(texts, ["Please confirm the release.", "later"]);
    } finally {
      await app.close();
    }
  });

  it("returns 503 for inbox when the personal kernel is not configured", async () => {
    setEnv({
      REGENIC_AUTHORITY_DRIVER: undefined,
      REGENIC_DATABASE: undefined,
      REGENIC_BLOB_ROOT: undefined,
      PORT: "4370",
      LISTEN_HOST: "127.0.0.1",
    });
    const app = await createHttpApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    try {
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(inbox.status, 503);
      assert.equal(engine.kernel, "stopped");
      assert.equal(engine.catalog[0].installed, false);
      assert.deepEqual(
        engine.catalog.map((item) => item.docs.map((doc) => doc.id)),
        [
          ["connector", "rfc0009"],
          ["connector", "rfc0009"],
          ["connector", "rfc0009"],
        ],
      );
      assert.deepEqual(
        engine.executor_catalog.map((item) => item.docs.map((doc) => doc.id)),
        [
          ["executor", "rfc0009"],
          ["executor", "rfc0009"],
        ],
      );
      assert.match(
        engine.catalog[0].docs[0].href,
        /github.com\/regenic-ai\/regenic\/blob\/main\/docs\/en\/CONNECTOR.md$/,
      );
      assert.match(
        engine.catalog[0].docs[0].href_zh,
        /docs\/zh\/CONNECTOR.md$/,
      );
      assert.match(
        engine.executor_catalog[0].docs[0].href,
        /docs\/en\/EXECUTOR.md$/,
      );
    } finally {
      await app.close();
    }
  });
});

async function ingestFollowUpThread(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const now = Date.now();
  const inboundAt = new Date(now - 27 * 60 * 60_000).toISOString();
  const outboundAt = new Date(now - 26 * 60 * 60_000).toISOString();
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "follow-up-1",
    received_at: new Date(now).toISOString(),
    records: [
      channelRecord({ channel: "slack", kind: "user", direction: "inbound", external_id: "thread-1:in-1", occurred_at: inboundAt, actor_id: "peer", scope_id: "personal", text: "Can you confirm the release?" }),
      channelRecord({ channel: "slack", kind: "user", direction: "outbound", external_id: "thread-1:out-1", occurred_at: outboundAt, actor_id: "local-owner", scope_id: "personal", text: "I will confirm it today." }),
    ],
  });
  authority.close();
  return result.records[1].event_id;
}
