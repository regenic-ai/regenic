const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { SqliteAuthorityStore } = require("../dist/sqlite");
const {
  CustomerServiceTaskConflictError,
  validateCustomerServiceTask,
} = require("../../domain/dist");

function task(id = "task-1") {
  return validateCustomerServiceTask({
    schema_version: "1.0",
    id,
    org_id: "owner",
    status: "resolving_context",
    revision: 1,
    brief: {
      version: 1,
      question: "上次选中的两位都还没回复吗？",
      source: {
        event_id: "event-1",
        content_hash: "a".repeat(64),
        thread_id: "fixture:conversation:a",
        source: "fixture",
        external_id: "message-1",
        received_at: "2026-10-22T04:00:00.000Z",
      },
      customer: { status: "unresolved", evidence: [] },
      project: { status: "unresolved", evidence: [] },
      batch: { status: "unresolved", evidence: [] },
      intent: { status: "unresolved", evidence: [] },
      query_at: "2026-10-22T04:00:00.000Z",
      members_closed: false,
      members: [],
      requested_fields: [],
      unresolved: ["customer"],
      context_snapshot_ids: [],
    },
    context_evidence: [],
    continuations: [],
    business_evidence: [],
    created_at: "2026-10-22T04:00:00.000Z",
    updated_at: "2026-10-22T04:00:00.000Z",
  });
}

test("SQLite persists customer tasks with optimistic revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "regenic-customer-task-"));
  const path = join(root, "authority.db");
  let store = new SqliteAuthorityStore(path);
  try {
    const created = await store.putCustomerServiceTask(task());
    assert.equal(created.revision, 1);
    const updated = {
      ...created,
      status: "needs_clarification",
      revision: 2,
      updated_at: "2026-10-22T04:01:00.000Z",
    };
    await store.putCustomerServiceTask(updated, 1);
    await assert.rejects(
      store.putCustomerServiceTask({ ...updated, revision: 3 }, 1),
      CustomerServiceTaskConflictError,
    );
    store.close();
    store = new SqliteAuthorityStore(path);
    assert.equal((await store.getCustomerServiceTask("owner", "task-1")).status, "needs_clarification");
    assert.equal((await store.listCustomerServiceTasks({
      org_id: "owner",
      statuses: ["needs_clarification"],
    })).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
