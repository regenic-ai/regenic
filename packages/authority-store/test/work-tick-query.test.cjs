const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { SqliteAuthorityStore } = require("../dist/sqlite");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

function item(id, status, unitKey = id) {
  return {
    id,
    org_id: "local-owner",
    thread_id: "slack:C1",
    unit_key: unitKey,
    record_class: "utterance",
    thread_facet: "chat",
    status,
    created_at: "2026-10-13T00:00:00.000Z",
    updated_at: "2026-10-13T00:00:00.000Z",
  };
}

function delivery(id, workItemId, status, extra = {}) {
  return {
    id,
    org_id: "local-owner",
    work_item_id: workItemId,
    recipe_id: "recipe-1",
    kind: "push",
    unit_key: id,
    status,
    write_back: extra.write_back ?? "pending",
    attempts: 0,
    payload: { summary: "done" },
    created_at: "2026-10-13T00:00:00.000Z",
    updated_at: "2026-10-13T00:00:00.000Z",
    ...extra,
  };
}

describe("work tick queries", () => {
  it("returns due deliveries and active work without the settled rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-work-tick-"));
    roots.push(root);
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await store.putWorkItem(item("open-1", "open", "event-open"));
    await store.putWorkItem(item("run-1", "running", "event-run"));
    await store.putWorkItem(item("done-1", "done", "event-done"));
    await store.putWorkDelivery(delivery("due", "open-1", "queued"));
    await store.putWorkDelivery(delivery("sent", "done-1", "acked", { write_back: "sent" }));
    const now = "2026-10-13T01:00:00.000Z";
    const due = await store.listDueWorkDeliveries("local-owner", now);
    assert.deepEqual(due.map((row) => row.id), ["due"]);
    const active = await store.listWorkItems("local-owner", {
      statuses: ["open", "running", "waiting_human"],
    });
    assert.deepEqual(
      active.map((row) => row.id).sort(),
      ["open-1", "run-1"],
    );
    const found = await store.getWorkItemByUnitKey("local-owner", "slack:C1", "event-done");
    assert.equal(found.id, "done-1");
    store.close();
  });

  it("loads task rows that still need work, and counts shown and hidden heads", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-work-tick-"));
    roots.push(root);
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const db = new Database(path);
    insertCurrent(db, "evt-chat", "slack:chat", ["actionable"]);
    insertCurrent(db, "evt-new", "slack:task-new", ["task"]);
    insertCurrent(db, "evt-retry", "slack:task-retry", ["task"]);
    insertCurrent(db, "evt-done", "slack:task-done", ["task"]);
    insertCurrent(db, "evt-hidden", "slack:hidden", ["actionable"]);
    db.close();
    await store.putWorkItem({
      ...item("done-task", "done", "evt-done"),
      thread_id: "slack:task-done",
      record_class: "task",
    });
    await store.putWorkItem({
      ...item("retry-1", "open", "evt-retry"),
      thread_id: "slack:task-retry",
      record_class: "task",
    });
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "slack:hidden",
      hidden: true,
      updated_at: "2026-10-13T00:00:00.000Z",
    });
    const tasks = await store.listInbox("local-owner", {
      tasks: true,
      needs_work: true,
    });
    assert.deepEqual(
      tasks.map((row) => row.event.id).sort(),
      ["evt-new", "evt-retry"],
    );
    const summary = await store.summarizeInbox("local-owner");
    assert.equal(summary.count, 4);
    assert.equal(summary.hidden_count, 1);
    store.close();
  });
});

function insertCurrent(db, id, threadId, reasons) {
  const at = "2026-10-13T00:00:00.000Z";
  db.prepare(
    `
      INSERT INTO events (
        id, org_id, source, external_id, operation,
        occurred_at, ingested_at, thread_id
      ) VALUES (?, 'local-owner', 'slack', ?, 'create', ?, ?, ?)
    `,
  ).run(id, `${threadId}:${id}`, at, at, threadId);
  db.prepare(
    `
      INSERT INTO source_heads (org_id, source, external_id, current_event_id)
      VALUES ('local-owner', 'slack', ?, ?)
    `,
  ).run(`${threadId}:${id}`, id);
  db.prepare(
    `
      INSERT INTO message_dispositions (
        event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
      ) VALUES (?, 'local-owner', 'current_work', 'L1_event', ?, 1, ?)
    `,
  ).run(id, JSON.stringify(reasons), at);
  db.prepare(
    `
      INSERT INTO thread_heads (
        org_id, thread_id, face_event_id, face_occurred_at, has_current_work
      ) VALUES ('local-owner', ?, ?, ?, 1)
    `,
  ).run(threadId, id, at);
}
