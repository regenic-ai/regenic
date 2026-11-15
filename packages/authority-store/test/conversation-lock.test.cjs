const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { lockConversationThreads } = require("../dist/postgres/conversation-lock");
const { append, appendRevision, markTombstone, commitIngestOn, bindSourceIdentityAliases } = require("../dist/postgres/events");

describe("PostgreSQL conversation lock ordering", () => {
  it("locks unique conversation keys in stable organization/thread order", async () => {
    const calls = [];
    const db = {
      async queryOne(sql, params, client) {
        calls.push({ sql, params, client });
        return null;
      },
    };
    const client = {};

    await lockConversationThreads(db, client, [
      { org_id: "org-b", thread_id: "thread-1" },
      { org_id: "org-a", thread_id: "thread-z" },
      { org_id: "org-a", thread_id: "thread-a" },
      { org_id: "org-a", thread_id: "thread-a" },
    ]);

    assert.deepEqual(calls.map(({ params }) => params), [
      ["org-a", "thread-a"],
      ["org-a", "thread-z"],
      ["org-b", "thread-1"],
    ]);
    assert.ok(calls.every(({ client: actual }) => actual === client));
    assert.ok(calls.every(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  });

  it("rejects incomplete conversation identities before taking a lock", async () => {
    let calls = 0;
    const db = {
      async queryOne() {
        calls += 1;
        return null;
      },
    };

    await assert.rejects(
      lockConversationThreads(db, {}, [{ org_id: "org-a", thread_id: " " }]),
      /requires an organization and thread identity/,
    );
    assert.equal(calls, 0);
  });

  for (const operation of ["append", "revision", "tombstone", "ingest"]) {
    it(`locks the generated event conversation before ${operation}`, async () => {
      const locks = [];
      let inserted;
      const stopped = new Error("stop after event insertion");
      const client = {};
      const db = {
        async withTx(fn) { return fn(client); },
        async queryOne(sql, params, actualClient) {
          assert.equal(actualClient, client);
          if (sql.includes("pg_advisory_xact_lock")) {
            locks.push(params);
            return null;
          }
          if (sql.includes("FROM source_heads")) return null;
          throw new Error("Unexpected query");
        },
        async execute(sql, params, actualClient) {
          assert.equal(actualClient, client);
          if (sql.includes("INSERT INTO events")) {
            inserted = params;
            throw stopped;
          }
          return 1;
        },
      };
      const input = {
        org_id: "org", source: "source", external_id: ":out:message",
        expected_head_id: null, parent_event_id: "old",
        content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: "2026-01-01T00:00:00.000Z",
      };
      const run = () => {
        if (operation === "append") return append(db, input);
        if (operation === "revision") return appendRevision(db, input);
        if (operation === "tombstone") return markTombstone(db, input);
        return commitIngestOn(db, client, { appends: [input], dispositions: [] });
      };
      await assert.rejects(run(), (error) => error === stopped);
      assert.ok(inserted[0]);
      assert.equal(inserted[10], `source:${inserted[0]}`);
      assert.deepEqual(locks, [["org", inserted[10]]]);
    });

    it(`locks both conversations before a moved ${operation}`, async () => {
      const locks = [];
      const stopped = new Error("stop after lock acquisition");
      const client = {};
      const db = {
        async withTx(fn) { return fn(client); },
        async queryOne(sql, params, actualClient) {
          assert.equal(actualClient, client);
          if (sql.includes("SELECT source, external_id, thread_id FROM events")) {
            return { source: "source", external_id: "message", thread_id: "source:old" };
          }
          if (sql.includes("pg_advisory_xact_lock")) {
            locks.push(params);
            return null;
          }
          throw stopped;
        },
        async execute() { throw stopped; },
      };
      const input = {
        id: "new", org_id: "org", source: "source", external_id: "message",
        thread_id: "source:new", expected_head_id: "old", parent_event_id: "old",
        occurred_at: "2026-01-01T00:00:00.000Z",
      };
      const run = () => {
        if (operation === "append") return append(db, input);
        if (operation === "revision") return appendRevision(db, input);
        if (operation === "tombstone") return markTombstone(db, input);
        return commitIngestOn(db, client, { appends: [input], dispositions: [] });
      };
      await assert.rejects(run(), (error) => error === stopped);
      assert.deepEqual(locks, [["org", "source:new"], ["org", "source:old"]]);
    });
  }

  it("locks every generated and explicit conversation before a mixed ingest batch writes", async () => {
    const calls = [];
    const inserted = [];
    const stopped = new Error("stop after second insert");
    const client = {};
    const db = {
      async queryOne(sql, params) {
        if (sql.includes("pg_advisory_xact_lock")) calls.push(["lock", ...params]);
        return null;
      },
      async execute(sql, params) {
        if (sql.includes("INSERT INTO events")) {
          inserted.push(params);
          calls.push(["insert", params[0]]);
          if (inserted.length === 2) throw stopped;
        }
        return 1;
      },
    };
    const base = {
      org_id: "org", source: "source", expected_head_id: null,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: "2026-01-01T00:00:00.000Z",
    };
    const request = {
      appends: [
        { ...base, external_id: ":out:first" },
        { ...base, id: "explicit", external_id: ":out:second" },
      ],
      dispositions: [],
    };
    await assert.rejects(commitIngestOn(db, client, request), (error) => error === stopped);
    assert.equal(request.appends[0].id, undefined);
    assert.notEqual(inserted[0][0], inserted[1][0]);
    assert.equal(inserted[1][0], "explicit");
    assert.deepEqual(calls.slice(0, 2).map((call) => call.slice(1)).sort(), [
      ["org", inserted[0][10]],
      ["org", inserted[1][10]],
    ].sort());
    assert.ok(calls.slice(0, 2).every((call) => call[0] === "lock"));
    assert.equal(inserted[0][10], `source:${inserted[0][0]}`);
    assert.equal(inserted[1][10], "source:explicit");
  });

  it("locks the event conversation before checking and binding source aliases", async () => {
    const calls = [];
    const client = {};
    const db = {
      async withTx(fn) { return fn(client); },
      async queryOne(sql, params, actualClient) {
        assert.equal(actualClient, client);
        if (sql.includes("SELECT id, org_id, source")) {
          calls.push("event");
          return {
            id: "event", org_id: "org", source: "source", external_id: "message",
            thread_id: "source:thread", operation: "create",
            occurred_at: "2026-01-01T00:00:00.000Z", ingested_at: "2026-01-01T00:00:00.000Z",
          };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          calls.push("lock");
          assert.deepEqual(params, ["org", "source:thread"]);
          return null;
        }
        if (sql.includes("FROM events")) { calls.push("recheck"); return { exists: 1 }; }
        if (sql.includes("FROM source_heads")) { calls.push("head"); return { exists: 1 }; }
        throw new Error("Unexpected query");
      },
      async execute(_sql, _params, actualClient) {
        assert.equal(actualClient, client);
        calls.push("bind");
      },
    };
    await bindSourceIdentityAliases(db, {
      org_id: "org", event_id: "event", aliases: [{ source: "source", external_id: "alias" }],
    });
    assert.deepEqual(calls, ["event", "lock", "recheck", "head", "bind"]);
  });
});
