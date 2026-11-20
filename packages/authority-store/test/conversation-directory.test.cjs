const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { SqliteAuthorityStore } = require("../dist/sqlite");

const roots = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(id, externalId, at) {
  return {
    id,
    org_id: "local-owner",
    source: "synthetic",
    external_id: externalId,
    content_hash: "a".repeat(64),
    content_media_type: "text/plain",
    content_byte_size: 1,
    occurred_at: at,
    expected_head_id: null,
  };
}

function decision(id, at) {
  return {
    event_id: id,
    org_id: "local-owner",
    disposition: "current_work",
    layer: "L1_event",
    reason_codes: [],
    score: 1,
    decided_at: at,
  };
}

describe("conversation directory", () => {
  it("ranks a name prefix ahead of a newer substring and resolves a saved id", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-directory-"));
    roots.push(root);
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const recent = "2026-08-24T02:00:00.000Z";
    const older = "2026-08-24T01:00:00.000Z";
    await store.commitIngest({
      appends: [
        event("recent", "notes", recent),
        event("older", "crm", older),
        event("quiet", "quiet", "2026-08-24T00:00:00.000Z"),
      ],
      dispositions: [
        decision("recent", recent),
        decision("older", older),
        decision("quiet", "2026-08-24T00:00:00.000Z"),
      ],
    });
    store.close();
    const db = new Database(path);
    const threads = new Map(
      db.prepare("SELECT external_id, thread_id FROM events WHERE org_id = ?")
        .all("local-owner")
        .map((row) => [row.external_id, row.thread_id]),
    );
    const recentThread = threads.get("notes");
    const olderThread = threads.get("crm");
    const quietThread = threads.get("quiet");
    assert.equal(typeof recentThread, "string");
    assert.equal(typeof olderThread, "string");
    assert.equal(typeof quietThread, "string");
    db.prepare(`
      INSERT INTO connector_installations (
        id, org_id, connector_type, status, config_json, created_at, updated_at
      ) VALUES ('crm', 'local-owner', 'synthetic', 'enabled', '{}', ?, ?)
    `).run(older, older);
    db.prepare(`
      INSERT INTO connector_stream_members (
        installation_id, stream_key, thread_id, label, kind,
        generation, discovered_at, last_seen_at
      ) VALUES ('crm', 'crm', ?, 'Regenic project', 'chat', 1, ?, ?)
    `).run(olderThread, older, older);
    db.prepare(`
      INSERT INTO connector_installations (
        id, org_id, connector_type, status, config_json, created_at, updated_at
      ) VALUES ('other', 'other-org', 'synthetic', 'enabled', '{}', ?, ?)
    `).run(older, older);
    db.prepare(`
      INSERT INTO connector_stream_members (
        installation_id, stream_key, thread_id, label, kind,
        generation, discovered_at, last_seen_at
      ) VALUES
        ('other', 'leak-older', ?, 'Z Regenic leaked', 'chat', 1, ?, ?),
        ('other', 'leak-quiet', ?, 'Regenic leaked', 'chat', 1, ?, ?)
    `).run(olderThread, older, older, quietThread, older, older);
    db.prepare(`
      INSERT INTO conversation_prefs (org_id, thread_id, title, pinned, updated_at)
      VALUES ('local-owner', ?, 'team regenic notes', 0, ?)
    `).run(recentThread, recent);
    db.close();
    const reopened = new SqliteAuthorityStore(path);
    try {
      const ranked = await reopened.searchConversationDirectory("local-owner", { q: "rege" });
      assert.equal(ranked[0]?.thread_id, olderThread);
      assert.equal(ranked[0]?.catalog_label, "Regenic project");
      assert.equal(ranked[1]?.thread_id, recentThread);
      assert.equal(ranked.some((row) => row.thread_id === quietThread), false);
      const exact = await reopened.searchConversationDirectory("local-owner", {
        thread_id: recentThread,
      });
      assert.equal(exact.length, 1);
      assert.equal(exact[0].pref_title, "team regenic notes");
      const recentPage = await reopened.searchConversationDirectory("local-owner", { limit: 1 });
      assert.equal(recentPage.length, 1);
      assert.equal(recentPage[0].thread_id, recentThread);
    } finally {
      reopened.close();
    }
  });
});
