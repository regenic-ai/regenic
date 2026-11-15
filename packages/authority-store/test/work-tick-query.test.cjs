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

function seedWorkItem(db, value) {
  db.prepare(`INSERT INTO work_items (
    id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet, status,
    recipe_id, created_at, updated_at, current_run_id, version, visibility_intent_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    value.id,
    value.org_id,
    value.thread_id,
    value.unit_key,
    value.head_event_id ?? null,
    value.record_class,
    value.thread_facet,
    value.status,
    value.recipe_id ?? null,
    value.created_at,
    value.updated_at,
    value.current_run_id ?? null,
    value.version ?? 0,
    value.visibility_intent_version ?? 0,
  );
}

function seedWorkDelivery(db, value) {
  db.prepare(`INSERT INTO work_deliveries (
    id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
    status, write_back, attempts, last_error, next_retry_at, payload_json,
    lease_expires_at, idempotency_key, channel_receipt_json, created_at, updated_at,
    run_id, target_json, lease_owner, claim_token, cancel_requested_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    value.id,
    value.org_id,
    value.work_item_id,
    value.version ?? 0,
    value.recipe_id,
    value.kind,
    value.unit_key,
    value.event_id ?? null,
    value.status,
    value.write_back,
    value.attempts,
    value.last_error ?? null,
    value.next_retry_at ?? null,
    value.payload ? JSON.stringify(value.payload) : null,
    value.lease_expires_at ?? null,
    value.idempotency_key ?? null,
    value.channel_receipt ? JSON.stringify(value.channel_receipt) : null,
    value.created_at,
    value.updated_at,
    value.run_id ?? null,
    value.target ? JSON.stringify(value.target) : null,
    value.lease_owner ?? null,
    value.claim_token ?? null,
    value.cancel_requested_at ?? null,
  );
}

describe("work tick queries", () => {
  it("returns due deliveries and active work without the settled rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-work-tick-"));
    roots.push(root);
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const db = new Database(path);
    seedWorkItem(db, item("open-1", "open", "event-open"));
    seedWorkItem(db, item("run-1", "running", "event-run"));
    seedWorkItem(db, item("done-1", "done", "event-done"));
    seedWorkDelivery(db, delivery("due", "open-1", "queued"));
    seedWorkDelivery(db, delivery("sent", "done-1", "acked", { write_back: "sent" }));
    db.close();
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
    seedWorkItem(db, {
      ...item("done-task", "done", "evt-done"),
      thread_id: "slack:task-done",
      record_class: "task",
    });
    seedWorkItem(db, {
      ...item("retry-1", "open", "evt-retry"),
      thread_id: "slack:task-retry",
      record_class: "task",
    });
    db.close();
    await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "slack:hidden",
      hidden: true,
      expected_version: 0,
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
