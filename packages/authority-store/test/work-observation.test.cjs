const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { MemoryAuthorityStore, MemoryWorkStore, enqueueWriteBack, conversationId } = require("@regenic/domain");
const { SqliteAuthorityStore, SqliteSplitAuthorityStore } = require("../dist/sqlite");
const { PostgresAuthorityStore } = require("../dist/postgres");
const { Client } = require("pg");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../dist/sqlite/migrations");

const NOW = "2026-11-09T08:00:00.000Z";
const LATER = "2026-11-09T08:01:00.000Z";
const ORG = "owner";

const drivers = [
  { name: "memory", open: async () => ({ store: new MemoryWorkStore() }) },
  { name: "sqlite", open: async (path) => ({ store: new SqliteAuthorityStore(path) }) },
  { name: "sqlite writer RPC", open: async (path) => ({ store: await SqliteSplitAuthorityStore.open(path) }) },
];
const postgresFixtures = [];
drivers.push({
  name: "postgres",
  skip: !process.env.TEST_DATABASE_URL?.trim(),
  async open() {
    const available = postgresFixtures.find((entry) => !entry.inUse);
    if (available) {
      available.inUse = true;
      return available.binding;
    }
    const base = process.env.TEST_DATABASE_URL.trim();
    const schema = `s${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: base });
    await admin.connect();
    let store;
    let reader;
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      created = true;
      const url = new URL(base);
      url.searchParams.set("options", `-csearch_path=${schema}`);
      store = await PostgresAuthorityStore.open(url.toString());
      reader = new Client({ connectionString: url.toString() });
      await reader.connect();
      const tables = await reader.query(`SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
        ORDER BY c.relname`, [schema]);
      assert.ok(tables.rows.length > 0, "PostgreSQL fixture has no tables");
      const entry = { inUse: true };
      const binding = {
        store,
        query: (text, params) => reader.query(text, params),
        async release() {
          await reader.query(`TRUNCATE TABLE ${tables.rows.map((row) => row.name).join(", ")} RESTART IDENTITY`);
          entry.inUse = false;
        },
        async destroy() {
          try {
            await store.close();
          } finally {
            try {
              await reader.end();
            } finally {
              try {
                await admin.query(`DROP SCHEMA ${schema} CASCADE`);
              } finally {
                await admin.end();
              }
            }
          }
        },
      };
      entry.binding = binding;
      postgresFixtures.push(entry);
      return binding;
    } catch (error) {
      try {
        await store?.close();
      } finally {
        try {
          await reader?.end();
        } finally {
          try {
            if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
      throw error;
    }
  },
});

after(async () => {
  const results = await Promise.allSettled(postgresFixtures.map((entry) => entry.binding.destroy()));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Failed to clean up PostgreSQL test schemas");
});

describe("postgres fixture isolation", { skip: !process.env.TEST_DATABASE_URL?.trim() }, () => {
  it("reuses cleared schemas without sharing simultaneous fixtures", async () => {
    const driver = drivers.find((candidate) => candidate.name === "postgres");
    const active = new Set();
    const acquire = async () => {
      const binding = await driver.open();
      active.add(binding);
      return binding;
    };
    const release = async (binding) => {
      await binding.release();
      active.delete(binding);
    };
    try {
      const first = await acquire();
      const second = await acquire();
      const firstSchema = (await first.query("SELECT current_schema() AS name")).rows[0].name;
      const secondSchema = (await second.query("SELECT current_schema() AS name")).rows[0].name;
      assert.notEqual(firstSchema, secondSchema);
      await first.store.putRecipe({
        id: "fixture-isolation", org_id: ORG, name: "Fixture",
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: "test", executor_config: {}, can_write_back: false,
        include_context: false, enabled: true, created_at: NOW, updated_at: NOW,
      });
      await release(first);
      const reused = await acquire();
      assert.equal((await reused.query("SELECT current_schema() AS name")).rows[0].name, firstSchema);
      assert.equal(await reused.store.getRecipe(ORG, "fixture-isolation"), null);
      assert.equal(Number((await reused.query("SELECT count(*) AS total FROM schema_migrations")).rows[0].total), 1);
    } finally {
      for (const binding of active) await release(binding);
    }
  });
});

const TARGET = { installation_id: "sender-1", source: "source", target: "results" };

async function settleDeliveryAsSent(store, delivery, now = LATER, receipt = undefined) {
  const owner = `test-worker:${delivery.id}`;
  const claimed = await store.transitionWorkDelivery({
    org_id: delivery.org_id,
    delivery_id: delivery.id,
    kind: "claim",
    owner,
    force: true,
    now,
  });
  assert.equal(claimed.outcome, "applied");
  if (receipt) {
    const recorded = await store.transitionWorkDelivery({
      org_id: delivery.org_id,
      delivery_id: delivery.id,
      kind: "receipt",
      owner,
      token: claimed.delivery.claim_token,
      receipt,
      now,
    });
    assert.equal(recorded.outcome, "applied");
  }
  return store.transitionWorkDelivery({
    org_id: delivery.org_id,
    delivery_id: delivery.id,
    kind: "sent",
    owner,
    token: claimed.delivery.claim_token,
    now,
  });
}

async function setDeliveryStateForTest(store, delivery, status, writeBack, now = LATER) {
  const current = await store.getWorkDelivery(delivery.org_id, delivery.id);
  assert.ok(current, `missing delivery ${delivery.id}`);
  delivery = current;
  const owner = `test-worker:${delivery.id}`;
  if (status === "queued") return delivery;
  if (status === "acked" && writeBack === "skipped") {
    const result = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind: "cancel", now,
    });
    assert.equal(result.outcome, "applied", "cancel transition failed");
    return result.delivery;
  }
  const settle = async (kind, error) => {
    const claimed = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind: "claim",
      owner, force: true, now,
    });
    assert.equal(claimed.outcome, "applied");
    const result = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind, owner,
      token: claimed.delivery.claim_token, ...(error ? { error } : {}), now,
    });
    assert.equal(result.outcome, "applied");
    return result.delivery;
  };
  if (status === "write_back") {
    const claimed = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind: "claim",
      owner, force: true, now,
    });
    assert.equal(claimed.outcome, "applied");
    return claimed.delivery;
  }
  if (status === "dead") {
    let current = delivery;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      current = await settle("failed", `Test failure ${attempt + 1}`);
    }
    return current;
  }
  if (status === "uncertain") {
    const claimed = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind: "claim",
      owner, force: true, now,
    });
    assert.equal(claimed.outcome, "applied");
    const expiredAt = new Date(Date.parse(claimed.delivery.lease_expires_at) + 1).toISOString();
    const expired = await store.transitionWorkDelivery({
      org_id: delivery.org_id, delivery_id: delivery.id, kind: "expire", now: expiredAt,
    });
    assert.equal(expired.outcome, "applied");
    return expired.delivery;
  }
  if (status === "acked" && writeBack === "sent") {
    return settle("sent");
  }
  throw new Error(`Unsupported test delivery state: ${status}/${writeBack}`);
}

async function setDisposition(store, decision) {
  const expected = await store.getDisposition(decision.event_id);
  if (!expected) {
    await store.putDispositionIfAbsent(decision);
    return;
  }
  const result = await store.transitionDisposition({
    expected,
    decision,
    command: {
      org_id: decision.org_id,
      event_id: decision.event_id,
      action: "triage",
      disposition: decision.disposition,
      command_id: `test-disposition-${decision.event_id}-${decision.decided_at}`,
      issued_at: decision.decided_at,
    },
  });
  assert.equal(result.outcome, "applied");
}

async function fixture(t, driver, runFields = {}, bindExecution = true, options = {}) {
  const root = join(process.cwd(), `.test-work-observation-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  let binding;
  t.after(async () => {
    try {
      if (binding?.release) {
        await binding.release();
      } else {
        try {
          await binding?.store.close?.();
        } finally {
          await binding?.cleanup?.();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  binding = await driver.open(path);
  const { store } = binding;
  const recipe = {
    id: "recipe-1", org_id: ORG, name: "Handle work",
    match: { record_class: "task" }, trigger: { kind: "push" },
    executor_type: "test", executor_config: {}, can_write_back: true,
    include_context: false, enabled: true, created_at: NOW, updated_at: NOW,
  };
  await store.putRecipe(recipe);
  const savedRecipe = await store.getRecipe(ORG, recipe.id);
  assert.ok(savedRecipe);
  const triggerEventId = "work-trigger-event";
  if (driver.name === "memory") {
    store.recordCurrentWorkEvidence(triggerEventId);
  } else {
    await store.append({
      id: triggerEventId,
      org_id: ORG,
      source: "source",
      external_id: options.triggerWithoutThread ? "conversation:trigger" : "work-trigger-event",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      ...(options.triggerWithoutThread ? {} : { thread_id: "source:conversation" }),
      occurred_at: NOW,
      expected_head_id: null,
    });
    await store.putDispositionIfAbsent({
      event_id: triggerEventId, org_id: ORG, disposition: "current_work",
      layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
    });
  }
  const created = await store.createWorkItem({
    item: {
      id: "work-1", org_id: ORG, thread_id: "source:conversation",
      unit_key: "unit-1", head_event_id: triggerEventId,
      record_class: "task", thread_facet: "ticket", status: "open",
      recipe_id: recipe.id, created_at: NOW, updated_at: NOW,
    },
    recipe: savedRecipe,
    expected_recipe: savedRecipe,
  });
  assert.equal(created.outcome, "applied");
  const initialRun = {
    id: "run-1", org_id: ORG, work_item_id: "work-1", recipe_id: recipe.id,
    executor_type: "test", status: "running", start_state: "pending",
    created_at: NOW, updated_at: NOW,
    ...runFields,
  };
  if (options.startRun !== false) {
    assert.equal(await store.claimWorkRunStart({ run: initialRun }), true);
  }
  const item = await store.getWorkItem(ORG, "work-1");
  if (options.startRun !== false) {
    assert.equal(item.current_run_id, initialRun.id);
    assert.equal(item.version, 1);
  } else {
    assert.equal(item.status, "open");
    assert.equal(item.version, 0);
  }
  const pendingRun = options.startRun === false
    ? initialRun
    : await store.getWorkRun(ORG, "run-1");
  assert.equal(pendingRun.version ?? 0, 0);
  let run = pendingRun;
  if (bindExecution && options.startRun !== false) {
    const submitted = await store.checkpointWorkRunStart({
      expected_item: item, expected_run: pendingRun, kind: "submitted",
      external_run_id: "external-1", now: NOW,
    });
    assert.equal(submitted.outcome, "applied");
    run = submitted.run;
  }
  const input = {
    expected_item: item,
    expected_run: run,
    handle: {
      status: "completed", external_run_id: "external-1",
      agent_thread_id: "executor:conversation", result: { summary: "Handled" },
    },
    can_write_back: true, trigger_kind: "push", now: LATER,
  };
  return {
    get store() { return binding.store; },
    query: binding.query,
    path, recipe, item, run, input,
    async reopen(beforeOpen) {
      if (!driver.name.startsWith("sqlite")) return;
      await binding.store.close();
      if (beforeOpen) await beforeOpen(path);
      binding = await driver.open(path);
    },
  };
}

for (const driver of drivers.filter((entry) => entry.name.startsWith("sqlite"))) {
  it(`${driver.name} upgrades schema 75 without automatically completing an existing run`, async (t) => {
    const f = await fixture(t, driver, { write_back_required: false, trigger_kind: "push" });
    const item = await f.store.getWorkItem(ORG, f.item.id);
    const run = await f.store.getWorkRun(ORG, f.run.id);
    const disposition = await f.store.getDisposition(item.head_event_id);
    await f.reopen((path) => {
      const db = new Database(path);
      try {
        assert.equal(db.prepare("SELECT completion_policy_version FROM work_runs WHERE id = ?")
          .get(run.id).completion_policy_version, null);
        db.exec("ALTER TABLE work_runs DROP COLUMN completion_policy_version; ALTER TABLE work_runs DROP COLUMN hide_on_success");
        db.pragma("user_version = 75");
      } finally { db.close(); }
    });
    assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
    assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
    assert.deepEqual(await f.store.getDisposition(item.head_event_id), disposition);
    const inspect = new Database(f.path, { readonly: true });
    try {
      assert.equal(inspect.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
      assert.equal(inspect.prepare("SELECT completion_policy_version FROM work_runs WHERE id = ?")
        .get(run.id).completion_policy_version, null);
      assert.deepEqual(inspect.pragma("foreign_key_check"), []);
    } finally { inspect.close(); }
    assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
    assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "current_work");
    assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, false);
    await f.reopen();
    const completedItem = await f.store.getWorkItem(ORG, item.id);
    const completedRun = await f.store.getWorkRun(ORG, run.id);
    assert.equal(completedRun.completion_policy_version, undefined);
    assert.equal(completedItem.acknowledged_run_id, undefined);
    assert.equal((await f.store.acknowledgeWorkResult({
      expected_item: completedItem, run_id: run.id, trigger_event_id: item.head_event_id,
      command_id: "ack-upgraded-legacy-run", issued_at: LATER, now: LATER,
      expected_version: completedItem.version, expected_run_version: completedRun.version,
    })).outcome, "applied");
    assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, run.id);
    assert.equal((await f.store.getConversationPref(ORG, item.thread_id)).hidden, true);
  });

  describe(`${driver.name} automatic completion policy`, () => {
    const policy = { completion_policy_version: 1, write_back_required: false, trigger_kind: "push" };

    for (const hideOnSuccess of [false, true]) {
      it(`freezes hide_on_success=${hideOnSuccess} independently of successful completion`, async (t) => {
        const f = await fixture(t, driver, { ...policy, hide_on_success: hideOnSuccess });
        const recipe = await f.store.getRecipe(ORG, f.recipe.id);
        await f.store.putRecipe({ ...recipe, hide_on_success: !hideOnSuccess });
        await f.reopen();
        assert.equal((await f.store.getWorkRun(ORG, f.run.id)).hide_on_success, hideOnSuccess);
        assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
        assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "outside_current_work");
        assert.equal((await f.store.getWorkItem(ORG, f.item.id)).acknowledged_run_id, undefined);
        assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, hideOnSuccess);
        await f.reopen();
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = await f.store.getWorkRun(ORG, f.run.id);
        assert.equal((await f.store.acknowledgeWorkResult({
          expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
          expected_version: item.version, expected_run_version: run.version,
          command_id: "ack-frozen-visibility-result", issued_at: LATER, now: LATER,
        })).outcome, "applied");
        assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, hideOnSuccess);
      });
    }

    it("atomically closes successful work without human acknowledgment and reopens for new work", async (t) => {
      const f = await fixture(t, driver, policy);
      const completed = await f.store.commitWorkObservation(f.input);
      assert.equal(completed.outcome, "applied");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).acknowledged_run_id, undefined);
      const disposition = await f.store.getDisposition(f.item.head_event_id);
      assert.equal(disposition.disposition, "outside_current_work");
      assert.ok(disposition.reason_codes.includes("work_completed"));
      assert.ok(!disposition.reason_codes.includes("result_acknowledged"));
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden_reason, "policy");
      await f.reopen();
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).completion_policy_version, 1);
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, true);
      await f.store.append({
        id: "new-work-trigger", org_id: ORG, source: "source", external_id: "new-work",
        thread_id: f.item.thread_id, content_hash: "b".repeat(64),
        content_media_type: "text/plain", content_byte_size: 1, expected_head_id: null, occurred_at: LATER,
      });
      await f.store.putDispositionIfAbsent({
        event_id: "new-work-trigger", org_id: ORG, disposition: "current_work",
        layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: LATER,
      });
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, false);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: completed.transition.item, expected_run: run,
      })).outcome, "applied");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, false);
      assert.deepEqual(await f.store.getDisposition(f.item.head_event_id), disposition);
      await setDisposition(f.store, {
        ...disposition, disposition: "current_work", reason_codes: ["task"], decided_at: LATER,
      });
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: completed.transition.item,
        expected_run: await f.store.getWorkRun(ORG, f.run.id),
      })).outcome, "applied");
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "current_work");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, false);
    });

    it("keeps required delivery visible through rejection and uncertainty, then closes only on sent settlement", async (t) => {
      const f = await fixture(t, driver, { ...policy, write_back_required: true, write_back_target: TARGET });
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const assertOpen = async () => {
        assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
        assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "current_work");
      };
      await assertOpen();
      for (const kind of ["failed", "uncertain"]) {
        const claim = await f.store.transitionWorkDelivery({
          org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "policy-worker", force: true, now: LATER,
        });
        assert.equal(claim.outcome, "applied");
        assert.equal((await f.store.transitionWorkDelivery({
          org_id: ORG, delivery_id: delivery.id, kind, owner: "policy-worker",
          token: claim.delivery.claim_token, error: "Test send failure", now: LATER,
        })).outcome, "applied");
        await assertOpen();
      }
      const current = await f.store.getWorkDelivery(ORG, delivery.id);
      const reconciled = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "reconcile", resolution: "sent",
        expected_delivery: current, expected_item_version: (await f.store.getWorkItem(ORG, f.item.id)).version,
        command_id: "policy-confirm-sent", issued_at: LATER, now: LATER,
      });
      assert.equal(reconciled.outcome, "applied");
      assert.equal(reconciled.delivery.id, delivery.id);
      assert.equal(reconciled.delivery.channel_receipt, undefined);
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, true);
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "outside_current_work");
      assert.equal((await f.store.getConversationPref(ORG, "source:results"))?.hidden ?? false, false);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).acknowledged_run_id, undefined);
    });

    it("retains failures and other current work without folding", async (t) => {
      const f = await fixture(t, driver, policy);
      const failed = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, status: "failed" },
      });
      assert.equal(failed.outcome, "applied");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "current_work");
      const next = { ...f.run, id: "policy-run-2", status: "running", start_state: "pending",
        external_run_id: undefined, result: undefined, version: 0 };
      assert.equal(await f.store.claimWorkRunStart({
        run: next, expected_item: failed.transition.item, retry: "manual",
      }), true);
      const submitted = await f.store.checkpointWorkRunStart({
        expected_item: await f.store.getWorkItem(ORG, f.item.id),
        expected_run: await f.store.getWorkRun(ORG, next.id), kind: "submitted",
        external_run_id: "policy-execution-2", now: LATER,
      });
      assert.equal(submitted.outcome, "applied");
      await f.store.append({
        id: "other-current", org_id: ORG, source: "source", external_id: "other-current",
        thread_id: f.item.thread_id, content_hash: "b".repeat(64), content_media_type: "text/plain",
        content_byte_size: 1, expected_head_id: null, occurred_at: LATER,
      });
      await f.store.putDispositionIfAbsent({
        event_id: "other-current", org_id: ORG, disposition: "current_work", layer: "L1_event",
        reason_codes: ["task"], score: 1, decided_at: LATER,
      });
      const completed = await f.store.commitWorkObservation({
        ...f.input, expected_item: submitted.item, expected_run: submitted.run,
        handle: { ...f.input.handle, external_run_id: submitted.run.external_run_id, agent_thread_id: undefined },
      });
      assert.equal(completed.outcome, "applied");
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "outside_current_work");
      assert.equal((await f.store.getDisposition("other-current")).disposition, "current_work");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
    });

    it("preserves a manual show intent during execution and cannot rehide on repeated completion", async (t) => {
      const f = await fixture(t, driver, policy);
      await f.store.setConversationVisibility({
        org_id: ORG, thread_id: f.item.thread_id, hidden: false, expected_version: 0, updated_at: LATER,
      });
      const completed = await f.store.commitWorkObservation(f.input);
      assert.equal(completed.outcome, "applied");
      const pref = await f.store.getConversationPref(ORG, f.item.thread_id);
      assert.equal(pref.hidden, false);
      assert.equal(pref.visibility_version, 1);
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "outside_current_work");
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: completed.transition.item, expected_run: run,
      })).outcome, "applied");
      assert.deepEqual(await f.store.getConversationPref(ORG, f.item.thread_id), pref);
    });

    it("does not fold while another open work unit remains without another current-work source head", async (t) => {
      const f = await fixture(t, driver, policy);
      const recipe = await f.store.getRecipe(ORG, f.recipe.id);
      const pending = await f.store.createWorkItem({
        item: {
          id: "pending-other-work", org_id: ORG, thread_id: f.item.thread_id, unit_key: "pending-other-unit",
          record_class: "task", thread_facet: "ticket", status: "open", recipe_id: f.recipe.id,
          created_at: NOW, updated_at: NOW,
        },
        recipe, expected_recipe: recipe,
      });
      assert.equal(pending.outcome, "applied");
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "outside_current_work");
      assert.deepEqual(await f.store.listInbox(ORG, { disposition: "current_work" }), []);
      assert.equal((await f.store.getWorkItem(ORG, pending.item.id)).status, "open");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
    });

    it("rolls back completion, disposition and folding if its lifecycle audit cannot commit", async (t) => {
      const f = await fixture(t, driver, policy);
      const db = new Database(f.path);
      t.after(() => db.close());
      db.exec(`CREATE TRIGGER reject_policy_completion BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'current_work_changed'
          AND json_extract(NEW.payload_json, '$.reason') = 'work_completed'
        BEGIN SELECT RAISE(ABORT, 'policy completion audit rejected'); END;`);
      const disposition = await f.store.getDisposition(f.item.head_event_id);
      await assert.rejects(f.store.commitWorkObservation(f.input), /policy completion audit rejected/);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getDisposition(f.item.head_event_id), disposition);
      assert.equal(await f.store.getConversationPref(ORG, f.item.thread_id), null);
      db.exec("DROP TRIGGER reject_policy_completion");
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, true);
    });
  });
}

async function observeWorkAsTestState(f, status, now = LATER, result = undefined) {
  const expected_item = await f.store.getWorkItem(ORG, f.item.id);
  const expected_run = await f.store.getWorkRun(ORG, f.run.id);
  assert.ok(expected_item);
  assert.ok(expected_run);
  const executorStatus = status === "done" ? "completed" : status;
  const observation = await f.store.commitWorkObservation({
    ...f.input,
    expected_item,
    expected_run,
    handle: {
      ...f.input.handle,
      status: executorStatus,
      external_run_id: expected_run.external_run_id,
      result: result ?? (status === "done" ? { summary: "Handled" } : undefined),
    },
    can_write_back: false,
    now,
  });
  assert.equal(observation.outcome, "applied");
  return observation.transition.item;
}

async function dismissWorkAsTestState(f, now = LATER) {
  const expected_item = await f.store.getWorkItem(ORG, f.item.id);
  assert.ok(expected_item);
  const result = await f.store.dismissWorkItem({ expected_item, now });
  assert.equal(result.outcome, "applied");
  return result.item;
}

async function startCheckpointFixture(t, driver) {
  const f = await fixture(t, driver, {
    write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
  }, false);
  return { f, input: { expected_item: f.item, expected_run: f.run, now: LATER } };
}

async function seedLegacyStartState(f, driver, state) {
  if (driver.name === "memory") {
    f.store.runs.get(f.run.id).start_state = state;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_runs SET start_state = $1 WHERE org_id = $2 AND id = $3",
      [state ?? null, ORG, f.run.id]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_runs SET start_state = ? WHERE org_id = ? AND id = ?")
        .run(state ?? null, ORG, f.run.id);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkRun(ORG, f.run.id);
}

async function seedLegacyAgentThreadId(f, driver, runId, agentThreadId) {
  if (driver.name === "memory") {
    f.store.runs.get(runId).agent_thread_id = agentThreadId;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_runs SET agent_thread_id = $1 WHERE org_id = $2 AND id = $3",
      [agentThreadId, ORG, runId]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_runs SET agent_thread_id = ? WHERE org_id = ? AND id = ?")
        .run(agentThreadId, ORG, runId);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkRun(ORG, runId);
}

async function seedLegacyRunStatus(f, driver, status) {
  if (driver.name === "memory") {
    f.store.runs.get(f.run.id).status = status;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_runs SET status = $1 WHERE org_id = $2 AND id = $3",
      [status, ORG, f.run.id]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_runs SET status = ? WHERE org_id = ? AND id = ?")
        .run(status, ORG, f.run.id);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkRun(ORG, f.run.id);
}

async function seedLegacyWorkRun(f, driver, run) {
  if (driver.name === "memory") {
    f.store.runs.set(run.id, structuredClone(run));
  } else if (driver.name === "postgres") {
    await f.query(`INSERT INTO work_runs (
      id, org_id, work_item_id, recipe_id, executor_type, external_run_id, agent_thread_id,
      status, start_state, result_json, created_at, updated_at, version, write_back_required,
      write_back_target_json, trigger_kind, executor_config_json, include_context
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
      $15::jsonb, $16, $17::jsonb, $18)`, [
      run.id, run.org_id, run.work_item_id, run.recipe_id, run.executor_type,
      run.external_run_id ?? null, run.agent_thread_id ?? null, run.status,
      run.start_state ?? null, run.result === undefined ? null : JSON.stringify(run.result),
      run.created_at, run.updated_at, run.version ?? 0, run.write_back_required ?? null,
      run.write_back_target === undefined ? null : JSON.stringify(run.write_back_target),
      run.trigger_kind ?? null,
      run.executor_config === undefined ? null : JSON.stringify(run.executor_config),
      run.include_context ?? null,
    ]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare(`INSERT INTO work_runs (
        id, org_id, work_item_id, recipe_id, executor_type, external_run_id, agent_thread_id,
        status, start_state, result_json, created_at, updated_at, version, write_back_required,
        write_back_target_json, trigger_kind, executor_config_json, include_context
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        run.id, run.org_id, run.work_item_id, run.recipe_id, run.executor_type,
        run.external_run_id ?? null, run.agent_thread_id ?? null, run.status,
        run.start_state ?? null, run.result === undefined ? null : JSON.stringify(run.result),
        run.created_at, run.updated_at, run.version ?? 0,
        run.write_back_required === undefined ? null : Number(run.write_back_required),
        run.write_back_target === undefined ? null : JSON.stringify(run.write_back_target),
        run.trigger_kind ?? null,
        run.executor_config === undefined ? null : JSON.stringify(run.executor_config),
        run.include_context === undefined ? null : Number(run.include_context),
      );
    } finally {
      db.close();
    }
  }
  const saved = await f.store.getWorkRun(run.org_id, run.id);
  assert.ok(saved);
  return saved;
}

async function seedTestWorkDelivery(f, driver, delivery) {
  const row = { ...delivery, version: delivery.version ?? 0 };
  if (driver.name === "memory") {
    f.store.deliveries.set(row.id, structuredClone(row));
  } else if (driver.name === "postgres") {
    await f.query(`INSERT INTO work_deliveries (
      id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
      status, write_back, attempts, last_error, next_retry_at, payload_json,
      lease_expires_at, idempotency_key, channel_receipt_json, created_at, updated_at,
      run_id, target_json, lease_owner, claim_token, cancel_requested_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
      $15, $16, $17::jsonb, $18, $19, $20, $21::jsonb, $22, $23, $24
    )`, [
      row.id, row.org_id, row.work_item_id, row.version, row.recipe_id, row.kind, row.unit_key,
      row.event_id ?? null, row.status, row.write_back, row.attempts, row.last_error ?? null,
      row.next_retry_at ?? null, row.payload === undefined ? null : JSON.stringify(row.payload),
      row.lease_expires_at ?? null, row.idempotency_key ?? null,
      row.channel_receipt === undefined ? null : JSON.stringify(row.channel_receipt),
      row.created_at, row.updated_at, row.run_id ?? null,
      row.target === undefined ? null : JSON.stringify(row.target),
      row.lease_owner ?? null, row.claim_token ?? null, row.cancel_requested_at ?? null,
    ]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare(`INSERT INTO work_deliveries (
        id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
        status, write_back, attempts, last_error, next_retry_at, payload_json,
        lease_expires_at, idempotency_key, channel_receipt_json, created_at, updated_at,
        run_id, target_json, lease_owner, claim_token, cancel_requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.org_id, row.work_item_id, row.version, row.recipe_id, row.kind, row.unit_key,
        row.event_id ?? null, row.status, row.write_back, row.attempts, row.last_error ?? null,
        row.next_retry_at ?? null, row.payload === undefined ? null : JSON.stringify(row.payload),
        row.lease_expires_at ?? null, row.idempotency_key ?? null,
        row.channel_receipt === undefined ? null : JSON.stringify(row.channel_receipt),
        row.created_at, row.updated_at, row.run_id ?? null,
        row.target === undefined ? null : JSON.stringify(row.target),
        row.lease_owner ?? null, row.claim_token ?? null, row.cancel_requested_at ?? null,
      );
    } finally {
      db.close();
    }
  }
  const saved = await f.store.getWorkDelivery(row.org_id, row.id);
  assert.ok(saved);
  return saved;
}

async function seedLegacyMissingCurrentRunPointer(f, driver, itemId) {
  if (driver.name === "memory") {
    f.store.items.get(itemId).current_run_id = undefined;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_items SET current_run_id = NULL WHERE org_id = $1 AND id = $2",
      [ORG, itemId]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_items SET current_run_id = NULL WHERE org_id = ? AND id = ?")
        .run(ORG, itemId);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkItem(ORG, itemId);
}

async function seedLegacyWorkHeadEvent(f, driver, itemId, eventId) {
  if (driver.name.startsWith("memory")) {
    f.store.items.get(itemId).head_event_id = eventId;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_items SET head_event_id = $1 WHERE org_id = $2 AND id = $3",
      [eventId, ORG, itemId]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_items SET head_event_id = ? WHERE org_id = ? AND id = ?")
        .run(eventId, ORG, itemId);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkItem(ORG, itemId);
}

async function seedLegacyUnboundWorkRecipe(f, driver, itemId) {
  if (driver.name.startsWith("memory")) {
    f.store.items.get(itemId).recipe_id = undefined;
  } else if (driver.name === "postgres") {
    await f.query("UPDATE work_items SET recipe_id = NULL WHERE org_id = $1 AND id = $2",
      [ORG, itemId]);
  } else {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE work_items SET recipe_id = NULL WHERE org_id = ? AND id = ?")
        .run(ORG, itemId);
    } finally {
      db.close();
    }
  }
  return f.store.getWorkItem(ORG, itemId);
}

async function timeoutFixture(t, driver) {
  const f = await fixture(t, driver);
  const record = await f.store.putSearchAnswer({
    id: "answer-1", org_id: ORG, work_item_id: f.item.id,
    query: "Question", event_ids: ["event-1"], created_at: NOW, updated_at: NOW,
  });
  const saved = await f.store.getSearchAnswer(ORG, record.id);
  return Object.assign(f, { record: saved, timeout: { expected_item: f.item, search_answer_timeout: saved, now: LATER } });
}

function creationInput(f, fields = {}) {
  const recipe = { ...f.recipe, id: "created-recipe", trigger: { kind: "manual" }, created_at: LATER, updated_at: LATER };
  return {
    item: {
      ...f.item, id: "created-work", unit_key: "created-unit", recipe_id: recipe.id,
      status: "open", version: 0, current_run_id: undefined, created_at: LATER, updated_at: LATER,
    },
    recipe, expected_recipe: null, ...fields,
  };
}

function answerCreationInput(f) {
  const input = creationInput(f);
  return {
    ...input,
    search_answer: {
      id: "created-answer", org_id: ORG, work_item_id: input.item.id,
      query: "Question", event_ids: ["event-1", "event-2"], created_at: LATER, updated_at: LATER,
    },
  };
}

for (const driver of drivers) {
  describe(`${driver.name} atomic work observation`, { skip: driver.skip }, () => {
    it("atomically removes only a fresh unreserved item and its answer metadata", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      const created = await f.store.createWorkItem(input);
      assert.equal(created.outcome, "applied");
      const result = await f.store.abortWorkItemCreation({
        expected_item: created.item, expected_search_answer: created.search_answer,
      });
      assert.equal(result.outcome, "applied");
      assert.deepEqual(result.item, created.item);
      assert.deepEqual(result.search_answer, created.search_answer);
      assert.equal(await f.store.getWorkItem(ORG, created.item.id), null);
      assert.equal(await f.store.getSearchAnswer(ORG, created.search_answer.id), null);
      assert.deepEqual(await f.store.getRecipe(ORG, created.recipe.id), created.recipe);
      assert.deepEqual(await f.store.listWorkRuns(ORG, created.item.id), []);
    });

    it("audits changed run observations and delivery creation without copying result content", async (t) => {
      const f = await fixture(t, driver);
      const result = await f.store.commitWorkObservation({
        ...f.input,
        handle: { ...f.input.handle, result: { summary: "Private result body" } },
      });
      assert.equal(result.outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      let events;
      if (driver.name === "memory") {
        events = f.store.listWorkObservationEvents();
      } else if (driver.name === "postgres") {
        events = (await f.query(`SELECT aggregate_type, aggregate_id, aggregate_version,
          event_type, dedupe_key, payload_json::text AS payload_json
          FROM conversation_lifecycle_events WHERE org_id = $1 ORDER BY event_type`, [ORG])).rows;
      } else {
        const db = new Database(f.path, { readonly: true });
        try {
          events = db.prepare(`SELECT aggregate_type, aggregate_id, aggregate_version,
            event_type, dedupe_key, payload_json FROM conversation_lifecycle_events
            WHERE org_id = ? ORDER BY event_type`).all(ORG);
        } finally {
          db.close();
        }
      }
      assert.deepEqual(events.map((event) => event.event_type).sort(), [
        "delivery_created", "work_run_transitioned",
      ]);
      assert.equal(events.find((event) => event.event_type === "work_run_transitioned").aggregate_id, f.run.id);
      assert.equal(events.find((event) => event.event_type === "delivery_created").aggregate_id, delivery.id);
      assert.equal(events.some((event) =>
        JSON.stringify(event.payload ?? event.payload_json).includes("Private result body")), false);
    });

    it("atomically audits confirmation of an uncertain start", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const uncertain = await f.store.checkpointWorkRunStart({
        ...input, kind: "uncertain", error: "Start response was lost",
      });
      assert.equal(uncertain.outcome, "applied");
      const confirmed = await f.store.checkpointWorkRunStart({
        expected_item: uncertain.item,
        expected_run: uncertain.run,
        kind: "submitted",
        external_run_id: "external-1",
        agent_thread_id: "executor:conversation",
        now: LATER,
      });
      assert.equal(confirmed.outcome, "applied");
      let events;
      if (driver.name === "memory") {
        events = f.store.listWorkRunStartLifecycleEvents();
      } else if (driver.name === "postgres") {
        events = (await f.query(`SELECT aggregate_type, aggregate_id, aggregate_version,
          event_type, dedupe_key, payload_json::text AS payload_json
          FROM conversation_lifecycle_events WHERE org_id = $1 AND aggregate_id = $2`,
        [ORG, confirmed.run.id])).rows;
      } else {
        const db = new Database(f.path, { readonly: true });
        try {
          events = db.prepare(`SELECT aggregate_type, aggregate_id, aggregate_version,
            event_type, dedupe_key, payload_json FROM conversation_lifecycle_events
            WHERE org_id = ? AND aggregate_id = ?`).all(ORG, confirmed.run.id);
        } finally {
          db.close();
        }
      }
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal(event.event_type, "work_run_transitioned");
      assert.equal(event.aggregate_id, confirmed.run.id);
      const payload = event.payload ?? JSON.parse(event.payload_json);
      assert.equal(payload.from_start_state, "uncertain");
      assert.equal(payload.to_start_state, "submitted");
      assert.equal(payload.reason, "uncertain_start_reconciled");
    });

    it("atomically compare-and-sets ingested work updates and new units", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putRecipe({
        ...f.recipe, id: "foreign-recipe", org_id: "another-org", name: "Foreign recipe",
      });
      const foreignRecipe = await f.store.getRecipe("another-org", "foreign-recipe");
      assert.ok(foreignRecipe);
      const foreignCreated = await f.store.createWorkItem({
        item: {
          id: "foreign-work-id", org_id: "another-org", thread_id: "another-thread",
          unit_key: "foreign-unit", record_class: "task", thread_facet: "ticket",
          status: "open", recipe_id: foreignRecipe.id, created_at: NOW, updated_at: NOW,
        },
        recipe: foreignRecipe,
        expected_recipe: foreignRecipe,
      });
      assert.equal(foreignCreated.outcome, "applied");

      const foreignId = await f.store.observeWorkItem({
        expected_item: f.item,
        item: {
          ...f.item,
          id: "foreign-work-id",
          unit_key: "new-unit",
          status: "open",
          current_run_id: undefined,
          version: 0,
          acknowledged_run_id: undefined,
        },
      });
      assert.deepEqual(foreignId, { outcome: "conflict", reason: "work_exists" });
      const staleObservation = await f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, thread_facet: "changed-elsewhere", updated_at: LATER },
      });
      assert.equal(staleObservation.outcome, "applied");
      const stale = staleObservation.item;
      const staleResult = await f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, record_class: "message" },
      });
      assert.deepEqual(staleResult, { outcome: "conflict", reason: "stale_work" });
      const updated = await f.store.observeWorkItem({
        expected_item: stale,
        item: { ...stale, thread_facet: "ticket-updated", updated_at: LATER },
      });
      assert.equal(updated.outcome, "applied");
      assert.equal(updated.item.version, stale.version + 1);
      assert.equal(updated.item.status, stale.status);
      assert.equal(updated.item.current_run_id, stale.current_run_id);
      const created = await f.store.observeWorkItem({
        expected_item: updated.item,
        item: {
          ...updated.item,
          id: "work-next-unit",
          unit_key: "next-event",
          status: "open",
          current_run_id: undefined,
          version: 0,
          acknowledged_run_id: undefined,
          created_at: LATER,
          updated_at: LATER,
        },
      });
      assert.equal(created.outcome, "applied");
      assert.equal(created.item.id, "work-next-unit");
      assert.equal(created.item.version, 0);
      assert.deepEqual(await f.store.getWorkItem(ORG, created.item.id), created.item);
      let events;
      if (driver.name === "memory") {
        events = f.store.listWorkItemObservationEvents();
      } else if (driver.name === "postgres") {
        events = (await f.query(`SELECT aggregate_id, aggregate_version, event_type, payload_json::text AS payload_json
          FROM conversation_lifecycle_events WHERE org_id = $1
            AND event_type = 'work_item_transitioned' ORDER BY aggregate_id`, [ORG])).rows;
      } else {
        const db = new Database(f.path, { readonly: true });
        try {
          events = db.prepare(`SELECT aggregate_id, aggregate_version, event_type, payload_json
            FROM conversation_lifecycle_events WHERE org_id = ?
              AND event_type = 'work_item_transitioned' ORDER BY aggregate_id`)
            .all(ORG);
        } finally {
          db.close();
        }
      }
      assert.equal(events.length, 3);
      assert.ok(events.every((event) => event.event_type === "work_item_transitioned"));
    });

    it("does not observe a work item without a durable current-work trigger", async (t) => {
      const f = await fixture(t, driver);
      const result = await f.store.observeWorkItem({
        expected_item: null,
        item: {
          ...f.item,
          id: "work-with-missing-trigger",
          unit_key: "missing-trigger",
          head_event_id: "missing-event",
          status: "open",
          current_run_id: undefined,
          acknowledged_run_id: undefined,
          version: 0,
          created_at: LATER,
          updated_at: LATER,
        },
      });
      assert.deepEqual(result, {
        outcome: "conflict",
        reason: "trigger_not_current_work",
      });
      assert.equal(await f.store.getWorkItem(ORG, "work-with-missing-trigger"), null);
    });

    it("rejects a new start carrying an execution result without reserving work", async (t) => {
      const f = await fixture(t, driver, {}, false, { startRun: false });
      await assert.rejects(f.store.claimWorkRunStart({
        expected_item: f.item,
        run: { ...f.run, result: { summary: "Old attempt result" } },
      }), /cannot include an execution result/);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.equal(await f.store.getWorkRun(ORG, f.run.id), null);
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: f.item, run: f.run,
      }), true);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).result, undefined);
    });

    it("acknowledges only the exact completed run after required write-back is sent, and replays idempotently", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      let item = await f.store.getWorkItem(ORG, f.item.id);
      const currentRun = await f.store.getWorkRun(ORG, f.run.id);
      let delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const command = {
        expected_item: item, run_id: f.run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: currentRun.version,
        command_id: "ack-command-1", issued_at: LATER, now: LATER,
      };
      assert.deepEqual(await f.store.acknowledgeWorkResult(command),
        { outcome: "conflict", reason: "not_acknowledgeable" });
      const claimed = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "worker-1", now: LATER,
      });
      const sent = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "sent", owner: "worker-1",
        token: claimed.delivery.claim_token, now: LATER,
      });
      assert.equal(sent.delivery.status, "acked");
      assert.equal(sent.delivery.write_back, "sent");
      item = await f.store.getWorkItem(ORG, f.item.id);
      const acknowledgment = { ...command, expected_item: item, expected_version: item.version };
      const applied = await f.store.acknowledgeWorkResult(acknowledgment);
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.item.acknowledged_run_id, f.run.id);
      assert.equal(applied.item.version, item.version + 1);
      if (driver.name !== "memory") {
        assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "outside_current_work");
        const pref = await f.store.getConversationPref(ORG, item.thread_id);
        assert.equal(pref.hidden, true);
        assert.equal(pref.hidden_reason, "policy");
        assert.equal((await f.store.listInbox(ORG, { disposition: "current_work" })).some((row) =>
          row.event.id === item.head_event_id), false);
      }
      const replayed = await f.store.acknowledgeWorkResult(acknowledgment);
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.item.id, applied.item.id);
      assert.equal(replayed.item.acknowledged_run_id, f.run.id);
      const ordinaryWrite = await f.store.getWorkItem(ORG, f.item.id);
      assert.deepEqual(ordinaryWrite, applied.item);
      assert.deepEqual(await f.store.acknowledgeWorkResult({
        ...acknowledgment, expected_version: acknowledgment.expected_version + 1,
      }), { outcome: "conflict", reason: "command_conflict" });
      assert.deepEqual(await f.store.acknowledgeWorkResult({
        ...acknowledgment, command_id: "ack-command-stale-run",
        expected_run_version: acknowledgment.expected_run_version + 1,
      }), { outcome: "conflict", reason: "stale_result" });
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: ordinaryWrite, expected_version: ordinaryWrite.version,
        retry: "manual",
        run: {
          id: "run-2", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
          executor_type: "test", status: "running", start_state: "pending",
          created_at: LATER, updated_at: LATER,
        },
      }), true);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).acknowledged_run_id, undefined);
    });

    it("does not policy-hide a thread while another current-work trigger remains", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      const otherEventId = "other-work-trigger";
      if (driver.name === "memory") {
        f.store.recordCurrentWorkEvidence(otherEventId);
      } else {
        await f.store.append({
          id: otherEventId, org_id: ORG, source: "source", external_id: otherEventId,
          content_hash: "b".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
          thread_id: f.item.thread_id, occurred_at: NOW, expected_head_id: null,
        });
        await f.store.putDispositionIfAbsent({
          event_id: otherEventId, org_id: ORG, disposition: "current_work",
          layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
        });
      }
      const recipe = await f.store.getRecipe(ORG, f.recipe.id);
      assert.ok(recipe);
      assert.equal((await f.store.createWorkItem({
        item: {
          id: "other-work", org_id: ORG, thread_id: f.item.thread_id,
          unit_key: otherEventId, head_event_id: otherEventId,
          record_class: "task", thread_facet: "ticket", status: "open",
          recipe_id: recipe.id, created_at: NOW, updated_at: NOW,
        },
        recipe,
        expected_recipe: recipe,
      })).outcome, "applied");
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const claim = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "worker-1", now: LATER,
      });
      await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "sent",
        owner: "worker-1", token: claim.delivery.claim_token, now: LATER,
      });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const acknowledged = await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version ?? 0,
        command_id: "ack-command-with-other-work", issued_at: LATER, now: LATER,
      });
      assert.equal(acknowledged.outcome, "applied");
      if (driver.name !== "memory") {
        const pref = await f.store.getConversationPref(ORG, item.thread_id);
        assert.equal(pref?.hidden ?? false, false);
        assert.equal((await f.store.getDisposition(otherEventId)).disposition, "current_work");
      }
    });

    it("does not policy-hide a thread after manual visibility changes since run reservation", async (t) => {
      if (driver.name === "memory") return;
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.setConversationVisibility({
        org_id: ORG, thread_id: f.item.thread_id, hidden: false,
        expected_version: 0, updated_at: LATER,
      });
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const claim = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "worker-1", now: LATER,
      });
      await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "sent",
        owner: "worker-1", token: claim.delivery.claim_token, now: LATER,
      });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const acknowledged = await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version ?? 0,
        command_id: "ack-command-after-manual-visibility", issued_at: LATER, now: LATER,
      });
      assert.equal(acknowledged.outcome, "applied");
      const pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.hidden, false);
      assert.equal(pref.hidden_reason, null);
      assert.equal(pref.visibility_version, 1);
    });

    it("acknowledges the exact failed result and prevents automatic retry", async (t) => {
      const f = await fixture(t, driver);
      const failed = await f.store.commitWorkObservation({
        ...f.input,
        handle: {
          external_run_id: "external-1", status: "failed",
          result: { summary: "Execution failed" },
        },
      });
      assert.equal(failed.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal(item.status, "failed");
      assert.equal(run.status, "failed");
      const acknowledgment = {
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version ?? 0,
        command_id: "ack-command-failed-run", issued_at: LATER, now: LATER,
      };
      const acknowledged = await f.store.acknowledgeWorkResult(acknowledgment);
      assert.equal(acknowledged.outcome, "applied");
      assert.equal(acknowledged.item.status, "failed");
      assert.equal(acknowledged.item.acknowledged_run_id, run.id);
      assert.equal((await f.store.acknowledgeWorkResult(acknowledgment)).outcome, "replayed");
      if (driver.name !== "memory") {
        assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "outside_current_work");
      }
      const automatic = await f.store.claimWorkRunStart({
        expected_item: acknowledged.item, expected_version: acknowledged.item.version,
        retry: "automatic",
        run: {
          id: "run-auto-after-failure-ack", org_id: ORG, work_item_id: item.id,
          recipe_id: f.recipe.id, executor_type: "test", status: "running",
          start_state: "pending", created_at: LATER, updated_at: LATER,
        },
      });
      assert.equal(automatic, false);
      const manualRun = {
        id: "run-manual-after-failure-ack", org_id: ORG, work_item_id: item.id,
        recipe_id: f.recipe.id, executor_type: "test", status: "running",
        start_state: "pending", created_at: LATER, updated_at: LATER,
      };
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: acknowledged.item, expected_version: acknowledged.item.version,
        retry: "manual", run: manualRun,
      }), true);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, undefined);
    });

    it("audits delivery claims, accepted receipts and settlements without storing claim tokens", async (t) => {
      const f = await fixture(t, driver);
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const claimed = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "worker-1", now: LATER,
      });
      assert.equal(claimed.outcome, "applied");
      const renewed = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "renew",
        owner: "worker-1", token: claimed.delivery.claim_token, now: "2026-11-09T08:01:30.000Z",
      });
      assert.equal(renewed.outcome, "applied");
      assert.equal((await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "receipt",
        owner: "worker-1", token: claimed.delivery.claim_token,
        receipt: { accepted: true, rpc_id: "receipt-1" }, now: "2026-11-09T08:01:31.000Z",
      })).outcome, "applied");
      assert.equal((await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "sent",
        owner: "worker-1", token: claimed.delivery.claim_token, now: "2026-11-09T08:01:32.000Z",
      })).outcome, "applied");
      let events;
      if (driver.name === "memory") {
        events = f.store.listWorkDeliveryLifecycleEvents();
      } else if (driver.name === "postgres") {
        events = (await f.query(`SELECT aggregate_version, event_type, payload_json::text AS payload_json
          FROM conversation_lifecycle_events WHERE org_id = $1 AND aggregate_type = 'work_delivery'
          ORDER BY aggregate_version`, [ORG])).rows;
      } else {
        const db = new Database(f.path, { readonly: true });
        try {
          events = db.prepare(`SELECT aggregate_version, event_type, payload_json
            FROM conversation_lifecycle_events WHERE org_id = ? AND aggregate_type = 'work_delivery'
            ORDER BY aggregate_version`).all(ORG);
        } finally {
          db.close();
        }
      }
      const transitions = events.filter((event) => event.event_type !== "delivery_created");
      assert.deepEqual(transitions.map((event) => event.event_type), [
        "delivery_claimed", "delivery_transitioned", "delivery_transitioned",
      ]);
      assert.deepEqual(transitions.map((event) => event.aggregate_version), [1, 2, 3]);
      assert.equal(transitions.some((event) =>
        JSON.stringify(event.payload ?? event.payload_json).includes(claimed.delivery.claim_token)), false);
    });

    it("refuses to remove an item after a run reservation", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      const created = await f.store.createWorkItem(input);
      assert.equal(created.outcome, "applied");
      const run = {
        ...f.run, id: "created-run", work_item_id: created.item.id, recipe_id: created.recipe.id,
        status: "running", start_state: "pending", created_at: LATER, updated_at: LATER,
      };
      assert.equal(await f.store.claimWorkRunStart({ expected_item: created.item, run }), true);
      const reserved = await f.store.getWorkItem(ORG, created.item.id);
      assert.deepEqual(await f.store.abortWorkItemCreation({
        expected_item: created.item, expected_search_answer: created.search_answer,
      }), { outcome: "conflict", reason: "stale_work" });
      assert.deepEqual(await f.store.getWorkItem(ORG, created.item.id), reserved);
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, created.search_answer.id), created.search_answer);
    });

    it("preserves changed answer metadata when aborting a stale prepared snapshot", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      const created = await f.store.createWorkItem(input);
      const changed = await f.store.putSearchAnswer({ ...created.search_answer, query: "Edited question" });
      assert.deepEqual(await f.store.abortWorkItemCreation({
        expected_item: created.item, expected_search_answer: created.search_answer,
      }), { outcome: "conflict", reason: "stale_search_answer" });
      assert.deepEqual(await f.store.getWorkItem(ORG, created.item.id), created.item);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, created.search_answer.id), changed);
    });

    it("creates answer metadata, work and recipe together and returns persisted snapshots", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      const result = await f.store.createWorkItem(input);
      assert.equal(result.outcome, "applied");
      assert.deepEqual(result.item, await f.store.getWorkItem(ORG, input.item.id));
      assert.deepEqual(result.recipe, await f.store.getRecipe(ORG, input.recipe.id));
      assert.deepEqual(result.search_answer, await f.store.getSearchAnswer(ORG, input.search_answer.id));
      const saved = structuredClone(result);
      result.search_answer.event_ids.push("mutated");
      input.search_answer.query = "Mutated input";
      await f.reopen();
      assert.deepEqual(await f.store.getSearchAnswer(ORG, saved.search_answer.id), saved.search_answer);
      assert.deepEqual(await f.store.getWorkItem(ORG, saved.item.id), saved.item);
      assert.deepEqual(await f.store.getRecipe(ORG, saved.recipe.id), saved.recipe);
      assert.deepEqual(await f.store.listWorkRuns(ORG, saved.item.id), []);
    });

    it("atomically advances answer stages with fenced source snapshots and survives reopen", async (t) => {
      const f = await fixture(t, driver, { write_back_required: false });
      const previous = await f.store.putSearchAnswer({
        id: "staged-answer", org_id: ORG, work_item_id: f.item.id,
        query: "Question", event_ids: ["event-1", "event-2"], created_at: NOW, updated_at: NOW,
        scope: {
          intent: "aggregate", complete: true, total_count: 2, included_count: 2, omitted_count: 0,
          map_reduce: {
            strategy: "map_reduce", phase: "mapping", snapshot_id: "snapshot",
            batch_offsets: [0, 1, 2], completed_batches: 0, total_batches: 2, facts: [],
          },
        },
      });
      const observed = await f.store.commitWorkObservation(f.input);
      assert.equal(observed.outcome, "applied");
      const [completedItem, completedRun] = await Promise.all([
        f.store.getWorkItem(ORG, f.item.id), f.store.getWorkRun(ORG, f.run.id),
      ]);
      assert.equal(completedItem.status, "done");
      const input = creationInput(f);
      input.search_answer = {
        ...previous, work_item_id: input.item.id, updated_at: LATER,
        scope: {
          ...previous.scope,
          map_reduce: { ...previous.scope.map_reduce, completed_batches: 1 },
        },
      };
      input.search_answer_transition = {
        expected_answer: previous, expected_item: completedItem, expected_run: completedRun,
      };
      assert.deepEqual(await f.store.createWorkItem({
        ...input, search_answer_transition: {
          ...input.search_answer_transition,
          expected_run: { ...completedRun, version: completedRun.version + 1 },
        },
      }), { outcome: "conflict", reason: "stale_search_answer" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, previous.id), previous);
      const saved = await f.store.createWorkItem(input);
      assert.equal(saved.outcome, "applied");
      assert.equal(saved.search_answer.work_item_id, saved.item.id);
      await f.reopen();
      assert.deepEqual(await f.store.getSearchAnswer(ORG, previous.id), saved.search_answer);
      assert.deepEqual(await f.store.getWorkItem(ORG, saved.item.id), saved.item);
      assert.deepEqual(await f.store.listWorkRuns(ORG, saved.item.id), []);
      await assert.rejects(f.store.putSearchAnswer(previous), /identity|outcome/);
    });

    for (const orgId of [ORG, "other-org"]) {
      it(`never overwrites an answer ID already owned by ${orgId}`, async (t) => {
        const f = await fixture(t, driver);
        const input = answerCreationInput(f);
        let owner = f.item;
        if (orgId !== ORG) {
          await f.store.putRecipe({
            ...f.recipe, id: "foreign-answer-recipe", org_id: orgId, name: "Foreign answer recipe",
          });
          const recipe = await f.store.getRecipe(orgId, "foreign-answer-recipe");
          assert.ok(recipe);
          const created = await f.store.createWorkItem({
            item: {
              ...f.item, id: "foreign-answer-work", org_id: orgId,
              thread_id: "foreign-answer-thread", unit_key: "foreign-answer-unit",
              head_event_id: undefined, recipe_id: recipe.id, status: "open",
              current_run_id: undefined, version: 0,
              created_at: NOW, updated_at: NOW,
            },
            recipe,
            expected_recipe: recipe,
          });
          assert.equal(created.outcome, "applied");
          owner = created.item;
        }
        await f.store.putSearchAnswer({
          ...input.search_answer, org_id: orgId, work_item_id: owner.id, query: "Existing question",
        });
        const existing = await f.store.getSearchAnswer(orgId, input.search_answer.id);
        assert.deepEqual(await f.store.createWorkItem(input),
          { outcome: "conflict", reason: "search_answer_exists" });
        assert.deepEqual(await f.store.getSearchAnswer(orgId, input.search_answer.id), existing);
        assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
        assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
      });
    }

    it("does not create answer metadata when its work or recipe conflicts", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Concurrent configuration" } });
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getSearchAnswer(ORG, input.search_answer.id), null);
      input.item.id = f.item.id;
      input.search_answer.work_item_id = f.item.id;
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.equal(await f.store.getSearchAnswer(ORG, input.search_answer.id), null);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });

    it("fences competing answer creation without leaking the losing work or recipe", async (t) => {
      const f = await fixture(t, driver);
      const input = answerCreationInput(f);
      const other = {
        ...input,
        item: { ...input.item, id: "other-answer-work", recipe_id: "other-answer-recipe", unit_key: "other-answer-unit" },
        recipe: { ...input.recipe, id: "other-answer-recipe" },
        search_answer: { ...input.search_answer, work_item_id: "other-answer-work" },
      };
      const results = await Promise.all([input, other].map((candidate) => f.store.createWorkItem(candidate)));
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      const winner = results.find((result) => result.outcome === "applied");
      const loser = results[0].outcome === "applied" ? other : input;
      assert.equal(await f.store.getWorkItem(ORG, loser.item.id), null);
      assert.equal(await f.store.getRecipe(ORG, loser.recipe.id), null);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, input.search_answer.id), winner.search_answer);
    });

    it("atomically creates a work item and its recipe and returns saved snapshots", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const result = await f.store.createWorkItem(input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.version, 0);
      assert.equal(result.item.current_run_id, undefined);
      assert.deepEqual(result.item, await f.store.getWorkItem(ORG, input.item.id));
      assert.deepEqual(result.recipe, await f.store.getRecipe(ORG, input.recipe.id));
      const saved = structuredClone(result);
      result.recipe.executor_config.changed = true;
      result.item.status = "skipped";
      await f.reopen();
      assert.deepEqual(await f.store.getWorkItem(ORG, input.item.id), saved.item);
      assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), saved.recipe);
      assert.deepEqual(await f.store.listWorkRuns(ORG, input.item.id), []);
    });

    it("never overwrites existing work or its recipe when creation repeats", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f, {
        item: { ...f.item, status: "open", current_run_id: undefined, version: 0 },
      });
      input.recipe.id = f.recipe.id;
      input.expected_recipe = await f.store.getRecipe(ORG, f.recipe.id);
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getRecipe(ORG, f.recipe.id), input.expected_recipe);
    });

    it("compares the recipe snapshot before applying a configuration change", async (t) => {
      const f = await fixture(t, driver);
      const expected = await f.store.getRecipe(ORG, f.recipe.id);
      const input = creationInput(f, {
        recipe: { ...expected, executor_config: { prompt: "New instruction" }, created_at: LATER, updated_at: LATER },
        expected_recipe: expected,
      });
      input.item.recipe_id = f.recipe.id;
      const result = await f.store.createWorkItem(input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.recipe.created_at, expected.created_at);
      assert.equal(result.recipe.updated_at, LATER);
      assert.deepEqual(result.recipe.executor_config, { prompt: "New instruction" });
      assert.deepEqual(result.recipe, await f.store.getRecipe(ORG, f.recipe.id));
      const stale = { ...input, item: { ...input.item, id: "stale-work" } };
      stale.recipe = { ...input.recipe, executor_config: { prompt: "Stale update" } };
      assert.deepEqual(await f.store.createWorkItem(stale), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, stale.item.id), null);
      assert.deepEqual(await f.store.getRecipe(ORG, f.recipe.id), result.recipe);
    });

    it("does not create a replacement recipe when the requested item ID already exists", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      input.item.id = f.item.id;
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });

    it("reuses equivalent concurrent recipe creation without changing its timestamps", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const first = await f.store.createWorkItem(input);
      assert.equal(first.outcome, "applied");
      const second = await f.store.createWorkItem({
        ...input, item: { ...input.item, id: "another-created-work", unit_key: "another-created-unit" },
        recipe: { ...input.recipe, created_at: NOW, updated_at: NOW },
      });
      assert.equal(second.outcome, "applied");
      assert.deepEqual(second.recipe, first.recipe);
      assert.deepEqual(second.recipe, await f.store.getRecipe(ORG, input.recipe.id));
    });

    it("rejects a conflicting newly created or removed recipe without leaving work", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Competing config" } });
      const saved = await f.store.getRecipe(ORG, input.recipe.id);
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      await f.store.deleteRecipe(ORG, input.recipe.id);
      assert.deepEqual(await f.store.createWorkItem({ ...input, expected_recipe: saved }),
        { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      assert.equal(await f.store.getRecipe(ORG, input.recipe.id), null);
    });

    it("does not claim work or recipe IDs belonging to another organization", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      await f.store.putRecipe({ ...input.recipe, org_id: "other-org" });
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "stale_recipe" });
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      const foreignRecipe = await f.store.getRecipe("other-org", input.recipe.id);
      assert.ok(foreignRecipe);
      const foreignCreated = await f.store.createWorkItem({
        item: {
          ...input.item, org_id: "other-org", recipe_id: foreignRecipe.id,
          head_event_id: undefined,
        },
        recipe: foreignRecipe,
        expected_recipe: foreignRecipe,
      });
      assert.equal(foreignCreated.outcome, "applied");
      const foreign = foreignCreated.item;
      assert.deepEqual(await f.store.createWorkItem(input), { outcome: "conflict", reason: "work_exists" });
      assert.deepEqual(await f.store.getWorkItem("other-org", input.item.id), foreign);
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
    });

    it("allows only one creation for the same item and keeps the winning recipe", async (t) => {
      const f = await fixture(t, driver);
      const input = creationInput(f);
      const results = await Promise.all([input, {
        ...input, recipe: { ...input.recipe, executor_config: { prompt: "Other instruction" } },
      }].map((candidate) => f.store.createWorkItem(candidate)));
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      const winner = results.find((result) => result.outcome === "applied");
      assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), winner.recipe);
      assert.deepEqual(await f.store.getWorkItem(ORG, input.item.id), winner.item);
    });

    it("atomically persists a timeout cause with local dismissal and delivery stops", async (t) => {
      const f = await timeoutFixture(t, driver);
      const delivery = await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const result = await f.store.dismissWorkItem(f.timeout);
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.version, f.item.version + 1);
      assert.equal(result.item.current_run_id, f.run.id);
      assert.deepEqual(result.run, f.run);
      assert.deepEqual(result.search_answer, { ...f.record, outcome: "timed_out", updated_at: LATER });
      assert.equal(result.deliveries[0].id, delivery.id);
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      const saved = structuredClone(result);
      result.search_answer.event_ids.push("mutated");
      result.item.status = "done";
      await f.reopen();
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), saved.search_answer);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), saved.deliveries[0]);
      assert.deepEqual(await f.store.dismissWorkItem({
        ...f.timeout, expected_item: saved.item,
      }), { outcome: "conflict", reason: "stale_search_answer" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
    });

    it("preserves a committed timeout against ordinary stale writes and foreign IDs", async (t) => {
      const f = await timeoutFixture(t, driver);
      await assert.rejects(f.store.putSearchAnswer({ ...f.record, outcome: "timed_out" }),
        /identity and outcome cannot be changed/);
      await assert.rejects(f.store.putSearchAnswer({ ...f.record, org_id: "other-org" }),
        /identity and outcome cannot be changed/);
      await assert.rejects(f.store.putSearchAnswer({ ...f.record, work_item_id: "another-item" }),
        /identity and outcome cannot be changed/);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
      const dismissed = await f.store.dismissWorkItem(f.timeout);
      assert.equal(dismissed.outcome, "applied");
      await assert.rejects(f.store.putSearchAnswer(f.record),
        /identity and outcome cannot be changed/);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), dismissed.search_answer);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      const replay = await f.store.putSearchAnswer(dismissed.search_answer);
      assert.deepEqual(replay, dismissed.search_answer);
      await f.reopen();
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), dismissed.search_answer);
    });

    it("serializes timeout against a concurrent ordinary answer update", async (t) => {
      const f = await timeoutFixture(t, driver);
      const [timeout, update] = await Promise.allSettled([
        f.store.dismissWorkItem(f.timeout),
        f.store.putSearchAnswer({ ...f.record, query: "Updated question" }),
      ]);
      assert.equal(timeout.status, "fulfilled");
      const record = await f.store.getSearchAnswer(ORG, f.record.id);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      if (timeout.value.outcome === "applied") {
        assert.equal(update.status, "rejected");
        assert.match(update.reason.message, /identity and outcome cannot be changed/);
        assert.equal(record.outcome, "timed_out");
        assert.equal(record.query, f.record.query);
        assert.equal(item.status, "skipped");
      } else {
        assert.deepEqual(timeout.value, { outcome: "conflict", reason: "stale_search_answer" });
        assert.equal(update.status, "fulfilled");
        assert.equal(record.query, "Updated question");
        assert.equal(record.outcome, undefined);
        assert.deepEqual(item, f.item);
      }
    });

    for (const change of ["deleted", "query", "events"]) {
      it(`rejects a ${change} search answer snapshot without dismissing its work`, async (t) => {
        const f = await timeoutFixture(t, driver);
        if (change === "deleted") {
          await f.store.deleteSearchAnswer(ORG, f.record.id);
        } else {
          await f.store.putSearchAnswer({
            ...f.record,
            ...(change === "query" ? { query: "A new question" } : {}),
            ...(change === "events" ? { event_ids: ["event-2"] } : {}),
          });
        }
        const record = await f.store.getSearchAnswer(ORG, f.record.id);
        assert.deepEqual(await f.store.dismissWorkItem(f.timeout), { outcome: "conflict", reason: "stale_search_answer" });
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
        assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), record);
      });
    }

    it("rejects foreign timeout metadata before any local write", async (t) => {
      const f = await timeoutFixture(t, driver);
      await assert.rejects(f.store.dismissWorkItem({
        ...f.timeout, search_answer_timeout: { ...f.record, org_id: "other-org" },
      }), /must belong/);
      await assert.rejects(f.store.dismissWorkItem({
        ...f.timeout, search_answer_timeout: { ...f.record, work_item_id: "other-item" },
      }), /must belong/);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
    });

    for (const status of ["completed", "failed", "cancelled"]) {
      it(`does not timeout a current Run already observed as ${status}`, async (t) => {
        const f = await timeoutFixture(t, driver);
        const run = await seedLegacyRunStatus(f, driver, status);
        assert.deepEqual(await f.store.dismissWorkItem(f.timeout),
          { outcome: "conflict", reason: "inactive_search_answer" });
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
        assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
      });
    }

    it("fences a timeout against a concurrent human cancellation without rewriting its cause", async (t) => {
      const f = await timeoutFixture(t, driver);
      const [timeout, cancel] = await Promise.all([
        f.store.dismissWorkItem(f.timeout),
        f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
      ]);
      assert.equal(Number(timeout.outcome === "applied") + Number(cancel.outcome === "applied"), 1);
      const answer = await f.store.getSearchAnswer(ORG, f.record.id);
      assert.equal(answer.outcome, timeout.outcome === "applied" ? "timed_out" : undefined);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    });

    it("atomically dismisses work and stops all unresolved deliveries without rewriting runs", async (t) => {
      const f = await fixture(t, driver);
      const observed = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, result: { summary: "Previous result" } },
      });
      assert.equal(observed.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.ok(delivery);
      const result = await f.store.dismissWorkItem({ expected_item: item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.version, item.version + 1);
      assert.equal(result.item.current_run_id, f.run.id);
      assert.deepEqual(result.run, run);
      assert.equal(result.deliveries[0].id, delivery.id);
      assert.equal(result.deliveries[0].status, "acked");
      assert.equal(result.deliveries[0].write_back, "skipped");
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      const saved = structuredClone(result);
      result.item.unit_key = "changed";
      result.run.result = { summary: "changed" };
      result.deliveries[0].payload.summary = "changed";
      await f.reopen();
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), saved.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), saved.deliveries[0]);
    });

    it("preserves completed results while stopping both current and historical delivery attempts", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      f.input.handle.result = { summary: "Completed result" };
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const completed = await f.store.getWorkRun(ORG, f.run.id);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const historical = await seedLegacyWorkRun(f, driver, {
        ...completed, id: "historical-run", status: "failed", result: { summary: "Historical result" },
      });
      const rows = [await f.store.getWorkDeliveryByItem(ORG, item.id)];
      rows.push(await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: item.unit_key, run_id: historical.id, target: TARGET,
        payload: { summary: historical.result.summary }, now: NOW,
      })));
      const result = await f.store.dismissWorkItem({ expected_item: item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.deliveries.length, 2);
      assert.equal(result.item.current_run_id, completed.id);
      assert.deepEqual(result.run, completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, completed.id), completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, historical.id), historical);
      for (const row of rows) {
        const stopped = await f.store.getWorkDelivery(ORG, row.id);
        assert.equal(stopped.status, "acked");
        assert.equal(stopped.write_back, "skipped");
        assert.deepEqual(stopped.payload, row.payload);
        assert.deepEqual(stopped.target, row.target);
        assert.equal(stopped.idempotency_key, row.idempotency_key);
        assert.equal(stopped.run_id, row.run_id);
      }
      assert.deepEqual(await f.store.dismissWorkItem({ expected_item: item, now: LATER }),
        { outcome: "conflict", reason: "stale_dismissal" });
    });

    it("preserves an in-flight claim and accepts its late receipt after dismissal", async (t) => {
      const f = await fixture(t, driver);
      const observed = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, result: { summary: "Previous result" } },
      });
      assert.equal(observed.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.ok(delivery);
      const claim = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "sender", now: NOW,
      });
      assert.equal(claim.outcome, "applied");
      const result = await f.store.dismissWorkItem({ expected_item: item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.deliveries[0].status, "write_back");
      assert.equal(result.deliveries[0].claim_token, claim.delivery.claim_token);
      assert.equal(result.deliveries[0].cancel_requested_at, LATER);
      const receipt = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "receipt", owner: "sender",
        token: claim.delivery.claim_token, now: LATER, receipt: { accepted: true, rpc_id: "accepted" },
      });
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.delivery.channel_receipt.rpc_id, "accepted");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "skipped");
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), observed.transition.run);
    });

    it("does not dismiss a successor or change delivery when an old item snapshot is stale", async (t) => {
      const f = await fixture(t, driver);
      const observed = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, result: { summary: "Previous result" } },
      });
      assert.equal(observed.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.ok(delivery);
      const currentObservation = await f.store.observeWorkItem({
        expected_item: item,
        item: { ...item, thread_facet: "ticket-updated", updated_at: LATER },
      });
      assert.equal(currentObservation.outcome, "applied");
      const current = currentObservation.item;
      assert.deepEqual(await f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
        { outcome: "conflict", reason: "stale_dismissal" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), current);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
    });

    it("fences competing retry and dismissal and supports unstarted work", async (t) => {
      const f = await fixture(t, driver);
      const item = await observeWorkAsTestState(f, "failed");
      const [dismissed, started] = await Promise.all([
        f.store.dismissWorkItem({ expected_item: item, now: LATER }),
        f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "successor", status: "running", start_state: "pending" },
        }),
      ]);
      assert.equal(Number(dismissed.outcome === "applied") + Number(started), 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      const recipe = await f.store.getRecipe(ORG, f.recipe.id);
      assert.ok(recipe);
      const unstarted = await f.store.createWorkItem({
        item: {
          ...f.item, id: "unstarted", unit_key: "unstarted", status: "open",
          current_run_id: undefined, version: 0, acknowledged_run_id: undefined,
          recipe_id: recipe.id, created_at: NOW, updated_at: NOW,
        },
        recipe,
        expected_recipe: recipe,
      });
      assert.equal(unstarted.outcome, "applied");
      const result = await f.store.dismissWorkItem({ expected_item: unstarted.item, now: LATER });
      assert.equal(result.outcome, "applied");
      assert.equal(result.run, null);
      assert.equal(result.item.status, "skipped");
      assert.equal(result.item.current_run_id, undefined);
      assert.deepEqual(result.deliveries, []);
    });

    for (const mode of ["automatic", "manual", "auxiliary"]) {
      it(`commits a ${mode} preflight failure and item version together`, async (t) => {
        const f = await fixture(t, driver, {}, true, { startRun: false });
        const oldRun = await seedLegacyWorkRun(f, driver, {
          ...f.run, status: "failed", start_state: undefined,
        });
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = {
          id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
          executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
          write_back_required: false, trigger_kind: "push", created_at: LATER, updated_at: LATER,
        };
        const result = await f.store.recordWorkRunStartFailure({ expected_item: item, run, mode });
        assert.equal(result.outcome, "applied");
        assert.equal(result.item.status, mode === "automatic" ? "failed" : item.status);
        assert.equal(result.item.current_run_id, mode === "automatic" ? run.id : item.current_run_id);
        assert.equal(result.item.version, item.version + 1);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), result.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), result.run);
        assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
        const saved = structuredClone(result);
        result.item.unit_key = "changed";
        result.run.result.summary = "changed";
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), saved.run);
        assert.deepEqual(await f.store.recordWorkRunStartFailure({ expected_item: item, run, mode }),
          { outcome: "conflict", reason: "stale_failure" });
      });
    }

    it("does not insert failure history over active runs, ignored work or unresolved delivery", async (t) => {
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "running", start_state: undefined });
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: f.item.id, recipe_id: f.item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const input = { expected_item: f.item, run, mode: "automatic" };
      assert.deepEqual(await f.store.recordWorkRunStartFailure(input), { outcome: "conflict", reason: "active_run" });
      const ignoredFixture = await fixture(t, driver, {}, true, { startRun: false });
      const ignored = await dismissWorkAsTestState(ignoredFixture);
      assert.deepEqual(await ignoredFixture.store.recordWorkRunStartFailure({
        ...input, expected_item: ignored,
      }), { outcome: "conflict", reason: "stale_failure" });
      assert.deepEqual(await ignoredFixture.store.getWorkItem(ORG, ignored.id), ignored);
      const g = await fixture(t, driver, {}, true, { startRun: false });
      const item = await g.store.getWorkItem(ORG, g.item.id);
      const delivery = await seedTestWorkDelivery(g, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id, kind: "push",
        unit_key: item.unit_key, payload: { summary: "Previous result" }, now: LATER,
      }));
      assert.deepEqual(await g.store.recordWorkRunStartFailure({
        ...input, expected_item: item, run: { ...run, work_item_id: item.id },
      }), { outcome: "conflict", reason: "unresolved_delivery" });
      assert.deepEqual(await g.store.getWorkItem(ORG, item.id), item);
      assert.deepEqual(await g.store.getWorkDelivery(ORG, delivery.id), delivery);
      assert.equal(await g.store.getWorkRun(ORG, run.id), null);
    });

    it("allows only one failure or real start against a selected snapshot", async (t) => {
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const [failure, started] = await Promise.all([
        f.store.recordWorkRunStartFailure({ expected_item: item, run, mode: "manual" }),
        f.store.claimWorkRunStart({
          expected_item: item, run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
        }),
      ]);
      assert.equal(Number(failure.outcome === "applied") + Number(started), 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      assert.equal((await f.store.listWorkRuns(ORG, item.id)).length, 2);
    });

    it("preserves a completed item and result when a trial's selected rule fails preflight", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = { summary: "Original result" };
      f.input.can_write_back = false;
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const completed = await f.store.getWorkRun(ORG, f.run.id);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      await f.store.putRecipe({ ...f.recipe, id: "trial-rule" });
      const run = {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: "trial-rule",
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const result = await f.store.recordWorkRunStartFailure({
        expected_item: item, run, mode: "manual", rebind: "manual",
      });
      assert.equal(result.outcome, "applied");
      assert.equal(result.item.status, "done");
      assert.equal(result.item.recipe_id, f.recipe.id);
      assert.equal(result.item.current_run_id, completed.id);
      assert.equal(result.item.version, item.version + 1);
      assert.deepEqual(await f.store.getWorkRun(ORG, completed.id), completed);
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), result.run);
    });

    it("rejects deleted rules and reused failure identities without touching work history", async (t) => {
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = {
        id: f.run.id, org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      };
      const input = { expected_item: item, run, mode: "automatic" };
      await assert.rejects(f.store.recordWorkRunStartFailure(input), /already exists/);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      await f.store.deleteRecipe(ORG, f.recipe.id);
      const current = await f.store.getWorkItem(ORG, item.id);
      const result = await f.store.recordWorkRunStartFailure({
        ...input, expected_item: { ...current, recipe_id: f.recipe.id },
        run: { ...run, id: "new-failure" },
      });
      assert.equal(result.outcome, "conflict");
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), current);
      assert.equal(await f.store.getWorkRun(ORG, "new-failure"), null);
    });

    for (const [status, intent] of [
      ["failed", "manual"], ["done", "manual"], ["skipped", "manual"],
      ["open", "automatic"], ["failed", "automatic"],
    ]) {
      it(`binds the selected rule only when the ${intent} ${status} start is reserved`, async (t) => {
        const f = await fixture(t, driver, {}, true, { startRun: status !== "open" });
        let item;
        if (status === "open") {
          await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
          item = await f.store.getWorkItem(ORG, f.item.id);
        } else {
          item = await observeWorkAsTestState(f, status === "skipped" ? "failed" : status);
          if (status === "skipped") item = await dismissWorkAsTestState(f);
        }
        const oldRun = await f.store.getWorkRun(ORG, f.run.id);
        const recipe = await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
        const run = { ...f.run, id: "trial-run", recipe_id: recipe.id, status: "running", start_state: "pending" };
        const input = { run, expected_item: item, retry: intent, rebind: intent };
        assert.equal(await f.store.claimWorkRunStart({ ...input, rebind: undefined }), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.claimWorkRunStart(input), true);
        const saved = await f.store.getWorkItem(ORG, item.id);
        assert.equal(saved.recipe_id, recipe.id);
        assert.equal(saved.status, "running");
        assert.equal(saved.current_run_id, run.id);
        assert.equal(saved.version, item.version + 1);
        assert.equal(saved.head_event_id, item.head_event_id);
        assert.equal((await f.store.getWorkRun(ORG, run.id)).recipe_id, recipe.id);
        assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved);
      });
    }

    it("does not rebind open work already owned by another rule through a manual trial", async (t) => {
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: item, retry: "manual", rebind: "manual",
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      const unbound = await seedLegacyUnboundWorkRecipe(f, driver, item.id);
      assert.ok(unbound);
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: unbound, retry: "manual", rebind: "manual",
      }), true);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).recipe_id, run.recipe_id);
    });

    it("checks capacity on the selected rule without changing the old binding", async (t) => {
      const f = await fixture(t, driver);
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const recipe = await f.store.getRecipe(ORG, "selected-rule");
      assert.ok(recipe);
      const occupied = await f.store.createWorkItem({
        item: {
          ...f.item, id: "occupied", unit_key: "occupied", recipe_id: recipe.id,
          status: "open", current_run_id: undefined, version: 0,
          created_at: NOW, updated_at: NOW,
        },
        recipe,
        expected_recipe: recipe,
      });
      assert.equal(occupied.outcome, "applied");
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: occupied.item,
        run: {
          id: "occupied-run", org_id: ORG, work_item_id: occupied.item.id,
          recipe_id: recipe.id, executor_type: "test", status: "running",
          start_state: "pending", created_at: LATER, updated_at: LATER,
        },
      }), true);
      const item = await observeWorkAsTestState(f, "failed");
      const oldRun = await f.store.getWorkRun(ORG, f.run.id);
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({
        run, expected_item: item, retry: "automatic", rebind: "automatic", max_concurrent: 1,
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
    });

    it("preserves the original binding on stale, active, missing-rule and unresolved-delivery conflicts", async (t) => {
      const active = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(active, driver, {
        ...active.run, status: "running", start_state: undefined,
      });
      await active.store.putRecipe({ ...active.recipe, id: "selected-rule" });
      const activeRun = { ...active.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      assert.equal(await active.store.claimWorkRunStart({
        run: activeRun, expected_item: active.item, retry: "manual", rebind: "manual",
      }), false, "Old live run blocks rebind");
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const run = { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" };
      const input = { run, expected_item: item, retry: "manual", rebind: "manual" };
      const itemUpdate = await f.store.observeWorkItem({
        expected_item: item,
        item: { ...item, updated_at: LATER },
      });
      assert.equal(itemUpdate.outcome, "applied");
      const newer = itemUpdate.item;
      assert.equal(await f.store.claimWorkRunStart(input), false);
      const current = { ...input, expected_item: newer };
      assert.equal(await f.store.claimWorkRunStart({
        ...current, run: { ...run, recipe_id: "missing-rule" },
      }), false);
      await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: item.unit_key, payload: { summary: "Old pending result" }, now: LATER,
      }));
      assert.equal(await f.store.claimWorkRunStart(current), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), newer);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
      assert.equal((await f.store.listWorkDeliveries(ORG))[0].status, "queued");
    });

    for (const [status, retry] of [
      ["failed", "automatic"], ["failed", "manual"], ["done", "manual"], ["skipped", "manual"],
    ]) {
      it(`reserves a ${retry} retry directly from ${status} with one item version change`, async (t) => {
        const f = await fixture(t, driver);
        let item;
        if (status === "skipped") {
          await observeWorkAsTestState(f, "failed", NOW);
          item = await dismissWorkAsTestState(f, NOW);
        } else {
          item = await observeWorkAsTestState(f, status, NOW);
        }
        const terminal = await f.store.getWorkRun(ORG, f.run.id);
        const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending", version: 0 };
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: item }), true);
        const saved = await f.store.getWorkItem(ORG, item.id);
        assert.equal(saved.status, "running");
        assert.equal(saved.version, item.version + 1);
        assert.equal(saved.current_run_id, run.id);
        assert.deepEqual(await f.store.getWorkRun(ORG, terminal.id), terminal);
        assert.equal((await f.store.getWorkRun(ORG, run.id)).version, 0);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), saved);
        assert.deepEqual(await f.store.getWorkRun(ORG, terminal.id), terminal);
      });
    }

    it("never revives ignored work from a stale failure or open snapshot", async (t) => {
      const f = await fixture(t, driver);
      const failed = await observeWorkAsTestState(f, "failed");
      const skipped = await dismissWorkAsTestState(f);
      const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending" };
      for (const retry of ["manual", "automatic"]) {
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: failed }), false);
        assert.equal(await f.store.claimWorkRunStart({ run, retry, expected_item: f.item }), false);
      }
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), skipped);
      assert.equal(await f.store.getWorkRun(ORG, run.id), null);
    });

    for (const status of ["open", "failed"]) {
      it(`rejects a stale ${status} version even with the same status, pointer and timestamp`, async (t) => {
        const f = await fixture(t, driver, {}, true, { startRun: status !== "open" });
        if (status === "open") {
          await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
        }
        const expected = status === "failed"
          ? await observeWorkAsTestState(f, "failed")
          : await f.store.getWorkItem(ORG, f.item.id);
        const update = await f.store.observeWorkItem({
          expected_item: expected,
          item: { ...expected, thread_facet: "updated-elsewhere", updated_at: LATER },
        });
        assert.equal(update.outcome, "applied");
        const newer = update.item;
        const input = {
          expected_item: expected, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        };
        assert.equal(await f.store.claimWorkRunStart(input), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), newer);
        assert.equal(await f.store.getWorkRun(ORG, input.run.id), null);
        assert.equal(await f.store.claimWorkRunStart({ ...input, expected_item: newer }), true);
      });
    }

    it("does not bypass missing retry intent, active attempts or unresolved historical deliveries", async (t) => {
      const f = await fixture(t, driver);
      const failed = await observeWorkAsTestState(f, "failed");
      const run = { ...f.run, id: "retry-run", status: "running", start_state: "pending" };
      const failedRun = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal(failedRun.status, "failed");
      assert.equal(await f.store.claimWorkRunStart({ run, expected_item: failed }), false);
      const activeFixture = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(activeFixture, driver, { ...activeFixture.run, status: "running" });
      const activeItem = await activeFixture.store.getWorkItem(ORG, activeFixture.item.id);
      assert.equal(await activeFixture.store.claimWorkRunStart({
        run: { ...run, work_item_id: activeItem.id }, expected_item: activeItem,
      }), false);
      for (const status of ["queued", "write_back", "dead", "uncertain"]) {
        const stateFixture = await fixture(t, driver);
        const completed = await stateFixture.store.commitWorkObservation({
          ...stateFixture.input,
          handle: { ...stateFixture.input.handle, result: { summary: "Old result" } },
        });
        assert.equal(completed.outcome, "applied");
        const stateItem = await stateFixture.store.getWorkItem(ORG, stateFixture.item.id);
        const delivery = await stateFixture.store.getWorkDeliveryByItem(ORG, stateItem.id);
        assert.ok(delivery);
        await setDeliveryStateForTest(stateFixture.store, delivery, status, status === "dead" ? "failed" : "pending");
        assert.equal(await stateFixture.store.claimWorkRunStart({
          run, retry: "manual", expected_item: stateItem,
        }), false);
        assert.deepEqual(await stateFixture.store.getWorkItem(ORG, stateItem.id), stateItem);
      }
      const settledFixture = await fixture(t, driver);
      const completed = await settledFixture.store.commitWorkObservation({
        ...settledFixture.input,
        handle: { ...settledFixture.input.handle, result: { summary: "Old result" } },
      });
      assert.equal(completed.outcome, "applied");
      const settledItem = await settledFixture.store.getWorkItem(ORG, settledFixture.item.id);
      const delivery = await settledFixture.store.getWorkDeliveryByItem(ORG, settledItem.id);
      assert.ok(delivery);
      await settleDeliveryAsSent(settledFixture.store, delivery);
      assert.equal(await settledFixture.store.claimWorkRunStart({
        run, retry: "manual", expected_item: settledItem,
      }), true);
    });

    it("serializes concurrent manual and automatic retries of one failed snapshot", async (t) => {
      const f = await fixture(t, driver);
      const item = await observeWorkAsTestState(f, "failed");
      const results = await Promise.all(["manual", "automatic"].map((retry) =>
        f.store.claimWorkRunStart({
          expected_item: item, retry,
          run: { ...f.run, id: `retry-${retry}`, status: "running", start_state: "pending" },
        })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await f.store.getWorkItem(ORG, item.id)).version, item.version + 1);
      assert.equal((await f.store.listWorkRuns(ORG, item.id)).length, 2);
    });

    it("preserves the failed status and pointer if retry capacity is full", async (t) => {
      const f = await fixture(t, driver);
      const item = await observeWorkAsTestState(f, "failed");
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: item, retry: "automatic", max_concurrent: 0,
        run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      assert.equal(await f.store.getWorkRun(ORG, "retry-run"), null);
    });

    it("checkpoints session binding and submission without changing frozen obligations", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      assert.equal(bound.outcome, "applied");
      assert.equal(bound.run.start_state, "pending");
      assert.equal(bound.run.version, input.expected_run.version + 1);
      assert.deepEqual(bound.item, input.expected_item);
      const submitted = await f.store.checkpointWorkRunStart({
        ...input, expected_run: bound.run, kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(submitted.outcome, "applied");
      assert.equal(submitted.run.start_state, "submitted");
      assert.equal(submitted.run.agent_thread_id, "executor:1");
      assert.deepEqual(submitted.run.write_back_target, TARGET);
      assert.equal(submitted.run.write_back_required, true);
      assert.equal(submitted.run.trigger_kind, "push");
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      await f.reopen();
      assert.deepEqual(await f.store.getWorkRun(ORG, submitted.run.id), submitted.run);
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: submitted.item, expected_run: submitted.run,
        handle: { ...f.input.handle, agent_thread_id: submitted.run.agent_thread_id },
      })).outcome, "applied");
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
    });

    it("binds a spawn that returned after dismissal and durably requests cancellation", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({
        expected_item: input.expected_item, now: LATER,
      });
      assert.equal(dismissed.outcome, "applied");
      const bound = await f.store.checkpointWorkRunStart({
        ...input,
        kind: "bound",
        external_run_id: "late-external",
        agent_thread_id: "executor:late",
      });
      assert.equal(bound.outcome, "applied");
      assert.equal(bound.cancellation_requested, true);
      assert.deepEqual(bound.item, dismissed.item);
      assert.equal(bound.run.start_state, "submitted");
      assert.equal(bound.run.external_run_id, "late-external");
      const [job] = await f.store.listCancellationJobs(ORG);
      assert.equal(job.run_id, f.run.id);
      assert.equal(job.status, "pending");

      const observed = await f.store.commitWorkObservation({
        ...f.input,
        expected_item: dismissed.item,
        expected_run: bound.run,
        handle: {
          ...f.input.handle,
          status: "completed",
          external_run_id: "late-external",
          agent_thread_id: "executor:late",
          result: { summary: "Completed after dismissal" },
        },
      });
      assert.equal(observed.outcome, "applied");
      assert.deepEqual(observed.transition.item, dismissed.item);
      assert.equal(observed.transition.run.status, "completed");
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      await f.reopen();
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), observed.transition.run);
      assert.equal((await f.store.listCancellationJobs(ORG))[0].status, "pending");
    });

    it("rejects startup checkpoints that change a bound execution identity", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      assert.equal(bound.outcome, "applied");
      for (const identity of [
        { external_run_id: "other-run", agent_thread_id: "executor:1" },
        { external_run_id: "external-1", agent_thread_id: "executor:other" },
      ]) {
        assert.deepEqual(await f.store.checkpointWorkRunStart({
          ...input, kind: "submitted", expected_run: bound.run, ...identity,
        }), { outcome: "conflict", reason: "execution_identity_mismatch" });
        assert.deepEqual(await f.store.getWorkRun(ORG, bound.run.id), bound.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, bound.item.id), bound.item);
      }
      assert.equal((await f.store.checkpointWorkRunStart({
        ...input, kind: "submitted", expected_run: bound.run, external_run_id: "external-1",
      })).outcome, "applied");
    });

    it("requires a confirmed start before accepting execution observations", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      assert.equal(bound.outcome, "applied");
      let checkpoint = bound;
      for (const state of ["pending", "uncertain"]) {
        if (state === "uncertain") {
          checkpoint = await f.store.checkpointWorkRunStart({
            ...input, expected_run: bound.run, kind: "uncertain", error: "Submission response lost",
          });
        }
        assert.equal(checkpoint.outcome, "applied");
        assert.equal(checkpoint.run.start_state, state);
        assert.deepEqual(await f.store.commitWorkObservation({
          ...f.input, expected_item: checkpoint.item, expected_run: checkpoint.run,
          handle: { ...f.input.handle, agent_thread_id: "executor:1" },
        }), { outcome: "conflict", reason: "execution_start_unconfirmed" });
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), checkpoint.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), checkpoint.item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      }
    });

    it("does not infer an execution identity from an observation of historical work", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const unknown = await seedLegacyStartState(f, driver, undefined);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_run: unknown,
      }), { outcome: "conflict", reason: "execution_identity_unknown" });
      assert.deepEqual(await f.store.getWorkRun(ORG, unknown.id), unknown);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);

      const agentOnly = await seedLegacyAgentThreadId(f, driver, unknown.id, "executor:known");
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_run: agentOnly,
        handle: { ...f.input.handle, agent_thread_id: undefined },
      }), { outcome: "conflict", reason: "execution_identity_unknown" });
      assert.deepEqual(await f.store.getWorkRun(ORG, unknown.id), agentOnly);
      const matched = await f.store.commitWorkObservation({
        ...f.input, expected_run: agentOnly,
        handle: { ...f.input.handle, agent_thread_id: "executor:known" },
      });
      assert.equal(matched.outcome, "applied");
      assert.equal(matched.transition.run.external_run_id, f.input.handle.external_run_id);
      assert.equal(matched.transition.run.agent_thread_id, agentOnly.agent_thread_id);
    });

    for (const kind of ["failed", "uncertain"]) {
      it(`atomically checkpoints ${kind} with the matching item status`, async (t) => {
        const { f, input } = await startCheckpointFixture(t, driver);
        const result = await f.store.checkpointWorkRunStart({ ...input, kind, error: "Start error" });
        assert.equal(result.outcome, "applied");
        assert.equal(result.run.status, kind === "failed" ? "failed" : "waiting_human");
        assert.equal(result.item.status, result.run.status);
        assert.equal(result.run.start_state, kind === "failed" ? undefined : "uncertain");
        assert.equal(result.run.version, input.expected_run.version + 1);
        assert.equal(result.item.version, input.expected_item.version + 1);
        assert.equal(result.item.current_run_id, result.run.id);
        assert.equal(result.run.result.summary, "Start error");
        assert.deepEqual(await f.store.getWorkRun(ORG, result.run.id), result.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, result.item.id), result.item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkRun(ORG, result.run.id), result.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, result.item.id), result.item);
      });
    }

    it("does not mistake a known external session for a definite pre-start failure", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:1",
      });
      const next = { ...input, expected_run: bound.run };
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...next, kind: "failed", error: "Not proven",
      }), { outcome: "conflict", reason: "start_closed" });
      const uncertain = await f.store.checkpointWorkRunStart({
        ...next, kind: "uncertain", error: "Submission response lost",
      });
      assert.equal(uncertain.run.external_run_id, "external-1");
      assert.equal(uncertain.run.agent_thread_id, "executor:1");
      const recovered = await f.store.checkpointWorkRunStart({
        ...input, expected_item: uncertain.item, expected_run: uncertain.run,
        kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(recovered.outcome, "applied");
      assert.equal(recovered.run.start_state, "submitted");
      assert.equal(recovered.item.status, "waiting_human");
    });

    it("rejects stale startup snapshots, skipped work and superseded attempts", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const command = { ...input, kind: "uncertain", error: "Unknown" };
      const itemUpdate = await f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, updated_at: LATER },
      });
      assert.equal(itemUpdate.outcome, "applied");
      const newer = itemUpdate.item;
      assert.deepEqual(await f.store.checkpointWorkRunStart(command),
        { outcome: "conflict", reason: "stale_checkpoint" });
      const uncertain = await f.store.checkpointWorkRunStart({
        ...input, expected_item: newer, kind: "uncertain", error: "Submission response lost",
      });
      assert.equal(uncertain.outcome, "applied");
      const run = uncertain.run;
      assert.deepEqual(await f.store.checkpointWorkRunStart({ ...command, expected_item: newer }),
        { outcome: "conflict", reason: "stale_checkpoint" });
      const submitted = await f.store.checkpointWorkRunStart({
        expected_item: uncertain.item, expected_run: run, kind: "submitted",
        external_run_id: "external-1", now: LATER,
      });
      assert.equal(submitted.outcome, "applied");
      const skipped = await dismissWorkAsTestState(f);
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...command, expected_item: skipped, expected_run: submitted.run,
      }), { outcome: "conflict", reason: "work_skipped" });
      await observeWorkAsTestState(f, "cancelled");
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: skipped, retry: "manual",
        run: { ...input.expected_run, id: "new-start", status: "running", start_state: "pending" },
      }), true);
      const currentItem = await f.store.getWorkItem(ORG, f.item.id);
      const closedRun = await f.store.getWorkRun(ORG, run.id);
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...command, expected_item: currentItem, expected_run: closedRun,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), closedRun);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), currentItem);
    });

    it("cannot checkpoint a closed or terminal start or cross-tenant identity", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const failed = await f.store.checkpointWorkRunStart({ ...input, kind: "failed", error: "Not sent" });
      assert.equal(failed.outcome, "applied");
      const closed = failed.run;
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...input, expected_item: failed.item, expected_run: closed, kind: "uncertain", error: "Unknown",
      }), { outcome: "conflict", reason: "start_closed" });
      const terminal = await fixture(t, driver);
      const completedItem = await observeWorkAsTestState(terminal, "done");
      const completed = await terminal.store.getWorkRun(ORG, terminal.run.id);
      assert.deepEqual(await terminal.store.checkpointWorkRunStart({
        expected_item: completedItem, expected_run: completed, now: LATER,
        kind: "submitted", external_run_id: "external-1",
      }), { outcome: "conflict", reason: "start_closed" });
      assert.deepEqual(await f.store.checkpointWorkRunStart({
        ...input, expected_item: { ...input.expected_item, org_id: "foreign" },
        expected_run: { ...closed, org_id: "foreign" }, kind: "uncertain", error: "Unknown",
      }), { outcome: "conflict", reason: "missing_work" });
      await assert.rejects(f.store.checkpointWorkRunStart({
        ...input, expected_run: { ...closed, work_item_id: "foreign" }, kind: "uncertain", error: "Unknown",
      }), /same organization and work item/);
      assert.deepEqual(await f.store.getWorkRun(ORG, closed.id), closed);
    });

    it("serializes competing failure and submission checkpoints without torn status", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const results = await Promise.all([
        f.store.checkpointWorkRunStart({ ...input, kind: "failed", error: "Not sent" }),
        f.store.checkpointWorkRunStart({ ...input, kind: "submitted", external_run_id: "accepted" }),
      ]);
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
      const winner = results.find((result) => result.outcome === "applied");
      assert.deepEqual(await f.store.getWorkRun(ORG, winner.run.id), winner.run);
      assert.deepEqual(await f.store.getWorkItem(ORG, winner.item.id), winner.item);
      winner.run.result = { summary: "Mutated return" };
      assert.notEqual((await f.store.getWorkRun(ORG, winner.run.id)).result?.summary, "Mutated return");
    });

    it("atomically claims each delivery once and fences settlement with owner, token and lease", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const command = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const claims = await Promise.all(["worker-1", "worker-2"].map((owner) =>
        f.store.transitionWorkDelivery({ ...command, kind: "claim", owner })));
      assert.equal(claims.filter((row) => row.outcome === "applied").length, 1);
      const claimed = claims.find((row) => row.outcome === "applied").delivery;
      assert.ok(claimed.claim_token);
      assert.equal(claimed.attempts, 1);
      const evidence = { ...command, owner: claimed.lease_owner, token: claimed.claim_token };
      for (const change of [{ owner: "foreign" }, { token: "foreign" }]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, ...change, kind: "sent",
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      const renewed = await f.store.transitionWorkDelivery({
        ...evidence, kind: "renew", now: "2026-11-09T08:01:30.000Z",
      });
      assert.equal(renewed.outcome, "applied");
      assert.equal(renewed.delivery.claim_token, claimed.claim_token);
      assert.equal(renewed.delivery.lease_expires_at, "2026-11-09T08:02:30.000Z");
      const failed = await f.store.transitionWorkDelivery({
        ...evidence, kind: "failed", error: "Definitely rejected before acceptance",
        now: "2026-11-09T08:01:31.000Z",
      });
      assert.equal(failed.outcome, "applied");
      const retry = await f.store.transitionWorkDelivery({
        ...command, kind: "claim", owner: claimed.lease_owner, force: true,
        now: "2026-11-09T08:01:32.000Z",
      });
      assert.equal(retry.outcome, "applied");
      assert.notEqual(retry.delivery.claim_token, claimed.claim_token);
      assert.equal(retry.delivery.idempotency_key, delivery.idempotency_key);
      for (const kind of ["sent", "failed", "renew", "receipt", "uncertain"]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, kind, receipt: { accepted: true, rpc_id: "stale" }, error: "stale",
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      const settled = await f.store.transitionWorkDelivery({
        ...command, kind: "sent", owner: retry.delivery.lease_owner,
        token: retry.delivery.claim_token, now: "2026-11-09T08:01:33.000Z",
      });
      assert.equal(settled.delivery.status, "acked");
    });

    it("persists unknown acceptance across restart and merges only the retained claim's late receipt", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const { delivery: claimed } = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker",
      });
      const evidence = { ...base, owner: "worker", token: claimed.claim_token };
      const later = "2026-11-09T08:02:00.000Z";
      for (const kind of ["sent", "failed", "renew"]) {
        assert.deepEqual(await f.store.transitionWorkDelivery({
          ...evidence, kind, error: "expired", now: later,
        }), { outcome: "conflict", reason: "stale_claim" });
      }
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "expire", now: later,
      })).delivery.status, "uncertain");
      await f.reopen();
      const restored = await f.store.getWorkDelivery(ORG, delivery.id);
      assert.equal(restored.status, "uncertain");
      assert.equal(restored.claim_token, claimed.claim_token);
      assert.equal(restored.lease_owner, "worker");
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "cancel", now: later,
      })).delivery.status, "uncertain");
      assert.deepEqual(await f.store.listDueWorkDeliveries(ORG, later), []);
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", force: true, now: later,
      })).outcome, "conflict");
      assert.equal((await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "late-receipt" }, now: later,
      })).outcome, "applied");
      assert.deepEqual(await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "conflicting-receipt" }, now: later,
      }), { outcome: "conflict", reason: "receipt_conflict" });
      const due = await f.store.listDueWorkDeliveries(ORG, later);
      assert.equal(due.length, 1);
      const recovery = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", now: later,
      });
      assert.equal(recovery.outcome, "applied");
      assert.equal(recovery.delivery.channel_receipt.rpc_id, "late-receipt");
      assert.notEqual(recovery.delivery.claim_token, claimed.claim_token);
      assert.equal((await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true }, now: later,
      })).outcome, "conflict");
    });

    it("retains in-flight acceptance evidence when work is dismissed instead of faking a withdrawal", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const { delivery: claimed } = await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker",
      });
      await dismissWorkAsTestState(f);
      const cancel = await f.store.transitionWorkDelivery({ ...base, kind: "cancel" });
      assert.equal(cancel.delivery.status, "write_back");
      assert.equal(cancel.delivery.cancel_requested_at, LATER);
      const evidence = { ...base, owner: "worker", token: claimed.claim_token };
      await f.store.transitionWorkDelivery({
        ...evidence, kind: "receipt", receipt: { accepted: true, rpc_id: "accepted" },
      });
      const result = await f.store.transitionWorkDelivery({ ...evidence, kind: "sent" });
      assert.equal(result.delivery.write_back, "sent");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "skipped");
      assert.equal((await f.store.transitionWorkDelivery({ ...base, kind: "cancel" })).delivery.write_back, "sent");
    });

    it("cancels a queued send without exposing it to a new worker", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const base = { org_id: ORG, delivery_id: delivery.id, now: LATER };
      const cancelled = await f.store.transitionWorkDelivery({ ...base, kind: "cancel" });
      assert.equal(cancelled.delivery.status, "acked");
      assert.equal(cancelled.delivery.write_back, "skipped");
      assert.equal((await f.store.transitionWorkDelivery({
        ...base, kind: "claim", owner: "worker", force: true,
      })).outcome, "conflict");
    });

    it("freezes run obligations across restart despite later recipe changes", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
        executor_config: { prompt: "Frozen instruction", options: { mode: "safe" } },
        include_context: true,
      });
      await f.store.putRecipe({ ...f.recipe, can_write_back: false, write_back_thread_id: "other:room" });
      await f.reopen();
      const savedRun = await f.store.getWorkRun(ORG, f.run.id);
      assert.deepEqual(savedRun.write_back_target, TARGET);
      assert.deepEqual(savedRun.executor_config, { prompt: "Frozen instruction", options: { mode: "safe" } });
      assert.equal(savedRun.include_context, true);
      const reordered = {
        ...f.run, write_back_target: { target: TARGET.target, source: TARGET.source, installation_id: TARGET.installation_id },
      };
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_run: reordered, can_write_back: false, trigger_kind: "manual",
      })).outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.run_id, f.run.id);
      assert.equal(delivery.kind, "push");
      assert.deepEqual(delivery.target, TARGET);
    });

    it("keeps explicitly local runs local even when the recipe later enables write-back", async (t) => {
      const f = await fixture(t, driver, { write_back_required: false, trigger_kind: "push" });
      await f.reopen();
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("keeps independent deliveries for identical results from distinct runs", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.commitWorkObservation(f.input);
      const first = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      await settleDeliveryAsSent(f.store, first, LATER, {
        accepted: true, rpc_id: "original-message",
      });
      const completedItem = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: completedItem, retry: "manual",
        run: { ...f.run, id: "run-2", status: "running", start_state: "pending" },
      }), true);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, "run-2");
      const submitted = await f.store.checkpointWorkRunStart({
        expected_item: item, expected_run: run, kind: "submitted",
        external_run_id: f.input.handle.external_run_id, now: LATER,
      });
      assert.equal(submitted.outcome, "applied");
      const observe = { ...f.input, expected_item: submitted.item, expected_run: submitted.run };
      assert.equal((await f.store.commitWorkObservation(observe)).outcome, "applied");
      const second = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(second.run_id, "run-2");
      assert.notEqual(first.id, second.id);
      assert.notEqual(first.idempotency_key, second.idempotency_key);
      await f.store.commitWorkObservation({
        ...observe,
        expected_item: await f.store.getWorkItem(ORG, f.item.id),
        expected_run: await f.store.getWorkRun(ORG, run.id),
      });
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 2);
      assert.equal((await f.store.getWorkDeliveryByItem(ORG, f.item.id)).id, second.id);
      assert.deepEqual((await f.store.getWorkDelivery(ORG, first.id)).channel_receipt, {
        accepted: true, rpc_id: "original-message",
      });
      assert.deepEqual(await f.store.getWorkDelivery(ORG, second.id), second);
      await f.reopen();
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 2);
    });

    it("blocks another execution until all historical deliveries have closed", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.commitWorkObservation(f.input);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const completedItem = await f.store.getWorkItem(ORG, f.item.id);
      const next = { ...f.run, id: "run-2", status: "running", start_state: "pending" };
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: completedItem, retry: "manual", run: next,
      }), false);
      const owner = `test-worker:${delivery.id}`;
      const claimed = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner, force: true, now: LATER,
      });
      assert.equal(claimed.outcome, "applied");
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: completedItem, retry: "manual", run: next,
      }), false);
      let failed = claimed;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        failed = await f.store.transitionWorkDelivery({
          org_id: ORG, delivery_id: delivery.id, kind: "failed", owner,
          token: failed.delivery.claim_token,
          error: "Definitely rejected before acceptance",
          now: new Date(Date.parse(LATER) + attempt * 1_000).toISOString(),
        });
        assert.equal(failed.outcome, "applied");
        if (attempt < 3) {
          failed = await f.store.transitionWorkDelivery({
            org_id: ORG, delivery_id: delivery.id, kind: "claim", owner,
            force: true,
            now: new Date(Date.parse(LATER) + attempt * 1_000 + 1).toISOString(),
          });
          assert.equal(failed.outcome, "applied");
        }
      }
      assert.equal(failed.delivery.status, "dead");
      assert.equal(await f.store.claimWorkRunStart({ run: next }), false);
      await settleDeliveryAsSent(f.store, failed.delivery,
        new Date(Date.parse(LATER) + 10_000).toISOString());
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: completedItem, retry: "manual", run: next,
      }), true);
    });

    it("commits the completed run, work status and queued delivery together", async (t) => {
      const f = await fixture(t, driver);
      const result = await f.store.commitWorkObservation(f.input);
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.changed, true);
      assert.equal(result.transition.settled, true);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).status, "completed");
      const savedRun = await f.store.getWorkRun(ORG, f.run.id);
      const savedItem = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(savedRun.status, "completed");
      assert.equal(savedRun.version, f.run.version + 1);
      assert.equal(savedItem.status, "done");
      assert.equal(savedItem.version, f.item.version + 1);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.status, "queued");
      assert.equal(delivery.payload.summary, "Handled");
      assert.equal(delivery.recipe_id, f.recipe.id);
    });

    it("does not apply an observation whose item snapshot was superseded", async (t) => {
      const f = await fixture(t, driver);
      const update = await f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, updated_at: LATER },
      });
      assert.equal(update.outcome, "applied");
      const changed = update.item;
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "conflict", reason: "stale_observation",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), changed);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("does not retain mutable request or returned plan content in persisted state", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result.content = [
        { role: "body", media_type: "text/plain", text: "Original result" },
      ];
      const result = await f.store.commitWorkObservation(f.input);
      assert.equal(result.outcome, "applied");
      f.input.handle.result.content[0].text = "Changed input";
      result.transition.run.result.content[0].text = "Changed plan";
      assert.equal(
        (await f.store.getWorkRun(ORG, f.run.id)).result.content[0].text, "Original result",
      );
      assert.equal(
        (await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload.content[0].text, "Original result",
      );
    });

    it("fences stale run results even when timestamps have not changed", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = { summary: "A newer observation" };
      f.input.can_write_back = false;
      const applied = await f.store.commitWorkObservation(f.input);
      assert.equal(applied.outcome, "applied");
      const changed = applied.transition.run;
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: applied.transition.item, expected_run: f.run,
      }), {
        outcome: "conflict", reason: "stale_observation",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), applied.transition.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), changed);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    for (const terminal of ["completed", "failed", "cancelled"]) {
      it(`preserves the ${terminal} run when a separate attempt starts`, async (t) => {
        const f = await fixture(t, driver);
        const status = terminal === "completed" ? "done" : terminal;
        const item = await observeWorkAsTestState(f, status, LATER, { summary: "Original" });
        const run = await f.store.getWorkRun(ORG, f.run.id);
        assert.equal(run.status, terminal);
        assert.equal(await f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "run-2", status: "running", start_state: "pending" },
        }), true);
        assert.equal((await f.store.getActiveWorkRun(ORG, f.item.id)).id, "run-2");
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      });
    }

    it("serializes competing completed results on update", async (t) => {
      const f = await fixture(t, driver);
      const results = await Promise.all(["First", "Second"].map((summary) =>
        f.store.commitWorkObservation({
          ...f.input, can_write_back: false, handle: { ...f.input.handle, result: { summary } },
        })));
      const winner = results.find((result) => result.outcome === "applied")?.transition.run;
      assert.ok(winner);
      assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), winner);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "done");
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
    });

    it("does not expose persisted completed results through mutable reads", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1"],
      };
      await f.store.commitWorkObservation(f.input);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      run.result.content[0].text = "Changed through read";
      run.result.evidence_event_ids.push("event-2");
      delivery.payload.content[0].text = "Changed delivery through read";
      const storedRun = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal(storedRun.result.content[0].text, "Original");
      assert.deepEqual(storedRun.result.evidence_event_ids, ["event-1"]);
      assert.equal(
        (await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload.content[0].text,
        "Original",
      );
    });

    it("does not revive a terminal attempt even if its latest snapshot is supplied", async (t) => {
      const f = await fixture(t, driver);
      await f.store.commitWorkObservation(f.input);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { status: "running", external_run_id: run.external_run_id },
      }), { outcome: "conflict", reason: "stale_observation" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
      assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
    });

    it("does not apply a late result from an old attempt after a newer run starts", async (t) => {
      const f = await fixture(t, driver);
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      const oldRun = await f.store.getWorkRun(ORG, f.run.id);
      const oldDelivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      await settleDeliveryAsSent(f.store, oldDelivery);
      const settledDelivery = await f.store.getWorkDelivery(ORG, oldDelivery.id);
      const completedItem = await f.store.getWorkItem(ORG, f.item.id);
      const newRun = {
        id: "run-2", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        executor_type: "test", status: "running", start_state: "pending",
        created_at: LATER, updated_at: LATER,
      };
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: completedItem, retry: "manual", run: newRun,
      }), true);
      const currentItem = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(currentItem.current_run_id, newRun.id);
      assert.ok(currentItem.version > completedItem.version);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: currentItem,
        expected_run: oldRun,
        handle: {
          status: "completed",
          external_run_id: oldRun.external_run_id,
          result: { summary: "Late result from the old attempt" },
        },
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), currentItem);
      assert.equal((await f.store.getActiveWorkRun(ORG, f.item.id)).id, newRun.id);
      assert.deepEqual(await f.store.getWorkRun(ORG, oldRun.id), oldRun);
      assert.deepEqual(await f.store.listWorkDeliveries(ORG), [settledDelivery]);
    });

    it("keeps historical run identity unknown instead of guessing it from the only run", async (t) => {
      const f = await fixture(t, driver);
      const item = await seedLegacyMissingCurrentRunPointer(f, driver, f.item.id);
      assert.ok(item);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.ok(run);
      assert.equal(item.current_run_id, undefined);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.equal((await f.store.getWorkItem(ORG, item.id)).current_run_id, undefined);
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
    });

    it("rejects changes to completed summary, content and evidence even with current snapshots", async (t) => {
      const f = await fixture(t, driver);
      f.input.handle.result = {
        summary: "Handled",
        content: [{ role: "body", media_type: "text/plain", text: "Original" }],
        evidence_event_ids: ["event-1", "event-2"],
      };
      await f.store.commitWorkObservation(f.input);
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      for (const result of [
        { ...run.result, summary: "Corrected" },
        { ...run.result, content: [{ role: "body", media_type: "text/plain", text: "Changed" }] },
        { ...run.result, evidence_event_ids: ["event-2", "event-1"] },
        { summary: "Handled" },
      ]) {
        assert.deepEqual(await f.store.commitWorkObservation({
          ...f.input, expected_item: item, expected_run: run,
          handle: { ...f.input.handle, result },
        }), { outcome: "conflict", reason: "completed_result_changed" });
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), run);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
        assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
      }
    });

    it("does not replace or abandon delivery evidence on duplicate completion", async (t) => {
      for (const [status, write_back] of [
        ["queued", "pending"], ["write_back", "pending"], ["dead", "failed"],
        ["acked", "sent"], ["acked", "skipped"],
      ]) {
        const f = await fixture(t, driver);
        await f.store.commitWorkObservation(f.input);
        const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
        assert.ok(delivery);
        const persisted = await setDeliveryStateForTest(
          f.store, delivery, status, write_back,
        );
        for (const can_write_back of [false, true]) {
          for (const result of [undefined, f.input.handle.result]) {
            const item = await f.store.getWorkItem(ORG, f.item.id);
            const run = await f.store.getWorkRun(ORG, f.run.id);
            const repeated = await f.store.commitWorkObservation({
              ...f.input, expected_item: item, expected_run: run, can_write_back,
              handle: { ...f.input.handle, result },
            });
            assert.equal(repeated.outcome, "applied");
            assert.equal(repeated.transition.changed, false);
            assert.deepEqual(repeated.transition.delivery, { kind: "keep" });
            assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), persisted);
          }
        }
      }
    });

    it("does not invent delivery obligations or unknown results for historical completed work", async (t) => {
      const f = await fixture(t, driver);
      const completed = await f.store.commitWorkObservation({
        ...f.input,
        handle: { ...f.input.handle, status: "completed", result: undefined },
        can_write_back: false,
      });
      assert.equal(completed.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const repeated = await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { ...f.input.handle, result: undefined },
      });
      assert.equal(repeated.outcome, "applied");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).result, undefined);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: await f.store.getWorkItem(ORG, f.item.id),
        expected_run: await f.store.getWorkRun(ORG, f.run.id),
      }), { outcome: "conflict", reason: "completed_result_changed" });
    });

    it("uses the last known result when the first completed observation omits it", async (t) => {
      const f = await fixture(t, driver);
      const knownResult = await f.store.commitWorkObservation({
        ...f.input, can_write_back: false,
        handle: { ...f.input.handle, status: "running", result: { summary: "Known result" } },
      });
      assert.equal(knownResult.outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const result = await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { ...f.input.handle, result: undefined },
      });
      assert.equal(result.outcome, "applied");
      assert.deepEqual((await f.store.getWorkRun(ORG, f.run.id)).result, run.result);
      assert.deepEqual((await f.store.getWorkDeliveryByItem(ORG, f.item.id)).payload, run.result);
    });

    it("ignores locally skipped work without fabricating a remote cancellation", async (t) => {
      const f = await fixture(t, driver);
      await dismissWorkAsTestState(f);
      assert.deepEqual(await f.store.commitWorkObservation(f.input), {
        outcome: "ignored", reason: "work_skipped",
      });
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("atomically queues an identified cancellation and fences its durable lease", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      assert.equal(dismissed.outcome, "applied");
      assert.equal(dismissed.item.status, "skipped");

      const queued = await f.store.listCancellationJobs(ORG);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].job_type, "cancel_execution");
      assert.equal(queued[0].run_id, f.run.id);
      assert.equal(queued[0].status, "pending");
      assert.equal(queued[0].attempts, 0);

      const firstClaim = await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker-1", now: LATER, lease_ms: 30_000, limit: 1,
      });
      assert.equal(firstClaim.length, 1);
      assert.ok(firstClaim[0].claim_token);
      assert.equal(await f.store.renewCancellationJob({
        org_id: ORG, id: firstClaim[0].id, owner: "worker-1",
        claim_token: "stale-token", now: LATER, lease_ms: 30_000,
      }), false);

      const reclaimed = await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker-2", now: "2026-11-09T08:01:31.000Z",
        lease_ms: 30_000, limit: 1,
      });
      assert.equal(reclaimed.length, 1);
      assert.notEqual(reclaimed[0].claim_token, firstClaim[0].claim_token);
      assert.equal(await f.store.settleCancellationJob({
        kind: "succeeded", org_id: ORG, id: firstClaim[0].id, owner: "worker-1",
        claim_token: firstClaim[0].claim_token, now: "2026-11-09T08:01:32.000Z",
        outcome_code: "cancelled",
      }), false);
      assert.equal(await f.store.settleCancellationJob({
        kind: "succeeded", org_id: ORG, id: reclaimed[0].id, owner: "worker-2",
        claim_token: reclaimed[0].claim_token, now: "2026-11-09T08:01:32.000Z",
        outcome_code: "cancelled",
      }), true);
      assert.equal((await f.store.listCancellationJobs(ORG))[0].status, "succeeded");
    });

    it("atomically commits verified cancellation observations with successful job settlement", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const [job] = await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker", now: LATER, lease_ms: 30_000, limit: 1,
      });
      const result = await f.store.commitCancellationJobObservation({
        org_id: ORG, id: job.id, owner: "worker", claim_token: job.claim_token,
        expected_run: f.run,
        handle: { status: "cancelled", external_run_id: f.run.external_run_id },
        now: "2026-11-09T08:01:01.000Z",
      });
      assert.equal(result.outcome, "applied");
      assert.equal(result.run.status, "cancelled");
      assert.equal(result.run.version, f.run.version + 1);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "skipped");
      const [settled] = await f.store.listCancellationJobs(ORG);
      assert.equal(settled.status, "succeeded");
      assert.equal(settled.outcome_code, "observed_cancelled");
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), result.run);
      assert.deepEqual(await f.store.commitCancellationJobObservation({
        org_id: ORG, id: job.id, owner: "worker", claim_token: job.claim_token,
        expected_run: f.run,
        handle: { status: "cancelled", external_run_id: f.run.external_run_id },
        now: "2026-11-09T08:01:02.000Z",
      }), { outcome: "conflict" });
      await f.reopen();
      assert.equal((await f.store.getWorkRun(ORG, f.run.id)).status, "cancelled");
      assert.equal((await f.store.listCancellationJobs(ORG))[0].status, "succeeded");
      assert.equal(dismissed.item.status, "skipped");
    });

    it("does not settle cancellation using a conflicting executor conversation", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:original",
      });
      assert.equal(bound.outcome, "applied");
      const submitted = await f.store.checkpointWorkRunStart({
        ...input, expected_item: bound.item, expected_run: bound.run,
        kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(submitted.outcome, "applied");
      const run = submitted.run;
      await f.store.dismissWorkItem({ expected_item: submitted.item, now: LATER });
      const [job] = await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker", now: LATER, lease_ms: 30_000, limit: 1,
      });
      const command = {
        org_id: ORG, id: job.id, owner: "worker", claim_token: job.claim_token,
        expected_run: run, now: "2026-11-09T08:01:01.000Z",
        handle: {
          status: "cancelled", external_run_id: run.external_run_id,
          agent_thread_id: "executor:other",
        },
      };
      assert.deepEqual(await f.store.commitCancellationJobObservation(command), { outcome: "conflict" });
      assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
      assert.equal((await f.store.listCancellationJobs(ORG))[0].status, "running");
      const applied = await f.store.commitCancellationJobObservation({
        ...command, handle: { status: "cancelled", external_run_id: run.external_run_id },
      });
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.run.agent_thread_id, run.agent_thread_id);
    });

    it("moves exhausted cancellation jobs to dead and stops claiming them", async (t) => {
      const f = await fixture(t, driver);
      await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      let now = Date.parse(LATER);
      let previousClaimToken;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const [job] = await f.store.claimCancellationJobs({
          org_id: ORG, owner: `worker-${attempt}`, now: new Date(now).toISOString(),
          lease_ms: 30_000, limit: 1,
        });
        assert.ok(job, `expected cancellation attempt ${attempt}`);
        const settleAt = now + 1_000;
        assert.equal(await f.store.settleCancellationJob({
          kind: "failed", org_id: ORG, id: job.id, owner: job.lease_owner,
          claim_token: job.claim_token, now: new Date(settleAt).toISOString(),
          next_retry_at: new Date(settleAt + 5_000).toISOString(),
          error_code: "cancel_unconfirmed", error: "cancel_unconfirmed",
        }), true);
        now = settleAt + 6_000;
      }
      const [dead] = await f.store.listCancellationJobs(ORG);
      assert.equal(dead.status, "dead");
      assert.equal(dead.attempts, 5);
      assert.equal(dead.outcome_code, "retry_exhausted");
      assert.deepEqual(await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker-final", now: new Date(now).toISOString(),
        lease_ms: 30_000, limit: 1,
      }), []);
    });

    it("audits an idempotent dead cancellation-job retry and resets its retry budget", async (t) => {
      const f = await fixture(t, driver);
      await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      let now = Date.parse(LATER);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const [job] = await f.store.claimCancellationJobs({
          org_id: ORG, owner: `worker-${attempt}`, now: new Date(now).toISOString(),
          lease_ms: 30_000, limit: 1,
        });
        assert.ok(job);
        previousClaimToken = job.claim_token;
        const settleAt = now + 1_000;
        assert.equal(await f.store.settleCancellationJob({
          kind: "failed", org_id: ORG, id: job.id, owner: job.lease_owner,
          claim_token: job.claim_token, now: new Date(settleAt).toISOString(),
          next_retry_at: new Date(settleAt + 5_000).toISOString(),
          error_code: "cancel_unconfirmed", error: "cancel_unconfirmed",
        }), true);
        now = settleAt + 6_000;
      }
      const [dead] = await f.store.listCancellationJobs(ORG);
      const command = {
        org_id: ORG,
        id: dead.id,
        expected_attempts: 5,
        command_id: "manual-cancellation-retry-1",
        issued_at: new Date(now).toISOString(),
      };
      const retried = await f.store.retryCancellationJob(command);
      assert.equal(retried.outcome, "applied");
      assert.equal(retried.job.status, "pending");
      assert.equal(retried.job.attempts, 0);
      assert.equal(retried.job.last_error, undefined);
      assert.equal(retried.job.outcome_code, undefined);
      assert.deepEqual(await f.store.retryCancellationJob(command), {
        outcome: "replayed",
        job: retried.job,
      });
      assert.deepEqual(await f.store.retryCancellationJob({
        ...command,
        expected_attempts: 4,
      }), { outcome: "conflict" });
      assert.deepEqual(await f.store.listCancellationJobs(ORG, 0), []);
      const [claimed] = await f.store.claimCancellationJobs({
        org_id: ORG, owner: "worker-after-manual-retry", now: new Date(now).toISOString(),
        lease_ms: 30_000, limit: 1,
      });
      assert.equal(claimed.status, "running");
      assert.equal(claimed.attempts, 1);
      assert.ok(claimed.claim_token);
      assert.notEqual(claimed.claim_token, previousClaimToken);
    });

    for (const status of ["running", "waiting_human", "completed", "failed", "cancelled"]) {
      it(`records actual ${status} after dismissal without changing ignored item or delivery evidence`, async (t) => {
        const f = await fixture(t, driver, {
          write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
        });
        const delivery = await seedTestWorkDelivery(f, driver, enqueueWriteBack({
          org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
          unit_key: f.item.unit_key, run_id: f.run.id, target: TARGET,
          payload: { summary: "Existing evidence" }, now: NOW,
        }));
        const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
        const stopped = await f.store.getWorkDelivery(ORG, delivery.id);
        const input = { ...f.input, expected_item: dismissed.item, handle: { ...f.input.handle, status } };
        const result = await f.store.commitWorkObservation(input);
        assert.equal(result.outcome, "applied");
        assert.deepEqual(result.transition.item, dismissed.item);
        assert.deepEqual(result.transition.delivery, { kind: "keep" });
        assert.equal(result.transition.run.status, status);
        assert.equal(result.transition.run.version, f.run.version + 1);
        assert.equal(result.transition.run.result.summary, "Handled");
        assert.equal(result.transition.run.write_back_required, true);
        assert.deepEqual(result.transition.run.write_back_target, TARGET);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), stopped);
        assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), result.transition.run);
        const repeated = await f.store.commitWorkObservation({
          ...input, expected_run: result.transition.run,
        });
        assert.equal(repeated.outcome, "applied");
        assert.equal(repeated.transition.changed, false);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), stopped);
        if (status === "completed") {
          assert.deepEqual(await f.store.commitWorkObservation({
            ...input, expected_run: repeated.transition.run,
            handle: { ...input.handle, result: { summary: "Changed after completion" } },
          }), { outcome: "conflict", reason: "completed_result_changed" });
        }
      });
    }

    it("allows explicit retry only after an ignored execution's actual terminal outcome is committed", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const claim = {
        expected_item: dismissed.item, retry: "manual",
        run: { ...f.run, id: "successor", status: "running", start_state: "pending" },
      };
      assert.equal(await f.store.claimWorkRunStart(claim), false);
      const result = await f.store.commitWorkObservation({ ...f.input, expected_item: dismissed.item });
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.run.status, "completed");
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
      assert.equal(await f.store.claimWorkRunStart(claim), true);
      const successor = await f.store.getWorkItem(ORG, f.item.id);
      assert.equal(successor.current_run_id, "successor");
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input, expected_item: dismissed.item, expected_run: result.transition.run,
      }), { outcome: "conflict", reason: "not_current_run" });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), successor);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), result.transition.run);
    });

    for (const activeStatus of ["running", "waiting_human"]) {
      it(`completes an existing ${activeStatus} run through a lifecycle observation`, async (t) => {
        const f = await fixture(t, driver);
        if (activeStatus === "waiting_human") {
          await observeWorkAsTestState(f, activeStatus);
        }
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = await f.store.getWorkRun(ORG, f.run.id);
        assert.equal(run.status, activeStatus);
        const observed = await f.store.commitWorkObservation({
          ...f.input, expected_item: item, expected_run: run,
        });
        assert.equal(observed.outcome, "applied");
        assert.equal(observed.transition.run.status, "completed");
      });
    }

    it("requires lifecycle transitions to change an existing run's start state", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const submitted = await f.store.checkpointWorkRunStart({
        ...input, kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(submitted.outcome, "applied");
      const observed = await f.store.commitWorkObservation({
        ...f.input, expected_item: submitted.item, expected_run: submitted.run,
      });
      assert.equal(observed.outcome, "applied");
      assert.equal(observed.transition.run.start_state, undefined);
    });

    it("rejects observations from a different bound execution or executor conversation", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const bound = await f.store.checkpointWorkRunStart({
        ...input, kind: "bound", external_run_id: "external-1", agent_thread_id: "executor:original",
      });
      assert.equal(bound.outcome, "applied");
      const submitted = await f.store.checkpointWorkRunStart({
        ...input, expected_item: bound.item, expected_run: bound.run,
        kind: "submitted", external_run_id: "external-1",
      });
      assert.equal(submitted.outcome, "applied");
      const item = submitted.item;
      const run = submitted.run;
      for (const handle of [
        { ...f.input.handle, external_run_id: "other-run", agent_thread_id: "executor:original" },
        { ...f.input.handle, external_run_id: run.external_run_id, agent_thread_id: "executor:other" },
      ]) {
        assert.deepEqual(await f.store.commitWorkObservation({
          ...f.input, expected_item: item, expected_run: run, handle,
        }), { outcome: "conflict", reason: "execution_identity_mismatch" });
        assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), item);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      }
      const accepted = await f.store.commitWorkObservation({
        ...f.input, expected_item: item, expected_run: run,
        handle: { ...f.input.handle, agent_thread_id: undefined },
      });
      assert.equal(accepted.outcome, "applied");
      assert.equal(accepted.transition.run.agent_thread_id, run.agent_thread_id);
    });

    it("permits only one of two competing completion observations", async (t) => {
      const f = await fixture(t, driver);
      const results = await Promise.all([
        f.store.commitWorkObservation(f.input),
        f.store.commitWorkObservation({
          ...f.input, handle: { ...f.input.handle, result: { summary: "Other result" } },
        }),
      ]);
      assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
      assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
      assert.equal((await f.store.listWorkDeliveries(ORG)).length, 1);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.payload.summary, run.result.summary);
    });

    it("keeps a pending delivery untouched on active observations", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        kind: "push", unit_key: f.item.unit_key, payload: { summary: "Earlier result" }, now: NOW,
      }));
      const result = await f.store.commitWorkObservation({
        ...f.input, handle: { ...f.input.handle, status: "waiting_human" },
      });
      assert.equal(result.outcome, "applied");
      assert.equal(result.transition.settled, false);
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "waiting_human");
      assert.deepEqual(await f.store.getWorkDeliveryByItem(ORG, f.item.id), delivery);
    });

    it("atomically abandons an old delivery when a completed trial disables send-back", async (t) => {
      const f = await fixture(t, driver);
      await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
        kind: "push", unit_key: f.item.unit_key, payload: { summary: "Earlier result" }, now: NOW,
      }));
      const result = await f.store.commitWorkObservation({ ...f.input, can_write_back: false });
      assert.equal(result.outcome, "applied");
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      assert.equal(delivery.status, "acked");
      assert.equal(delivery.write_back, "skipped");
      assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "done");
    });

    it("does not resolve another tenant's work identities", async (t) => {
      const f = await fixture(t, driver);
      assert.deepEqual(await f.store.commitWorkObservation({
        ...f.input,
        expected_item: { ...f.item, org_id: "another-owner" },
        expected_run: { ...f.run, org_id: "another-owner" },
      }), { outcome: "conflict", reason: "missing_work" });
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });

    it("rejects a run belonging to another work item without changing either row", async (t) => {
      const f = await fixture(t, driver);
      await assert.rejects(f.store.commitWorkObservation({
        ...f.input, expected_run: { ...f.run, work_item_id: "work-2" },
      }), /same organization and work item/);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });
  });
}

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} acknowledgment disposition and visibility`, { skip: driver.skip }, () => {
    it("does not let another tombstone disposition block successful acknowledgment folding", async (t) => {
      const f = await fixture(t, driver);
      const tombstone = await f.store.markTombstone({
        id: "ack-tombstone", org_id: ORG, source: "source", external_id: "deleted",
        thread_id: f.item.thread_id, expected_head_id: null, occurred_at: NOW,
      });
      await f.store.putDispositionIfAbsent({
        event_id: tombstone.id, org_id: ORG, disposition: "current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: NOW,
      });
      assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const result = await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-tombstone-guard", issued_at: LATER, now: LATER,
      });
      assert.equal(result.outcome, "applied");
      assert.equal((await f.store.getConversationPref(ORG, item.thread_id)).hidden_reason, "policy");
      assert.equal((await f.store.getDisposition(tombstone.id)).disposition, "current_work");
    });

    it("merges the read cursor with acknowledgment and preserves it through replay and policy folding", async (t) => {
      const f = await fixture(t, driver, {
        write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
      });
      await f.store.putConversationPref({
        org_id: ORG, thread_id: f.item.thread_id,
        last_read_at: "2026-11-09T08:00:30.000Z",
        last_read_external_id: "cursor-old", updated_at: NOW,
      });
      assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
      let item = await f.store.getWorkItem(ORG, f.item.id);
      let run = await f.store.getWorkRun(ORG, f.run.id);
      const delivery = await f.store.getWorkDeliveryByItem(ORG, f.item.id);
      const attention = {
        org_id: ORG, thread_id: item.thread_id,
        last_read_at: LATER, last_read_external_id: "cursor-new", updated_at: LATER,
      };
      const command = {
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-with-read-cursor", issued_at: LATER, now: LATER,
        conversation_attention: attention,
      };
      assert.deepEqual(await f.store.acknowledgeWorkResult(command),
        { outcome: "conflict", reason: "not_acknowledgeable" });
      let pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.last_read_at, LATER);
      assert.equal(pref.last_read_external_id, "cursor-new");
      await assert.rejects(f.store.acknowledgeWorkResult({
        ...command,
        conversation_attention: { ...attention, thread_id: "another-thread" },
      }), /match its conversation/);
      pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.last_read_external_id, "cursor-new");
      const claim = await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "worker-1", now: LATER,
      });
      await f.store.transitionWorkDelivery({
        org_id: ORG, delivery_id: delivery.id, kind: "sent", owner: "worker-1",
        token: claim.delivery.claim_token, now: LATER,
      });
      item = await f.store.getWorkItem(ORG, f.item.id);
      run = await f.store.getWorkRun(ORG, f.run.id);
      const acknowledgment = {
        ...command, expected_item: item, expected_version: item.version,
        expected_run_version: run.version,
      };
      const applied = await f.store.acknowledgeWorkResult(acknowledgment);
      assert.equal(applied.outcome, "applied");
      pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.last_read_at, LATER);
      assert.equal(pref.last_read_external_id, "cursor-new");
      assert.equal(pref.hidden_reason, "policy");
      const olderReplay = await f.store.acknowledgeWorkResult({
        ...acknowledgment,
        conversation_attention: {
          ...attention, last_read_at: "2026-11-09T08:00:45.000Z",
          last_read_external_id: "cursor-between",
        },
      });
      assert.equal(olderReplay.outcome, "replayed");
      const replayedPref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(replayedPref.last_read_at, LATER);
      assert.equal(replayedPref.last_read_external_id, "cursor-new");
    });

    it("rolls back the read cursor when the acknowledgment transaction fails", {
      skip: !driver.name.startsWith("sqlite") && driver.name !== "postgres",
    }, async (t) => {
      const f = await fixture(t, driver);
      await f.store.putConversationPref({
        org_id: ORG, thread_id: f.item.thread_id,
        last_read_at: "2026-11-09T08:00:30.000Z",
        last_read_external_id: "cursor-old", updated_at: NOW,
      });
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, can_write_back: false,
      })).outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      const command = {
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-rollback-read-cursor", issued_at: LATER, now: LATER,
        conversation_attention: {
          org_id: ORG, thread_id: item.thread_id,
          last_read_at: LATER, last_read_external_id: "cursor-new", updated_at: LATER,
        },
      };
      const db = driver.name.startsWith("sqlite") ? new Database(f.path) : undefined;
      try {
        if (db) {
          db.exec(`CREATE TRIGGER fail_work_acknowledgment
            BEFORE INSERT ON conversation_lifecycle_events
            WHEN NEW.event_type = 'work_acknowledged'
            BEGIN SELECT RAISE(ABORT, 'forced acknowledgment failure'); END`);
        } else {
          await f.query(`CREATE FUNCTION fail_work_acknowledgment() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.event_type = 'work_acknowledged' THEN
                RAISE EXCEPTION 'forced acknowledgment failure';
              END IF;
              RETURN NEW;
            END $$`);
          await f.query(`CREATE TRIGGER fail_work_acknowledgment
            BEFORE INSERT ON conversation_lifecycle_events
            FOR EACH ROW EXECUTE FUNCTION fail_work_acknowledgment()`);
        }
        await assert.rejects(f.store.acknowledgeWorkResult(command));
      } finally {
        if (db) {
          db.exec("DROP TRIGGER fail_work_acknowledgment");
          db.close();
        } else {
          await f.query("DROP TRIGGER IF EXISTS fail_work_acknowledgment ON conversation_lifecycle_events");
          await f.query("DROP FUNCTION IF EXISTS fail_work_acknowledgment()");
        }
      }
      const pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref.last_read_at, "2026-11-09T08:00:30.000Z");
      assert.equal(pref.last_read_external_id, "cursor-old");
      assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, undefined);
      assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "current_work");
    });

    for (const status of ["completed", "failed"]) {
      it(`atomically acknowledges ${status} with a legacy trigger and replays without changing it`, async (t) => {
        const f = await fixture(t, driver, {}, true, { triggerWithoutThread: true });
        const before = await f.store.getDisposition(f.item.head_event_id);
        const observed = await f.store.commitWorkObservation({
          ...f.input, can_write_back: false,
          handle: { ...f.input.handle, status, result: { summary: "Result" } },
        });
        assert.equal(observed.outcome, "applied");
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = await f.store.getWorkRun(ORG, f.run.id);
        const command = {
          expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
          expected_version: item.version, expected_run_version: run.version,
          command_id: "ack-legacy-trigger", issued_at: LATER, now: LATER,
        };
        assert.equal((await f.store.acknowledgeWorkResult(command)).outcome, "applied");
        const decision = await f.store.getDisposition(item.head_event_id);
        assert.equal(decision.disposition, "outside_current_work");
        assert.equal(decision.version, before.version + 1);
        assert.ok(decision.reason_codes.includes("result_acknowledged"));
        assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, status === "completed");
        assert.equal((await f.store.acknowledgeWorkResult(command)).outcome, "replayed");
        assert.deepEqual(await f.store.getDisposition(item.head_event_id), decision);
        if (driver.name === "memory authority") {
          const events = f.store.listAcknowledgmentLifecycleEvents();
          assert.deepEqual(events.map((event) => event.event_type),
            status === "completed"
              ? ["visibility_changed", "current_work_changed", "work_acknowledged"]
              : ["current_work_changed", "work_acknowledged"]);
          assert.equal(events.at(-1).command_id, command.command_id);
        }
        assert.deepEqual(await f.store.transitionDisposition({
          expected: before,
          decision: { ...before, disposition: "pending" },
          command: {
            org_id: ORG, event_id: before.event_id, action: "triage",
            disposition: "pending", command_id: "stale-triage", issued_at: LATER,
          },
        }), { outcome: "conflict" });
      });
    }

    for (const guard of ["human visibility", "other current work"]) {
    it(`preserves ${guard} when acknowledging a result`, async (t) => {
      const f = await fixture(t, driver);
      if (guard === "other current work") {
        const other = await f.store.append({
          id: "ack-other-event", org_id: ORG, source: "source", external_id: "ack-other",
          thread_id: f.item.thread_id, content_hash: "b".repeat(64),
          content_media_type: "text/plain", content_byte_size: 1, occurred_at: NOW, expected_head_id: null,
        });
        await f.store.putDispositionIfAbsent({
          event_id: other.id, org_id: ORG, disposition: "current_work",
          layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
        });
      } else {
        await f.store.setConversationVisibility({
          org_id: ORG, thread_id: f.item.thread_id, hidden: false,
          expected_version: 0, updated_at: LATER,
        });
      }
      assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal((await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-other-work", issued_at: LATER, now: LATER,
      })).outcome, "applied");
      const pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref?.hidden ?? false, false);
      if (guard === "human visibility") assert.equal(pref.visibility_version, 1);
      else assert.equal((await f.store.getDisposition("ack-other-event")).disposition, "current_work");
    });
    }

    it("keeps a finished scheduled run visible while another message is current work", async (t) => {
      const f = await fixture(t, driver);
      assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
      const item = await seedLegacyWorkHeadEvent(f, driver, f.item.id, null);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal((await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: "",
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-scheduled-other-work", issued_at: LATER, now: LATER,
      })).outcome, "applied");
      assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, false);
      assert.equal((await f.store.getDisposition("work-trigger-event")).disposition, "current_work");
      assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, run.id);
    });

    it("hides a finished scheduled run when the thread has no current work", async (t) => {
      const f = await fixture(t, driver);
      assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
      const current = await f.store.getDisposition("work-trigger-event");
      await setDisposition(f.store, {
        ...current, disposition: "outside_current_work", decided_at: LATER,
      });
      const item = await seedLegacyWorkHeadEvent(f, driver, f.item.id, null);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.equal((await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: "",
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-scheduled-clear", issued_at: LATER, now: LATER,
      })).outcome, "applied");
      const pref = await f.store.getConversationPref(ORG, item.thread_id);
      assert.equal(pref?.hidden, true);
      assert.equal(pref?.hidden_reason, "policy");
    });

    for (const prior of ["acknowledgment", "visibility", "disposition"]) {
      it(`rejects command ID reuse when ${prior} is first`, async (t) => {
        const f = await fixture(t, driver);
        assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = await f.store.getWorkRun(ORG, f.run.id);
        const acknowledgment = {
          expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
          expected_version: item.version, expected_run_version: run.version,
          command_id: "shared-command", issued_at: LATER, now: LATER,
        };
        const visibility = {
          org_id: ORG, thread_id: item.thread_id, hidden: false,
          expected_version: 0, command_id: "shared-command", issued_at: LATER, updated_at: LATER,
        };
        const before = await f.store.getDisposition(item.head_event_id);
        const disposition = {
          expected: before,
          decision: { ...before, disposition: "pending" },
          command: { org_id: ORG, event_id: before.event_id, action: "triage",
            disposition: "pending", command_id: "shared-command", issued_at: LATER },
        };
        if (prior === "acknowledgment") {
          assert.equal((await f.store.acknowledgeWorkResult(acknowledgment)).outcome, "applied");
          assert.equal((await f.store.setConversationVisibility(visibility)).outcome, "command_conflict");
          assert.equal((await f.store.transitionDisposition(disposition)).outcome, "command_conflict");
        } else {
          const result = prior === "visibility"
            ? await f.store.setConversationVisibility(visibility)
            : await f.store.transitionDisposition(disposition);
          assert.equal(result.outcome, "applied");
          assert.deepEqual(await f.store.acknowledgeWorkResult(acknowledgment),
            { outcome: "conflict", reason: "command_conflict" });
        }
      });
    }

    it("rejects acknowledgment of current work from a different conversation", async (t) => {
      const f = await fixture(t, driver);
      const other = await f.store.append({
        id: "ack-misplaced-trigger", org_id: ORG, source: "source", external_id: "other",
        thread_id: "source:other", content_hash: "b".repeat(64),
        content_media_type: "text/plain", content_byte_size: 1, occurred_at: NOW, expected_head_id: null,
      });
      await f.store.putDispositionIfAbsent({
        event_id: other.id, org_id: ORG, disposition: "current_work",
        layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
      });
      const changed = await seedLegacyWorkHeadEvent(f, driver, f.item.id, other.id);
      assert.ok(changed);
      assert.equal((await f.store.commitWorkObservation({
        ...f.input, expected_item: changed, can_write_back: false,
      })).outcome, "applied");
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const run = await f.store.getWorkRun(ORG, f.run.id);
      assert.deepEqual(await f.store.acknowledgeWorkResult({
        expected_item: item, run_id: run.id, trigger_event_id: other.id,
        expected_version: item.version, expected_run_version: run.version,
        command_id: "ack-wrong-thread", issued_at: LATER, now: LATER,
      }), { outcome: "conflict", reason: "not_acknowledgeable" });
      assert.equal((await f.store.getDisposition(other.id)).disposition, "current_work");
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
    });
  });
}

async function intakeAcknowledgmentFixture(t, driver, withWorkItem) {
  const f = await fixture(t, driver);
  assert.equal((await f.store.commitWorkObservation({
    ...f.input, can_write_back: false,
  })).outcome, "applied");
  const item = await f.store.getWorkItem(ORG, f.item.id);
  const run = await f.store.getWorkRun(ORG, f.run.id);
  const event = {
    id: "new-intake-event", org_id: ORG, source: "source",
    external_id: "new-intake-event", thread_id: item.thread_id,
    content_hash: "b".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
    occurred_at: LATER, expected_head_id: null,
  };
  return {
    f,
    item,
    run,
    event,
    acknowledgment: {
      expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
      expected_version: item.version, expected_run_version: run.version,
      command_id: "ack-competing-intake", issued_at: LATER, now: LATER,
    },
    intake: {
      ingest: {
        appends: [event],
        dispositions: [{
          event_id: event.id, org_id: ORG, disposition: "current_work",
          layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: LATER,
        }],
      },
      work_observations: withWorkItem ? [{
        expected_item: null,
        item: {
          id: "new-intake-work", org_id: ORG, thread_id: item.thread_id,
          unit_key: event.id, head_event_id: event.id, recipe_id: f.recipe.id,
          record_class: "task", thread_facet: "ticket", status: "open",
          created_at: LATER, updated_at: LATER,
        },
      }] : [],
      visibility: [],
    },
  };
}

async function assertIntakeRemainsVisible(input, withWorkItem) {
  const { f, item, run, event, acknowledgment } = input;
  assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, run.id);
  assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "outside_current_work");
  assert.equal((await f.store.getDisposition(event.id)).disposition, "current_work");
  assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, false);
  assert.ok((await f.store.listInbox(ORG, { disposition: "current_work" }))
    .some((row) => row.event.id === event.id));
  const newWork = await f.store.getWorkItem(ORG, "new-intake-work");
  assert.equal(newWork?.status ?? null, withWorkItem ? "open" : null);
  assert.equal((await f.store.acknowledgeWorkResult(acknowledgment)).outcome, "replayed");
  assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, false);
}

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} intake and acknowledgment ordering`, { skip: driver.skip }, () => {
    for (const withWorkItem of [false, true]) {
      for (const first of ["intake", "acknowledgment"]) {
        it(`keeps new work ${withWorkItem ? "with" : "without"} a WorkItem visible after ${first} commits first`, async (t) => {
          const input = await intakeAcknowledgmentFixture(t, driver, withWorkItem);
          const { f, intake, acknowledgment } = input;
          const actions = {
            intake: async () => {
              const events = await f.store.commitConversationIntake(intake);
              assert.equal(events[0].id, input.event.id);
            },
            acknowledgment: async () => {
              assert.equal((await f.store.acknowledgeWorkResult(acknowledgment)).outcome, "applied");
            },
          };
          await actions[first]();
          await actions[first === "intake" ? "acknowledgment" : "intake"]();
          await f.reopen();
          await assertIntakeRemainsVisible(input, withWorkItem);
        });
      }
    }
  });
}

describe("SQLite writer intake and acknowledgment transaction interleaving", () => {
  for (const withWorkItem of [false, true]) {
    it(`keeps new work ${withWorkItem ? "with" : "without"} a WorkItem visible across independent writers`, async (t) => {
      const driver = drivers.find((d) => d.name === "sqlite writer RPC");
      const input = await intakeAcknowledgmentFixture(t, driver, withWorkItem);
      const { f } = input;
      const second = await SqliteSplitAuthorityStore.open(f.path);
      t.after(() => second.close());
      const [events, acknowledgment] = await Promise.all([
        f.store.commitConversationIntake(input.intake),
        second.acknowledgeWorkResult(input.acknowledgment),
      ]);
      assert.equal(events[0].id, input.event.id);
      assert.equal(acknowledgment.outcome, "applied");
      await assertIntakeRemainsVisible(input, withWorkItem);
      assert.equal((await second.getDisposition(input.event.id)).disposition, "current_work");
      assert.equal((await second.getConversationPref(ORG, input.item.thread_id))?.hidden ?? false, false);
    });
  }
});

async function interleavePostgresTransactions(f, first, second, beforeCommit) {
  const original = f.store.withTx;
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let reached;
  const paused = new Promise((resolve) => { reached = resolve; });
  let holdFirst = true;
  // Pause only after the real transaction has written, while it still owns its locks.
  f.store.withTx = function (fn, isolation) {
    const hold = holdFirst;
    holdFirst = false;
    return original.call(this, async (client) => {
      const result = await fn(client);
      if (hold) {
        reached(client.processID);
        await gate;
      }
      return result;
    }, isolation);
  };
  const pending = [first()];
  let settled = Promise.allSettled(pending);
  try {
    const holder = await Promise.race([
      paused,
      pending[0].then(() => { throw new Error("Transaction did not reach the commit barrier"); }),
    ]);
    await beforeCommit();
    pending.push(second());
    settled = Promise.allSettled(pending);
    const deadline = Date.now() + 10_000;
    let blocked = false;
    while (Date.now() < deadline) {
      const result = await f.query(`SELECT 1 FROM pg_locks waiting
        JOIN pg_locks holding USING (locktype, database, classid, objid, objsubid)
        WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
          AND holding.granted AND holding.pid = $1 AND waiting.pid <> $1
        LIMIT 1`, [holder]);
      if (result.rows.length > 0) {
        blocked = true;
        break;
      }
    }
    assert.ok(blocked, "The competing transaction must wait for the conversation lock");
    resume();
    const results = await settled;
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  } finally {
    resume();
    await settled;
    f.store.withTx = original;
  }
}

describe("postgres intake and acknowledgment transaction interleaving", {
  skip: !process.env.TEST_DATABASE_URL?.trim(),
}, () => {
  for (const withWorkItem of [false, true]) {
    for (const first of ["intake", "acknowledgment"]) {
      it(`serializes ${first} before a competing transaction for new work ${withWorkItem ? "with" : "without"} a WorkItem`, {
        timeout: 45_000,
      }, async (t) => {
        const driver = drivers.find((d) => d.name === "postgres");
        const input = await intakeAcknowledgmentFixture(t, driver, withWorkItem);
        const { f } = input;
        const actions = {
          intake: () => f.store.commitConversationIntake(input.intake),
          acknowledgment: () => f.store.acknowledgeWorkResult(input.acknowledgment),
        };
        const results = await interleavePostgresTransactions(
          f, actions[first], actions[first === "intake" ? "acknowledgment" : "intake"], async () => {
            if (first === "intake") {
              assert.equal(await f.store.getEvent(ORG, input.event.id), null);
            } else {
              assert.equal((await f.store.getWorkItem(ORG, input.item.id)).acknowledged_run_id, undefined);
            }
          },
        );
        assert.equal(results[first === "acknowledgment" ? 0 : 1].outcome, "applied");
        await assertIntakeRemainsVisible(input, withWorkItem);
      });
    }
  }
});

async function visibilityAcknowledgmentFixture(t, driver, hidden) {
  const f = await fixture(t, driver);
  assert.equal((await f.store.commitWorkObservation({
    ...f.input, can_write_back: false,
  })).outcome, "applied");
  const item = await f.store.getWorkItem(ORG, f.item.id);
  const run = await f.store.getWorkRun(ORG, f.run.id);
  return {
    f,
    item,
    acknowledgment: {
      expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
      expected_version: item.version, expected_run_version: run.version,
      command_id: "ack-competing-visibility", issued_at: LATER, now: LATER,
    },
    visibility: {
      org_id: ORG, thread_id: item.thread_id, hidden, expected_version: 0,
      command_id: "visibility-competing-ack", issued_at: LATER, updated_at: LATER,
    },
  };
}

async function assertManualVisibilityWins(input, acknowledged, visibility) {
  const { f, item } = input;
  assert.equal(acknowledged.outcome, "applied");
  assert.equal(visibility.outcome, "applied");
  let pref = await f.store.getConversationPref(ORG, item.thread_id);
  assert.equal(pref.hidden, input.visibility.hidden);
  assert.equal(pref.hidden_reason, input.visibility.hidden ? "human" : null);
  assert.equal(pref.visibility_version, 1);
  assert.equal((await f.store.getWorkItem(ORG, item.id)).acknowledged_run_id, input.acknowledgment.run_id);
  assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, "outside_current_work");
  assert.equal((await f.store.acknowledgeWorkResult(input.acknowledgment)).outcome, "replayed");
  const replay = await f.store.setConversationVisibility(input.visibility);
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.pref, visibility.pref);
  assert.deepEqual(await f.store.getConversationPref(ORG, item.thread_id), pref);
  const sameValue = await f.store.setConversationVisibility({
    ...input.visibility, expected_version: 1, command_id: "visibility-same-value-after-ack",
  });
  assert.equal(sameValue.outcome, "applied");
  assert.equal(sameValue.pref.visibility_version, 2);
  assert.equal(sameValue.pref.hidden, input.visibility.hidden);
  assert.equal((await f.store.setConversationVisibility(input.visibility)).outcome, "replayed");
  assert.equal((await f.store.acknowledgeWorkResult(input.acknowledgment)).outcome, "replayed");
  pref = await f.store.getConversationPref(ORG, item.thread_id);
  assert.deepEqual(pref, sameValue.pref);
  assert.deepEqual(await f.store.setConversationPolicyHidden({
    org_id: ORG, thread_id: item.thread_id, expected_visibility_version: 0, updated_at: LATER,
  }), { outcome: "conflict", current_version: 2 });
  assert.deepEqual(await f.store.getConversationPref(ORG, item.thread_id), pref);
}

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} manual visibility and result acknowledgment`, { skip: driver.skip }, () => {
    for (const hidden of [false, true]) {
      for (const first of ["visibility", "acknowledgment"]) {
        it(`preserves human ${hidden ? "hide" : "show"} when ${first} commits first`, async (t) => {
          const input = await visibilityAcknowledgmentFixture(t, driver, hidden);
          const actions = {
            visibility: () => input.f.store.setConversationVisibility(input.visibility),
            acknowledgment: () => input.f.store.acknowledgeWorkResult(input.acknowledgment),
          };
          const results = [
            await actions[first](),
            await actions[first === "visibility" ? "acknowledgment" : "visibility"](),
          ];
          await input.f.reopen();
          await assertManualVisibilityWins(input,
            results[first === "acknowledgment" ? 0 : 1], results[first === "visibility" ? 0 : 1]);
        });
      }
    }
  });
}

describe("SQLite writer manual visibility and result acknowledgment interleaving", () => {
  for (const hidden of [false, true]) {
    it(`preserves human ${hidden ? "hide" : "show"} across independent writers`, async (t) => {
      const driver = drivers.find((d) => d.name === "sqlite writer RPC");
      const input = await visibilityAcknowledgmentFixture(t, driver, hidden);
      const second = await SqliteSplitAuthorityStore.open(input.f.path);
      t.after(() => second.close());
      const [visibility, acknowledgment] = await Promise.all([
        second.setConversationVisibility(input.visibility),
        input.f.store.acknowledgeWorkResult(input.acknowledgment),
      ]);
      await assertManualVisibilityWins(input, acknowledgment, visibility);
      assert.deepEqual(await second.getConversationPref(ORG, input.item.thread_id),
        await input.f.store.getConversationPref(ORG, input.item.thread_id));
    });
  }
});

describe("postgres manual visibility and result acknowledgment interleaving", {
  skip: !process.env.TEST_DATABASE_URL?.trim(),
}, () => {
  for (const hidden of [false, true]) {
    for (const first of ["visibility", "acknowledgment"]) {
      it(`preserves human ${hidden ? "hide" : "show"} while ${first} holds the conversation lock`, {
        timeout: 45_000,
      }, async (t) => {
        const driver = drivers.find((d) => d.name === "postgres");
        const input = await visibilityAcknowledgmentFixture(t, driver, hidden);
        const { f } = input;
        const actions = {
          visibility: () => f.store.setConversationVisibility(input.visibility),
          acknowledgment: () => f.store.acknowledgeWorkResult(input.acknowledgment),
        };
        const results = await interleavePostgresTransactions(
          f, actions[first], actions[first === "visibility" ? "acknowledgment" : "visibility"], async () => {
            assert.equal((await f.store.getConversationPref(ORG, input.item.thread_id))?.hidden ?? false, false);
            assert.equal((await f.store.getConversationPref(ORG, input.item.thread_id))?.visibility_version ?? 0, 0);
            assert.equal((await f.store.getWorkItem(ORG, input.item.id)).acknowledged_run_id, undefined);
          },
        );
        await assertManualVisibilityWins(input,
          results[first === "acknowledgment" ? 0 : 1], results[first === "visibility" ? 0 : 1]);
      });
    }
  }
});

async function failedResultRetryFixture(t, driver) {
  const f = await fixture(t, driver, { write_back_required: false, trigger_kind: "push" });
  const item = await observeWorkAsTestState(f, "failed", LATER, { summary: "Execution failed" });
  const run = await f.store.getWorkRun(ORG, f.run.id);
  return {
    f,
    item,
    run,
    acknowledgment: {
      expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
      expected_version: item.version, expected_run_version: run.version,
      command_id: "ack-competing-retry", issued_at: LATER, now: LATER,
    },
    retry: {
      expected_item: item, expected_version: item.version, retry: "automatic",
      require_current_work_trigger: true,
      run: {
        id: "run-competing-retry", org_id: ORG, work_item_id: item.id,
        recipe_id: f.recipe.id, executor_type: "test", status: "running",
        start_state: "pending", write_back_required: false, trigger_kind: "push",
        created_at: LATER, updated_at: LATER,
      },
    },
  };
}

async function assertFailedResultRetryWinner(input, driver, acknowledgment, retried) {
  const { f, item, run, retry } = input;
  assert.equal(Number(acknowledgment.outcome === "applied") + Number(retried), 1);
  const current = await f.store.getWorkItem(ORG, item.id);
  assert.equal(current.version, item.version + 1);
  assert.equal(current.status, retried ? "running" : "failed");
  assert.equal(current.current_run_id, retried ? retry.run.id : run.id);
  assert.equal(current.acknowledged_run_id, retried ? undefined : run.id);
  assert.deepEqual(await f.store.getWorkRun(ORG, run.id), run);
  assert.equal((await f.store.listWorkRuns(ORG, item.id)).length, retried ? 2 : 1);
  const retryRun = await f.store.getWorkRun(ORG, retry.run.id);
  if (retried) {
    assert.deepEqual(acknowledgment, { outcome: "conflict", reason: "stale_result" });
    assert.equal(retryRun.status, "running");
    assert.equal(retryRun.start_state, "pending");
    assert.equal(retryRun.external_run_id, undefined);
  } else {
    assert.equal(retryRun, null);
    assert.deepEqual(acknowledgment.item, current);
  }
  const disposition = retried ? "current_work" : "outside_current_work";
  assert.equal((await f.store.getDisposition(item.head_event_id)).disposition, disposition);
  assert.equal((await f.store.listInbox(ORG, { disposition: "current_work" }))
    .some((row) => row.event.id === item.head_event_id), retried);
  assert.equal(await f.store.getWorkDeliveryByItem(ORG, item.id), null);
  const replay = await f.store.acknowledgeWorkResult(input.acknowledgment);
  assert.equal(replay.outcome, retried ? "conflict" : "replayed");
  // A freshly read snapshot must not reopen an acknowledged failure either.
  const nextRunId = "run-after-ack-retry-race";
  assert.equal(await f.store.claimWorkRunStart({
    ...retry, expected_item: current, expected_version: current.version,
    require_current_work_trigger: false, run: { ...retry.run, id: nextRunId },
  }), false);
  assert.equal(await f.store.getWorkRun(ORG, nextRunId), null);
  assert.deepEqual(await f.store.getWorkItem(ORG, item.id), current);
  let audit;
  if (driver.name === "memory authority") {
    audit = f.store.listAcknowledgmentLifecycleEvents()
      .filter((event) => event.command_id === input.acknowledgment.command_id);
  } else if (driver.name === "postgres") {
    audit = (await f.query(`SELECT event_type FROM conversation_lifecycle_events
      WHERE org_id = $1 AND command_id = $2`, [ORG, input.acknowledgment.command_id])).rows;
  } else {
    const db = new Database(f.path, { readonly: true });
    try {
      audit = db.prepare(`SELECT event_type FROM conversation_lifecycle_events
        WHERE org_id = ? AND command_id = ?`).all(ORG, input.acknowledgment.command_id);
    } finally {
      db.close();
    }
  }
  assert.deepEqual(audit.map((event) => event.event_type), retried ? [] : ["work_acknowledged"]);
}

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} failed-result acknowledgment and automatic retry`, { skip: driver.skip }, () => {
    for (const first of ["acknowledgment", "retry", "concurrent"]) {
      it(`allows only one transition with ${first === "concurrent" ? "simultaneous commands" : `${first} committing first`}`, async (t) => {
        const input = await failedResultRetryFixture(t, driver);
        const actions = {
          acknowledgment: () => input.f.store.acknowledgeWorkResult(input.acknowledgment),
          retry: () => input.f.store.claimWorkRunStart(input.retry),
        };
        let acknowledgment;
        let retried;
        if (first === "concurrent") {
          [acknowledgment, retried] = await Promise.all([actions.acknowledgment(), actions.retry()]);
        } else if (first === "acknowledgment") {
          acknowledgment = await actions.acknowledgment();
          retried = await actions.retry();
          assert.equal(acknowledgment.outcome, "applied");
        } else {
          retried = await actions.retry();
          acknowledgment = await actions.acknowledgment();
          assert.equal(retried, true);
        }
        await input.f.reopen();
        await assertFailedResultRetryWinner(input, driver, acknowledgment, retried);
      });
    }
  });
}

describe("SQLite writer failed-result acknowledgment and automatic retry", () => {
  for (const first of ["acknowledgment", "retry"]) {
    it(`fences independent writers when ${first} is submitted first`, async (t) => {
      const driver = drivers.find((d) => d.name === "sqlite writer RPC");
      const input = await failedResultRetryFixture(t, driver);
      const { f } = input;
      const second = await SqliteSplitAuthorityStore.open(f.path);
      t.after(() => second.close());
      const actions = {
        acknowledgment: () => f.store.acknowledgeWorkResult(input.acknowledgment),
        retry: () => second.claimWorkRunStart(input.retry),
      };
      const results = await Promise.all([
        actions[first](), actions[first === "acknowledgment" ? "retry" : "acknowledgment"](),
      ]);
      const acknowledgment = results[first === "acknowledgment" ? 0 : 1];
      const retried = results[first === "retry" ? 0 : 1];
      await assertFailedResultRetryWinner(input, driver, acknowledgment, retried);
      assert.deepEqual(await second.getWorkItem(ORG, input.item.id), await f.store.getWorkItem(ORG, input.item.id));
    });
  }
});

describe("postgres failed-result acknowledgment and automatic retry interleaving", {
  skip: !process.env.TEST_DATABASE_URL?.trim(),
}, () => {
  for (const first of ["acknowledgment", "retry"]) {
    it(`fences the losing command while ${first} holds the conversation lock`, { timeout: 45_000 }, async (t) => {
      const driver = drivers.find((d) => d.name === "postgres");
      const input = await failedResultRetryFixture(t, driver);
      const { f } = input;
      const actions = {
        acknowledgment: () => f.store.acknowledgeWorkResult(input.acknowledgment),
        retry: () => f.store.claimWorkRunStart(input.retry),
      };
      const results = await interleavePostgresTransactions(
        f, actions[first], actions[first === "acknowledgment" ? "retry" : "acknowledgment"], async () => {
          assert.deepEqual(await f.store.getWorkItem(ORG, input.item.id), input.item);
          assert.equal(await f.store.getWorkRun(ORG, input.retry.run.id), null);
          assert.equal((await f.store.getDisposition(input.item.head_event_id)).disposition, "current_work");
        },
      );
      const acknowledgment = results[first === "acknowledgment" ? 0 : 1];
      const retried = results[first === "retry" ? 0 : 1];
      assert.equal(first === "retry" ? retried : acknowledgment.outcome === "applied", true);
      await assertFailedResultRetryWinner(input, driver, acknowledgment, retried);
    });
  }
});

describe("memory authority acknowledgment cleanup", () => {
  it("clears acknowledgment replay and audit facts with operational data", async (t) => {
    const driver = { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) };
    const f = await fixture(t, driver);
    assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
    const item = await f.store.getWorkItem(ORG, f.item.id);
    const run = await f.store.getWorkRun(ORG, f.run.id);
    const acknowledgment = {
      expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
      expected_version: item.version, expected_run_version: run.version,
      command_id: "cleared-command", issued_at: LATER, now: LATER,
    };
    assert.equal((await f.store.acknowledgeWorkResult(acknowledgment)).outcome, "applied");
    await f.store.clearOperationalData(ORG, LATER);
    assert.deepEqual(f.store.listAcknowledgmentLifecycleEvents(), []);
    assert.deepEqual(await f.store.acknowledgeWorkResult(acknowledgment),
      { outcome: "conflict", reason: "missing_work" });
    assert.equal((await f.store.setConversationVisibility({
      org_id: ORG, thread_id: item.thread_id, hidden: true, expected_version: 0,
      command_id: acknowledgment.command_id, issued_at: LATER, updated_at: LATER,
    })).outcome, "applied");
  });
});

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} source alias fencing`, { skip: driver.skip }, () => {
    it("binds current events idempotently without taking over an occupied identity", async (t) => {
      const f = await fixture(t, driver, {}, false, { startRun: false });
      const occupied = await f.store.append({
        id: "occupied-alias", org_id: ORG, source: "source", external_id: "occupied",
        thread_id: "source:other", content_hash: "b".repeat(64),
        content_media_type: "text/plain", content_byte_size: 1, occurred_at: NOW, expected_head_id: null,
      });
      const aliases = [
        { source: "source", external_id: "new-native-id" },
        { source: "source", external_id: "occupied" },
      ];
      const binding = { org_id: ORG, event_id: f.item.head_event_id, aliases };
      await f.store.bindSourceIdentityAliases(binding);
      await f.store.bindSourceIdentityAliases(binding);
      assert.equal((await f.store.findBySourceIdentity({ org_id: ORG, ...aliases[0] })).id, f.item.head_event_id);
      assert.equal((await f.store.findBySourceIdentity({ org_id: ORG, ...aliases[1] })).id, occupied.id);
    });

    it("does not revive a superseded event through a new alias", async (t) => {
      const f = await fixture(t, driver, {}, false, { startRun: false });
      await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden, true);
      const original = {
        org_id: ORG, source: "source", external_id: "work-trigger-event",
        thread_id: f.item.thread_id,
      };
      await f.store.markTombstone({
        ...original, expected_head_id: f.item.head_event_id, occurred_at: LATER,
      });
      const fold = {
        org_id: ORG, thread_id: f.item.thread_id,
        expected_visibility_version: 0, updated_at: LATER,
      };
      assert.equal((await f.store.setConversationPolicyHidden(fold)).outcome, "unchanged");
      const alias = { source: "source", external_id: "new-native-id" };
      await assert.rejects(f.store.bindSourceIdentityAliases({
        org_id: ORG, event_id: f.item.head_event_id,
        aliases: [{ source: original.source, external_id: original.external_id }, alias],
      }), { name: "AuthorityConflictError" });
      assert.equal(await f.store.findBySourceIdentity({ org_id: ORG, ...alias }), null);
      assert.equal((await f.store.findBySourceIdentity(original)).operation, "tombstone");
      assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id)).hidden, true);
      assert.deepEqual(await f.store.observeWorkItem({
        expected_item: null,
        item: { ...f.item, id: "revived-work", unit_key: "revived" },
      }), { outcome: "conflict", reason: "trigger_not_current_work" });
      await f.store.bindSourceIdentityAliases({
        org_id: ORG, event_id: f.item.head_event_id,
        aliases: [{ source: original.source, external_id: original.external_id }],
      });
    });

    it("keeps a still-current alias visible when binding races a tombstone", async (t) => {
      const f = await fixture(t, driver, {}, false, { startRun: false });
      await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const alias = { source: "source", external_id: "racing-native-id" };
      const [binding, tombstone] = await Promise.allSettled([
        f.store.bindSourceIdentityAliases({
          org_id: ORG, event_id: f.item.head_event_id, aliases: [alias],
        }),
        f.store.markTombstone({
          org_id: ORG, source: "source", external_id: "work-trigger-event",
          thread_id: f.item.thread_id, expected_head_id: f.item.head_event_id, occurred_at: LATER,
        }),
      ]);
      assert.equal(tombstone.status, "fulfilled");
      if (binding.status === "rejected") assert.equal(binding.reason.name, "AuthorityConflictError");
      const aliased = await f.store.findBySourceIdentity({ org_id: ORG, ...alias });
      assert.equal(aliased?.id ?? null, binding.status === "fulfilled" ? f.item.head_event_id : null);
      const fold = await f.store.setConversationPolicyHidden({
        org_id: ORG, thread_id: f.item.thread_id,
        expected_visibility_version: 0, updated_at: LATER,
      });
      assert.equal(fold.outcome, aliased ? "unchanged" : "applied");
    });
  });
}

for (const driver of [
  { name: "memory authority", open: async () => ({ store: new MemoryAuthorityStore() }) },
  ...drivers.filter((d) => d.name !== "memory"),
]) {
  describe(`${driver.name} current-work trigger fencing`, { skip: driver.skip }, () => {
    for (const otherIsCurrent of [true, false]) {
      it(`checks ${otherIsCurrent ? "current" : "superseded"} legacy work before folding an acknowledged result`, { skip: driver.name === "memory authority" }, async (t) => {
        const f = await fixture(t, driver);
        const other = await f.store.append({
          id: "legacy-other", org_id: ORG, source: "source",
          external_id: "conversation:other", content_hash: "d".repeat(64),
          content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: NOW, expected_head_id: null,
        });
        await f.store.putDispositionIfAbsent({
          event_id: other.id, org_id: ORG, disposition: "current_work",
          layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
        });
        if (!otherIsCurrent) {
          await f.store.markTombstone({
            org_id: ORG, source: other.source, external_id: other.external_id,
            expected_head_id: other.id, occurred_at: LATER,
          });
        }
        assert.equal((await f.store.commitWorkObservation({ ...f.input, can_write_back: false })).outcome, "applied");
        const item = await f.store.getWorkItem(ORG, f.item.id);
        const run = await f.store.getWorkRun(ORG, f.run.id);
        assert.equal((await f.store.acknowledgeWorkResult({
          expected_item: item, run_id: run.id, trigger_event_id: item.head_event_id,
          expected_version: item.version, expected_run_version: run.version,
          command_id: "ack-legacy-other", issued_at: LATER, now: LATER,
        })).outcome, "applied");
        assert.equal((await f.store.getConversationPref(ORG, item.thread_id))?.hidden ?? false, !otherIsCurrent);
      });
    }

    it("blocks folds for current work without a persisted thread id", async (t) => {
      const f = await fixture(t, driver, {}, false, { startRun: false });
      const event = await f.store.append({
        id: "legacy-thread-event", org_id: ORG, source: "source",
        external_id: "legacy:message", content_hash: "d".repeat(64),
        content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: NOW, expected_head_id: null,
      });
      await f.store.putDispositionIfAbsent({
        event_id: event.id, org_id: ORG, disposition: "current_work",
        layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: NOW,
      });
      const fold = {
        org_id: ORG, thread_id: "source:legacy",
        expected_visibility_version: 0, updated_at: LATER,
      };
      assert.deepEqual(await f.store.setConversationPolicyHidden(fold), { outcome: "unchanged" });
      assert.equal((await f.store.setConversationPolicyHidden({
        ...fold, thread_id: "source:unrelated",
      })).outcome, "applied");
      await f.store.markTombstone({
        org_id: ORG, source: event.source, external_id: event.external_id,
        expected_head_id: event.id, occurred_at: LATER,
      });
      assert.equal((await f.store.setConversationPolicyHidden(fold)).outcome, "applied");
    });

    for (const replacement of ["tombstone", "revise"]) {
      it(`rejects stale observation and automatic start after a ${replacement}`, async (t) => {
        const f = await fixture(t, driver, {}, false, { startRun: false });
        const identity = {
          org_id: ORG, source: "source", external_id: "work-trigger-event",
          thread_id: f.item.thread_id, expected_head_id: f.item.head_event_id,
          occurred_at: LATER,
        };
        if (replacement === "tombstone") {
          await f.store.markTombstone(identity);
        } else {
          await f.store.appendRevision({
            ...identity, parent_event_id: f.item.head_event_id,
            content_hash: "b".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
          });
        }
        assert.deepEqual(await f.store.observeWorkItem({
          expected_item: f.item,
          item: { ...f.item, thread_facet: "stale", updated_at: LATER },
        }), { outcome: "conflict", reason: "trigger_not_current_work" });
        assert.equal(await f.store.claimWorkRunStart({
          run: f.run, expected_item: f.item, require_current_work_trigger: true,
        }), false);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.equal(await f.store.getWorkRun(ORG, f.run.id), null);

        const fold = {
          org_id: ORG, thread_id: f.item.thread_id,
          expected_visibility_version: 0, updated_at: LATER,
        };
        assert.deepEqual(await f.store.setConversationPolicyHidden(fold), { outcome: "unchanged" });
        assert.equal((await f.store.dismissWorkItem({ expected_item: f.item, now: LATER })).outcome, "applied");
        const other = await f.store.append({
          id: "another-current-event", org_id: ORG, source: "source",
          external_id: "another-current-event", thread_id: f.item.thread_id,
          content_hash: "c".repeat(64), content_media_type: "text/plain",
          content_byte_size: 1, occurred_at: LATER, expected_head_id: null,
        });
        await f.store.putDispositionIfAbsent({
          event_id: other.id, org_id: ORG, disposition: "current_work",
          layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: LATER,
        });
        assert.deepEqual(await f.store.setConversationPolicyHidden(fold), { outcome: "unchanged" });
        await f.store.markTombstone({
          org_id: ORG, source: other.source, external_id: other.external_id,
          thread_id: f.item.thread_id, expected_head_id: other.id, occurred_at: LATER,
        });
        assert.equal((await f.store.setConversationPolicyHidden(fold)).outcome, "applied");
        assert.deepEqual(await f.store.observeWorkItem({
          expected_item: null,
          item: { ...f.item, id: "late-work", unit_key: "late-unit" },
        }), { outcome: "conflict", reason: "trigger_not_current_work" });
      });
    }

    for (const moved of [false, true]) {
      it(`serializes a ${moved ? "cross-thread " : ""}tombstone against a new work observation before folding`, async (t) => {
        const f = await fixture(t, driver, {}, false, { startRun: false });
        assert.equal((await f.store.dismissWorkItem({ expected_item: f.item, now: LATER })).outcome, "applied");
        const [observation] = await Promise.all([
          f.store.observeWorkItem({
            expected_item: null,
            item: { ...f.item, id: "racing-work", unit_key: "racing-unit" },
          }),
          f.store.markTombstone({
            org_id: ORG, source: "source", external_id: "work-trigger-event",
            thread_id: moved ? "source:moved-conversation" : f.item.thread_id,
            expected_head_id: f.item.head_event_id, occurred_at: LATER,
          }),
        ]);
        assert.ok(["applied", "conflict"].includes(observation.outcome));
        if (observation.outcome === "conflict") {
          assert.equal(observation.reason, "trigger_not_current_work");
        }
        const fold = await f.store.setConversationPolicyHidden({
          org_id: ORG, thread_id: f.item.thread_id,
          expected_visibility_version: 0, updated_at: LATER,
        });
        assert.equal(fold.outcome, observation.outcome === "applied" ? "unchanged" : "applied");
      });
    }

    it("rejects a stale inbox scan after its trigger is triaged out of current work", async (t) => {
      const f = await fixture(t, driver);
      await setDisposition(f.store, {
        event_id: f.item.head_event_id,
        org_id: ORG,
        disposition: "outside_current_work",
        layer: "L1_event",
        reason_codes: ["manual_triage"],
        score: 0,
        decided_at: LATER,
      });
      const result = await f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, thread_facet: "stale-observation", updated_at: LATER },
      });
      assert.deepEqual(result, {
        outcome: "conflict",
        reason: "trigger_not_current_work",
      });
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      const otherThreadEvent = await f.store.append({
        id: "other-thread-trigger",
        org_id: ORG,
        source: "source",
        external_id: "other-thread-trigger",
        content_hash: "b".repeat(64),
        content_media_type: "text/plain",
        content_byte_size: 1,
        thread_id: "source:other-conversation",
        occurred_at: LATER,
        expected_head_id: null,
      });
      await f.store.putDispositionIfAbsent({
        event_id: otherThreadEvent.id,
        org_id: ORG,
        disposition: "current_work",
        layer: "L1_event",
        reason_codes: ["task"],
        score: 1,
        decided_at: LATER,
      });
      const misplaced = await f.store.observeWorkItem({
        expected_item: null,
        item: {
          ...f.item,
          id: "work-with-misplaced-trigger",
          unit_key: "misplaced-trigger",
          head_event_id: otherThreadEvent.id,
          status: "open",
          current_run_id: undefined,
          acknowledged_run_id: undefined,
          version: 0,
          created_at: LATER,
          updated_at: LATER,
        },
      });
      assert.deepEqual(misplaced, {
        outcome: "conflict",
        reason: "trigger_not_current_work",
      });
      assert.equal(await f.store.getWorkItem(ORG, "work-with-misplaced-trigger"), null);
    });

    it("rechecks trigger disposition in the atomic run reservation", async (t) => {
      const f = await fixture(t, driver);
      async function prepareTrigger(suffix) {
        const event = await f.store.append({
          id: `reservation-trigger-${suffix}`,
          org_id: ORG,
          source: "source",
          external_id: `reservation-trigger-${suffix}`,
          content_hash: suffix === "valid" ? "c".repeat(64) : "d".repeat(64),
          content_media_type: "text/plain",
          content_byte_size: 1,
          thread_id: "source:reservation",
          occurred_at: LATER,
          expected_head_id: null,
        });
        const disposition = {
          event_id: event.id,
          org_id: ORG,
          disposition: "current_work",
          layer: "L1_event",
          reason_codes: ["task"],
          score: 1,
          decided_at: LATER,
        };
        await f.store.putDispositionIfAbsent(disposition);
        const observed = await f.store.observeWorkItem({
          expected_item: null,
          item: {
            id: `reservation-work-${suffix}`,
            org_id: ORG,
            thread_id: "source:reservation",
            unit_key: event.id,
            head_event_id: event.id,
            record_class: "task",
            thread_facet: "ticket",
            status: "open",
            recipe_id: f.recipe.id,
            created_at: LATER,
            updated_at: LATER,
          },
        });
        assert.equal(observed.outcome, "applied");
        return { event, disposition, item: observed.item };
      }

      const revoked = await prepareTrigger("revoked");
      await setDisposition(f.store, {
        ...revoked.disposition,
        disposition: "outside_current_work",
        reason_codes: ["manual_triage"],
        score: 0,
      });
      assert.equal(await f.store.claimWorkRunStart({
        run: {
          id: "reservation-run-revoked",
          org_id: ORG,
          work_item_id: revoked.item.id,
          recipe_id: f.recipe.id,
          executor_type: "test",
          status: "running",
          start_state: "pending",
          trigger_kind: "push",
          created_at: LATER,
          updated_at: LATER,
        },
        expected_item: revoked.item,
        require_current_work_trigger: true,
      }), false);
      assert.deepEqual(await f.store.getWorkItem(ORG, revoked.item.id), revoked.item);
      assert.equal(await f.store.getWorkRun(ORG, "reservation-run-revoked"), null);

      const valid = await prepareTrigger("valid");
      assert.equal(await f.store.claimWorkRunStart({
        run: {
          id: "reservation-run-valid",
          org_id: ORG,
          work_item_id: valid.item.id,
          recipe_id: f.recipe.id,
          executor_type: "test",
          status: "running",
          start_state: "pending",
          trigger_kind: "push",
          created_at: LATER,
          updated_at: LATER,
        },
        expected_item: valid.item,
        require_current_work_trigger: true,
      }), true);
    });
  });
}

describe("memory authority current-work trigger fencing", () => {
  it("keeps event dispositions and work-observation eligibility in sync", async () => {
    const store = new MemoryAuthorityStore();
    const event = await store.append({
      id: "memory-trigger",
      org_id: ORG,
      source: "source",
      external_id: "memory-trigger",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      thread_id: "source:conversation",
      occurred_at: NOW,
      expected_head_id: null,
    });
    await setDisposition(store, {
      event_id: event.id,
      org_id: ORG,
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: ["task"],
      score: 1,
      decided_at: NOW,
    });
    const item = {
      id: "memory-work",
      org_id: ORG,
      thread_id: "source:conversation",
      unit_key: event.id,
      head_event_id: event.id,
      record_class: "task",
      thread_facet: "ticket",
      status: "open",
      created_at: NOW,
      updated_at: NOW,
    };
    const created = await store.observeWorkItem({ expected_item: null, item });
    assert.equal(created.outcome, "applied");
    await setDisposition(store, {
      event_id: event.id,
      org_id: ORG,
      disposition: "outside_current_work",
      layer: "L1_event",
      reason_codes: ["manual_triage"],
      score: 0,
      decided_at: LATER,
    });
    const stale = await store.observeWorkItem({
      expected_item: created.item,
      item: { ...created.item, thread_facet: "stale", updated_at: LATER },
    });
    assert.deepEqual(stale, {
      outcome: "conflict",
      reason: "trigger_not_current_work",
    });
    assert.deepEqual(await store.getWorkItem(ORG, item.id), created.item);
  });
});

const postgresDriver = drivers.find((driver) => driver.name === "postgres");
describe("postgres observation rollback", { skip: postgresDriver.skip }, () => {
  it("rolls back observed work updates when their lifecycle audit cannot be written", async (t) => {
    const f = await fixture(t, postgresDriver);
    await f.query(`CREATE FUNCTION reject_work_item_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'work item audit rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_work_item_audit
      BEFORE INSERT ON conversation_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION reject_work_item_audit()`);
    try {
      await assert.rejects(f.store.observeWorkItem({
        expected_item: f.item,
        item: { ...f.item, thread_facet: "updated", updated_at: LATER },
      }), /work item audit rejected/);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_work_item_audit ON conversation_lifecycle_events");
      await f.query("DROP FUNCTION IF EXISTS reject_work_item_audit()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
  });

  it("rolls back uncertain-start confirmation when its audit event cannot be written", async (t) => {
    const { f, input } = await startCheckpointFixture(t, postgresDriver);
    const uncertain = await f.store.checkpointWorkRunStart({
      ...input, kind: "uncertain", error: "Start response was lost",
    });
    assert.equal(uncertain.outcome, "applied");
    await f.query(`CREATE FUNCTION reject_start_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'start audit rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_start_audit
      BEFORE INSERT ON conversation_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION reject_start_audit()`);
    try {
      await assert.rejects(f.store.checkpointWorkRunStart({
        expected_item: uncertain.item,
        expected_run: uncertain.run,
        kind: "submitted",
        external_run_id: "external-1",
        agent_thread_id: "executor:conversation",
        now: LATER,
      }), /start audit rejected/);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_start_audit ON conversation_lifecycle_events");
      await f.query("DROP FUNCTION IF EXISTS reject_start_audit()");
    }
    assert.deepEqual(await f.store.getWorkRun(ORG, uncertain.run.id), uncertain.run);
    assert.deepEqual(await f.store.getWorkItem(ORG, uncertain.item.id), uncertain.item);
  });

  it("rolls back dismissal when its visibility fold audit fails", async (t) => {
    const f = await fixture(t, postgresDriver);
    await f.query(`CREATE FUNCTION reject_dismissal_visibility() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'visibility_changed' THEN
          RAISE EXCEPTION 'dismissal visibility rejected';
        END IF;
        RETURN NEW;
      END $$`);
    await f.query(`CREATE TRIGGER reject_dismissal_visibility
      BEFORE INSERT ON conversation_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION reject_dismissal_visibility()`);
    try {
      await assert.rejects(
        f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
        /dismissal visibility rejected/,
      );
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_dismissal_visibility ON conversation_lifecycle_events");
      await f.query("DROP FUNCTION IF EXISTS reject_dismissal_visibility()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
    assert.equal((await f.store.getDisposition(f.item.head_event_id)).disposition, "current_work");
  });

  it("rolls back delivery stop requests if the dismissal item update fails", async (t) => {
    const f = await fixture(t, postgresDriver);
    const delivery = await seedTestWorkDelivery(f, postgresDriver, enqueueWriteBack({
      org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
      unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
    }));
    await f.query(`CREATE FUNCTION reject_dismissal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'dismissal rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_dismissal
      BEFORE UPDATE ON work_items
      FOR EACH ROW EXECUTE FUNCTION reject_dismissal()`);
    try {
      await assert.rejects(
        f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
        /dismissal rejected/,
      );
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_dismissal ON work_items");
      await f.query("DROP FUNCTION IF EXISTS reject_dismissal()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
    assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
  });

  it("preserves ignored work and run facts when actual-outcome persistence fails", async (t) => {
    const f = await fixture(t, postgresDriver);
    const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
    await f.query(`CREATE FUNCTION reject_ignored_result() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ignored result rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_ignored_result
      BEFORE UPDATE ON work_runs
      FOR EACH ROW EXECUTE FUNCTION reject_ignored_result()`);
    try {
      await assert.rejects(f.store.commitWorkObservation({
        ...f.input, expected_item: dismissed.item,
      }), /ignored result rejected/);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_ignored_result ON work_runs");
      await f.query("DROP FUNCTION IF EXISTS reject_ignored_result()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
    assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
    assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
  });

  it("rolls back both rule rebinding and new run on failure", async (t) => {
    const f = await fixture(t, postgresDriver);
    const item = await observeWorkAsTestState(f, "done");
    await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
    await f.query(`CREATE FUNCTION reject_retry_binding() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'binding rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_retry_binding
      BEFORE UPDATE ON work_items
      FOR EACH ROW EXECUTE FUNCTION reject_retry_binding()`);
    try {
      await assert.rejects(f.store.claimWorkRunStart({
        expected_item: item,
        retry: "manual",
        rebind: "manual",
        run: {
          ...f.run,
          id: "trial-run",
          recipe_id: "selected-rule",
          status: "running",
          start_state: "pending",
        },
      }), /binding rejected/);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_retry_binding ON work_items");
      await f.query("DROP FUNCTION IF EXISTS reject_retry_binding()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
    assert.equal(await f.store.getWorkRun(ORG, "trial-run"), null);
  });

  it("rolls back preflight failure history if the item write fails", async (t) => {
    const f = await fixture(t, postgresDriver, {}, true, { startRun: false });
    await seedLegacyWorkRun(f, postgresDriver, { ...f.run, status: "failed", start_state: undefined });
    const item = await f.store.getWorkItem(ORG, f.item.id);
    await f.query(`CREATE FUNCTION reject_preflight() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'preflight item write rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_preflight
      BEFORE UPDATE ON work_items
      FOR EACH ROW EXECUTE FUNCTION reject_preflight()`);
    try {
      await assert.rejects(f.store.recordWorkRunStartFailure({
        expected_item: item,
        mode: "automatic",
        run: {
          id: "preflight-failure",
          org_id: ORG,
          work_item_id: item.id,
          recipe_id: item.recipe_id,
          executor_type: "missing",
          status: "failed",
          result: { summary: "Unknown executor" },
          write_back_required: false,
          created_at: LATER,
          updated_at: LATER,
        },
      }), /preflight item write rejected/);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_preflight ON work_items");
      await f.query("DROP FUNCTION IF EXISTS reject_preflight()");
    }
    assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
    assert.equal(await f.store.getWorkRun(ORG, "preflight-failure"), null);
  });

  for (const [table, operation] of [
    ["work_deliveries", "INSERT"],
    ["work_items", "UPDATE"],
    ["conversation_lifecycle_events", "INSERT"],
  ]) {
    it(`rolls back every write when ${table} fails after the run update`, async (t) => {
      const f = await fixture(t, postgresDriver);
      await f.query(`CREATE FUNCTION reject_observation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'observation write rejected';
        END $$`);
      await f.query(`CREATE TRIGGER reject_observation
        BEFORE ${operation} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_observation()`);
      try {
        await assert.rejects(f.store.commitWorkObservation(f.input), /observation write rejected/);
      } finally {
        await f.query(`DROP TRIGGER IF EXISTS reject_observation ON ${table}`);
        await f.query("DROP FUNCTION IF EXISTS reject_observation()");
      }
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
    });
  }

  for (const table of ["search_answers", "work_items"]) {
    it(`rolls back the complete timeout when the ${table} write fails`, async (t) => {
      const f = await timeoutFixture(t, postgresDriver);
      const delivery = await seedTestWorkDelivery(f, postgresDriver, enqueueWriteBack({
        org_id: ORG,
        work_item_id: f.item.id,
        recipe_id: f.recipe.id,
        kind: "push",
        unit_key: f.item.unit_key,
        payload: { summary: "Previous result" },
        now: NOW,
      }));
      await f.query(`CREATE FUNCTION reject_timeout() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'timeout rejected';
        END $$`);
      await f.query(`CREATE TRIGGER reject_timeout
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_timeout()`);
      try {
        await assert.rejects(f.store.dismissWorkItem(f.timeout), /timeout rejected/);
      } finally {
        await f.query(`DROP TRIGGER IF EXISTS reject_timeout ON ${table}`);
        await f.query("DROP FUNCTION IF EXISTS reject_timeout()");
      }
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
      assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
    });
  }

  for (const kind of ["failed", "uncertain"]) {
    it(`rolls back the ${kind} checkpoint if the item write fails`, async (t) => {
      const { f, input } = await startCheckpointFixture(t, postgresDriver);
      await f.query(`CREATE FUNCTION reject_start_checkpoint() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'checkpoint write rejected';
        END $$`);
      await f.query(`CREATE TRIGGER reject_start_checkpoint
        BEFORE UPDATE ON work_items
        FOR EACH ROW EXECUTE FUNCTION reject_start_checkpoint()`);
      try {
        await assert.rejects(f.store.checkpointWorkRunStart({
          ...input,
          kind,
          error: "Start error",
        }), /checkpoint write rejected/);
      } finally {
        await f.query("DROP TRIGGER IF EXISTS reject_start_checkpoint ON work_items");
        await f.query("DROP FUNCTION IF EXISTS reject_start_checkpoint()");
      }
      assert.deepEqual(await f.store.getWorkRun(ORG, input.expected_run.id), input.expected_run);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), input.expected_item);
    });
  }

  for (const existing of [false, true]) {
    it(`rolls back ${existing ? "an updated" : "a new"} recipe if work creation fails`, async (t) => {
      const f = await fixture(t, postgresDriver);
      const input = creationInput(f);
      if (existing) {
        await f.store.putRecipe({
          ...input.recipe,
          executor_config: { prompt: "Original" },
          created_at: NOW,
          updated_at: NOW,
        });
        input.expected_recipe = await f.store.getRecipe(ORG, input.recipe.id);
      }
      await f.query(`CREATE FUNCTION reject_creation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'creation rejected';
        END $$`);
      await f.query(`CREATE TRIGGER reject_creation
        BEFORE INSERT ON work_items
        FOR EACH ROW EXECUTE FUNCTION reject_creation()`);
      try {
        await assert.rejects(f.store.createWorkItem(input), /creation rejected/);
      } finally {
        await f.query("DROP TRIGGER IF EXISTS reject_creation ON work_items");
        await f.query("DROP FUNCTION IF EXISTS reject_creation()");
      }
      assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
      assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), input.expected_recipe);
      assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
    });
  }

  it("rolls back a retry run if the final item update fails, without an intermediate open state", async (t) => {
    const f = await fixture(t, postgresDriver);
    const item = await observeWorkAsTestState(f, "failed");
    await f.query(`CREATE FUNCTION reject_retry_item_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'retry item write rejected';
      END $$`);
    await f.query(`CREATE TRIGGER reject_retry_item_write
      BEFORE UPDATE ON work_items
      FOR EACH ROW EXECUTE FUNCTION reject_retry_item_write()`);
    try {
      await assert.rejects(f.store.claimWorkRunStart({
        expected_item: item,
        retry: "manual",
        run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
      }), /retry item write rejected/);
      assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
      assert.equal(await f.store.getWorkRun(ORG, "retry-run"), null);
      await f.query("DROP TRIGGER reject_retry_item_write ON work_items");
      await f.query("DROP FUNCTION reject_retry_item_write()");
      await f.query(`CREATE FUNCTION reject_intermediate_open() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'open' THEN
            RAISE EXCEPTION 'intermediate open forbidden';
          END IF;
          RETURN NEW;
        END $$`);
      await f.query(`CREATE TRIGGER reject_intermediate_open
        BEFORE UPDATE ON work_items
        FOR EACH ROW EXECUTE FUNCTION reject_intermediate_open()`);
      assert.equal(await f.store.claimWorkRunStart({
        expected_item: item,
        retry: "manual",
        run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
      }), true);
    } finally {
      await f.query("DROP TRIGGER IF EXISTS reject_retry_item_write ON work_items");
      await f.query("DROP FUNCTION IF EXISTS reject_retry_item_write()");
      await f.query("DROP TRIGGER IF EXISTS reject_intermediate_open ON work_items");
      await f.query("DROP FUNCTION IF EXISTS reject_intermediate_open()");
    }
  });

  for (const table of ["recipes", "work_items", "search_answers"]) {
    for (const existing of [false, true]) {
      it(`rolls back answer preparation with ${existing ? "existing" : "new"} recipe on ${table} failure`, async (t) => {
        const f = await fixture(t, postgresDriver);
        const input = answerCreationInput(f);
        if (existing) {
          await f.store.putRecipe({
            ...input.recipe,
            executor_config: { prompt: "Original" },
            created_at: NOW,
            updated_at: NOW,
          });
          input.expected_recipe = await f.store.getRecipe(ORG, input.recipe.id);
        }
        const operation = table === "recipes" && existing ? "UPDATE" : "INSERT";
        await f.query(`CREATE FUNCTION reject_answer_creation() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'answer preparation rejected';
          END $$`);
        await f.query(`CREATE TRIGGER reject_answer_creation
          BEFORE ${operation} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION reject_answer_creation()`);
        try {
          await assert.rejects(f.store.createWorkItem(input), /answer preparation rejected/);
        } finally {
          await f.query(`DROP TRIGGER IF EXISTS reject_answer_creation ON ${table}`);
          await f.query("DROP FUNCTION IF EXISTS reject_answer_creation()");
        }
        assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
        assert.equal(await f.store.getSearchAnswer(ORG, input.search_answer.id), null);
        assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), input.expected_recipe);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      });
    }
  }

  for (const table of ["search_answers", "work_items"]) {
    it(`rolls back both preparation deletions when ${table} cleanup fails`, async (t) => {
      const f = await fixture(t, postgresDriver);
      const created = await f.store.createWorkItem(answerCreationInput(f));
      assert.equal(created.outcome, "applied");
      await f.query(`CREATE FUNCTION reject_abort() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'abort rejected';
        END $$`);
      await f.query(`CREATE TRIGGER reject_abort
        BEFORE DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_abort()`);
      try {
        await assert.rejects(f.store.abortWorkItemCreation({
          expected_item: created.item,
          expected_search_answer: created.search_answer,
        }), /abort rejected/);
      } finally {
        await f.query(`DROP TRIGGER IF EXISTS reject_abort ON ${table}`);
        await f.query("DROP FUNCTION IF EXISTS reject_abort()");
      }
      assert.deepEqual(await f.store.getWorkItem(ORG, created.item.id), created.item);
      assert.deepEqual(
        await f.store.getSearchAnswer(ORG, created.search_answer.id),
        created.search_answer,
      );
      assert.deepEqual(await f.store.getRecipe(ORG, created.recipe.id), created.recipe);
    });
  }
});

for (const driver of drivers.filter((d) => d.name.startsWith("sqlite"))) {
  describe(`${driver.name} observation rollback`, () => {
    it("rolls back observed work updates when their lifecycle audit cannot be written", async (t) => {
      const f = await fixture(t, driver);
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_work_item_audit BEFORE INSERT ON conversation_lifecycle_events
          BEGIN SELECT RAISE(ABORT, 'work item audit rejected'); END`);
        await assert.rejects(f.store.observeWorkItem({
          expected_item: f.item,
          item: { ...f.item, thread_facet: "updated", updated_at: LATER },
        }), /work item audit rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
      } finally {
        db.close();
      }
    });

    it("rolls back uncertain-start confirmation when its audit event cannot be written", async (t) => {
      const { f, input } = await startCheckpointFixture(t, driver);
      const uncertain = await f.store.checkpointWorkRunStart({
        ...input, kind: "uncertain", error: "Start response was lost",
      });
      assert.equal(uncertain.outcome, "applied");
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_start_audit BEFORE INSERT ON conversation_lifecycle_events
          BEGIN SELECT RAISE(ABORT, 'start audit rejected'); END`);
        await assert.rejects(f.store.checkpointWorkRunStart({
          expected_item: uncertain.item,
          expected_run: uncertain.run,
          kind: "submitted",
          external_run_id: "external-1",
          agent_thread_id: "executor:conversation",
          now: LATER,
        }), /start audit rejected/);
        assert.deepEqual(await f.store.getWorkRun(ORG, uncertain.run.id), uncertain.run);
        assert.deepEqual(await f.store.getWorkItem(ORG, uncertain.item.id), uncertain.item);
      } finally {
        db.close();
      }
    });

    for (const table of ["search_answers", "work_items"]) {
      it(`rolls back both preparation deletions when ${table} cleanup fails`, async (t) => {
        const f = await fixture(t, driver);
        const input = answerCreationInput(f);
        const created = await f.store.createWorkItem(input);
        assert.equal(created.outcome, "applied");
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_abort BEFORE DELETE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'abort rejected'); END`);
          await assert.rejects(f.store.abortWorkItemCreation({
            expected_item: created.item, expected_search_answer: created.search_answer,
          }), /abort rejected/);
          await f.reopen();
          assert.deepEqual(await f.store.getWorkItem(ORG, created.item.id), created.item);
          assert.deepEqual(await f.store.getSearchAnswer(ORG, created.search_answer.id), created.search_answer);
          assert.deepEqual(await f.store.getRecipe(ORG, created.recipe.id), created.recipe);
        } finally {
          db.close();
        }
      });
    }

    for (const table of ["recipes", "work_items", "search_answers"]) {
      for (const existing of [false, true]) {
        it(`rolls back answer preparation with ${existing ? "existing" : "new"} recipe on ${table} failure`, async (t) => {
          const f = await fixture(t, driver);
          const input = answerCreationInput(f);
          if (existing) {
            await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Original" }, created_at: NOW, updated_at: NOW });
            input.expected_recipe = await f.store.getRecipe(ORG, input.recipe.id);
          }
          const db = new Database(f.path);
          try {
            db.exec(`CREATE TRIGGER reject_answer_creation BEFORE ${table === "recipes" && existing ? "UPDATE" : "INSERT"} ON ${table}
              BEGIN SELECT RAISE(ABORT, 'answer preparation rejected'); END`);
            await assert.rejects(f.store.createWorkItem(input), /answer preparation rejected/);
            await f.reopen();
            assert.equal(await f.store.getSearchAnswer(ORG, input.search_answer.id), null);
            assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
            assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), input.expected_recipe);
          } finally {
            db.close();
          }
        });
      }
    }

    it("does not create work when its recipe update is rejected", async (t) => {
      const f = await fixture(t, driver);
      const expected = await f.store.getRecipe(ORG, f.recipe.id);
      const input = creationInput(f, {
        recipe: { ...expected, executor_config: { prompt: "New configuration" } },
        expected_recipe: expected,
      });
      input.item.recipe_id = expected.id;
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_creation_recipe BEFORE UPDATE ON recipes
          BEGIN SELECT RAISE(ABORT, 'recipe update rejected'); END`);
        await assert.rejects(f.store.createWorkItem(input), /recipe update rejected/);
        assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
        assert.deepEqual(await f.store.getRecipe(ORG, expected.id), expected);
      } finally {
        db.close();
      }
    });

    for (const existing of [false, true]) {
      it(`rolls back ${existing ? "an updated" : "a new"} recipe if work creation fails`, async (t) => {
        const f = await fixture(t, driver);
        const input = creationInput(f);
        if (existing) {
          await f.store.putRecipe({ ...input.recipe, executor_config: { prompt: "Original" }, created_at: NOW, updated_at: NOW });
          input.expected_recipe = await f.store.getRecipe(ORG, input.recipe.id);
        }
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_creation BEFORE INSERT ON work_items
            BEGIN SELECT RAISE(ABORT, 'creation rejected'); END`);
          await assert.rejects(f.store.createWorkItem(input), /creation rejected/);
          await f.reopen();
          assert.equal(await f.store.getWorkItem(ORG, input.item.id), null);
          assert.deepEqual(await f.store.getRecipe(ORG, input.recipe.id), input.expected_recipe);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        } finally {
          db.close();
        }
      });
    }

    for (const table of ["search_answers", "work_items"]) {
      it(`rolls back the complete timeout when the ${table} write fails`, async (t) => {
        const f = await timeoutFixture(t, driver);
        const delivery = await seedTestWorkDelivery(f, driver, enqueueWriteBack({
          org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
          unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
        }));
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_timeout BEFORE UPDATE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'timeout rejected'); END`);
          await assert.rejects(f.store.dismissWorkItem(f.timeout), /timeout rejected/);
          await f.reopen();
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
          assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
          assert.deepEqual(await f.store.getSearchAnswer(ORG, f.record.id), f.record);
          assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
        } finally {
          db.close();
        }
      });
    }

    it("preserves ignored work and run facts when actual-outcome persistence fails", async (t) => {
      const f = await fixture(t, driver);
      const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_ignored_result BEFORE UPDATE ON work_runs
          BEGIN SELECT RAISE(ABORT, 'ignored result rejected'); END`);
        await assert.rejects(f.store.commitWorkObservation({
          ...f.input, expected_item: dismissed.item,
        }), /ignored result rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), dismissed.item);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
        assert.deepEqual(await f.store.listWorkDeliveries(ORG), []);
      } finally {
        db.close();
      }
    });

    it("rolls back delivery stop requests if the dismissal item update fails", async (t) => {
      const f = await fixture(t, driver);
      const delivery = await seedTestWorkDelivery(f, driver, enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: NOW,
      }));
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_dismissal BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'dismissal rejected'); END`);
        await assert.rejects(f.store.dismissWorkItem({ expected_item: f.item, now: LATER }), /dismissal rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.deepEqual(await f.store.getWorkDelivery(ORG, delivery.id), delivery);
        assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
      } finally {
        db.close();
      }
    });

    it("rolls back dismissal when its visibility fold audit fails", async (t) => {
      const f = await fixture(t, driver);
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_dismissal_visibility BEFORE INSERT ON conversation_lifecycle_events
          WHEN NEW.event_type = 'visibility_changed'
          BEGIN SELECT RAISE(ABORT, 'dismissal visibility rejected'); END`);
        await assert.rejects(
          f.store.dismissWorkItem({ expected_item: f.item, now: LATER }),
          /dismissal visibility rejected/,
        );
        await f.reopen();
        assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
        assert.equal((await f.store.getConversationPref(ORG, f.item.thread_id))?.hidden ?? false, false);
      } finally {
        db.close();
      }
    });

    it("rolls back preflight failure history if the item write fails", async (t) => {
      const f = await fixture(t, driver, {}, true, { startRun: false });
      await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
      const item = await f.store.getWorkItem(ORG, f.item.id);
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_preflight BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'preflight item write rejected'); END`);
        await assert.rejects(f.store.recordWorkRunStartFailure({
          expected_item: item, mode: "automatic",
          run: {
            id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
            executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
            write_back_required: false, created_at: LATER, updated_at: LATER,
          },
        }), /preflight item write rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "preflight-failure"), null);
      } finally {
        db.close();
      }
    });

    it("rolls back both rule rebinding and new run on failure", async (t) => {
      const f = await fixture(t, driver);
      const item = await observeWorkAsTestState(f, "done");
      await f.store.putRecipe({ ...f.recipe, id: "selected-rule" });
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_binding BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'binding rejected'); END`);
        await assert.rejects(f.store.claimWorkRunStart({
          expected_item: item, retry: "manual", rebind: "manual",
          run: { ...f.run, id: "trial-run", recipe_id: "selected-rule", status: "running", start_state: "pending" },
        }), /binding rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "trial-run"), null);
      } finally {
        db.close();
      }
    });

    it("rolls back a retry run if the final item update fails, without an intermediate open state", async (t) => {
      const f = await fixture(t, driver);
      const item = await observeWorkAsTestState(f, "failed");
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_retry BEFORE UPDATE ON work_items
          BEGIN SELECT RAISE(ABORT, 'retry item write rejected'); END`);
        await assert.rejects(f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        }), /retry item write rejected/);
        assert.deepEqual(await f.store.getWorkItem(ORG, item.id), item);
        assert.equal(await f.store.getWorkRun(ORG, "retry-run"), null);
        db.exec("DROP TRIGGER reject_retry");
        db.exec(`CREATE TRIGGER reject_intermediate_open BEFORE UPDATE ON work_items
          WHEN NEW.status = 'open' BEGIN SELECT RAISE(ABORT, 'intermediate open forbidden'); END`);
        assert.equal(await f.store.claimWorkRunStart({
          expected_item: item, retry: "manual",
          run: { ...f.run, id: "retry-run", status: "running", start_state: "pending" },
        }), true);
      } finally {
        db.close();
      }
    });

    for (const kind of ["failed", "uncertain"]) {
      it(`rolls back the ${kind} checkpoint if the item write fails`, async (t) => {
        const { f, input } = await startCheckpointFixture(t, driver);
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_start_checkpoint BEFORE UPDATE ON work_items
            BEGIN SELECT RAISE(ABORT, 'checkpoint write rejected'); END`);
          await assert.rejects(f.store.checkpointWorkRunStart({
            ...input, kind, error: "Start error",
          }), /checkpoint write rejected/);
          assert.deepEqual(await f.store.getWorkRun(ORG, input.expected_run.id), input.expected_run);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), input.expected_item);
          db.exec("DROP TRIGGER reject_start_checkpoint");
          assert.equal((await f.store.checkpointWorkRunStart({
            ...input, kind, error: "Start error",
          })).outcome, "applied");
        } finally {
          db.close();
        }
      });
    }

    for (const [table, operation] of [
      ["work_deliveries", "INSERT"],
      ["work_items", "UPDATE"],
      ["conversation_lifecycle_events", "INSERT"],
    ]) {
      it(`rolls back every write when ${table} fails after the run update`, async (t) => {
        const f = await fixture(t, driver);
        const db = new Database(f.path);
        try {
          db.exec(`CREATE TRIGGER reject_observation BEFORE ${operation} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'observation write rejected'); END`);
          await assert.rejects(f.store.commitWorkObservation(f.input), /observation write rejected/);
          assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), f.run);
          assert.deepEqual(await f.store.getWorkItem(ORG, f.item.id), f.item);
          assert.equal(await f.store.getWorkDeliveryByItem(ORG, f.item.id), null);
          db.exec("DROP TRIGGER reject_observation");
          assert.equal((await f.store.commitWorkObservation(f.input)).outcome, "applied");
        } finally {
          db.close();
        }
      });
    }
  });
}

it("fences competing observations from two SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver, {
    write_back_required: true, write_back_target: TARGET, trigger_kind: "push",
  });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([
    f.store.commitWorkObservation(f.input),
    second.commitWorkObservation(f.input),
  ]);
  assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
  assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
  assert.equal((await second.listWorkDeliveries(ORG)).length, 1);
  const delivery = await second.getWorkDeliveryByItem(ORG, f.item.id);
  const resultsOfClaim = await Promise.all([f.store, second].map((store) =>
    store.transitionWorkDelivery({
      org_id: ORG, delivery_id: delivery.id, owner: "same-worker", kind: "claim", now: LATER,
    })));
  assert.equal(resultsOfClaim.filter((row) => row.outcome === "applied").length, 1);
});

it("freezes completed results across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.commitWorkObservation({
      ...f.input, can_write_back: false,
      handle: { ...f.input.handle, result: { summary: `Worker ${index}` } },
    })));
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  const winner = results.find((result) => result.outcome === "applied").transition.run;
  assert.deepEqual(await f.store.getWorkRun(ORG, f.run.id), winner);
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), winner);
  assert.equal((await f.store.getWorkItem(ORG, f.item.id)).status, "done");
});

it("fences competing startup checkpoints across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const { f, input } = await startCheckpointFixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store) =>
    store.checkpointWorkRunStart({ ...input, kind: "uncertain", error: "Response lost" })));
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  assert.deepEqual(await second.getWorkItem(ORG, winner.item.id), winner.item);
  assert.deepEqual(await second.getWorkRun(ORG, winner.run.id), winner.run);
});

it("fences item creation across independent SQLite writer workers without leaking recipes", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = creationInput(f);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const competing = {
    ...input, recipe: { ...input.recipe, id: "losing-recipe" },
    item: { ...input.item, recipe_id: "losing-recipe" },
  };
  const results = await Promise.all([
    f.store.createWorkItem(input), second.createWorkItem(competing),
  ]);
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  const loser = results[0].outcome === "applied" ? competing : input;
  assert.deepEqual(await second.getWorkItem(ORG, input.item.id), winner.item);
  assert.deepEqual(await second.getRecipe(ORG, winner.recipe.id), winner.recipe);
  assert.equal(await second.getRecipe(ORG, loser.recipe.id), null);
});

it("fences shared answer identity across SQLite writers and rolls back losing preparation", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = answerCreationInput(f);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const other = {
    ...input,
    item: { ...input.item, id: "competing-answer-work", recipe_id: "competing-answer-recipe", unit_key: "competing-answer-unit" },
    recipe: { ...input.recipe, id: "competing-answer-recipe" },
    search_answer: { ...input.search_answer, work_item_id: "competing-answer-work" },
  };
  const results = await Promise.all([f.store.createWorkItem(input), second.createWorkItem(other)]);
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  const loser = results[0].outcome === "applied" ? other : input;
  assert.equal(await second.getWorkItem(ORG, loser.item.id), null);
  assert.equal(await second.getRecipe(ORG, loser.recipe.id), null);
  assert.deepEqual(await second.getSearchAnswer(ORG, input.search_answer.id), winner.search_answer);
  assert.deepEqual(await second.getWorkItem(ORG, winner.item.id), winner.item);
  assert.deepEqual(await second.getRecipe(ORG, winner.recipe.id), winner.recipe);
});

it("fences preparation abort against run reservation across SQLite writers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = answerCreationInput(f);
  const created = await f.store.createWorkItem(input);
  assert.equal(created.outcome, "applied");
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const run = {
    ...f.run, id: "reserved-or-aborted", work_item_id: created.item.id, recipe_id: created.recipe.id,
    status: "running", start_state: "pending", created_at: LATER, updated_at: LATER,
  };
  const [aborted, claimed] = await Promise.all([
    f.store.abortWorkItemCreation({ expected_item: created.item, expected_search_answer: created.search_answer }),
    second.claimWorkRunStart({ expected_item: created.item, run }),
  ]);
  assert.equal(Number(aborted.outcome === "applied") + Number(claimed), 1);
  if (claimed) {
    const item = await second.getWorkItem(ORG, created.item.id);
    assert.equal(item.status, "running");
    assert.equal(item.current_run_id, run.id);
    assert.equal(item.version, created.item.version + 1);
    assert.deepEqual(await second.getWorkRun(ORG, run.id), run);
    assert.deepEqual(await second.getSearchAnswer(ORG, created.search_answer.id), created.search_answer);
  } else {
    assert.equal(await second.getWorkItem(ORG, created.item.id), null);
    assert.equal(await second.getWorkRun(ORG, run.id), null);
    assert.equal(await second.getSearchAnswer(ORG, created.search_answer.id), null);
  }
});

it("allows distinct work to share a concurrently created equivalent recipe across SQLite writers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const input = creationInput(f);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([
    f.store.createWorkItem(input),
    second.createWorkItem({ ...input, item: { ...input.item, id: "second-created-item", unit_key: "second-created-unit" } }),
  ]);
  assert.equal(results.every((result) => result.outcome === "applied"), true);
  assert.deepEqual(results[0].recipe, results[1].recipe);
  for (const result of results) assert.deepEqual(await second.getWorkItem(ORG, result.item.id), result.item);
});

it("fences timeout and human cancellation across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await timeoutFixture(t, driver);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [timeout, cancel] = await Promise.all([
    f.store.dismissWorkItem(f.timeout),
    second.dismissWorkItem({ expected_item: f.item, now: LATER }),
  ]);
  assert.equal(Number(timeout.outcome === "applied") + Number(cancel.outcome === "applied"), 1);
  const item = await second.getWorkItem(ORG, f.item.id);
  const record = await second.getSearchAnswer(ORG, f.record.id);
  assert.equal(item.status, "skipped");
  assert.equal(item.version, f.item.version + 1);
  assert.equal(record.outcome, timeout.outcome === "applied" ? "timed_out" : undefined);
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), f.run);
});

it("fences conflicting actual outcomes for ignored work across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const dismissed = await f.store.dismissWorkItem({ expected_item: f.item, now: LATER });
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.commitWorkObservation({
      ...f.input, expected_item: dismissed.item,
      handle: { ...f.input.handle, status: index === 0 ? "completed" : "cancelled" },
    })));
  assert.equal(results.filter((result) => result.outcome === "applied").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  const winner = results.find((result) => result.outcome === "applied");
  assert.deepEqual(await second.getWorkRun(ORG, f.run.id), winner.transition.run);
  assert.deepEqual(await second.getWorkItem(ORG, f.item.id), dismissed.item);
  assert.deepEqual(await second.listWorkDeliveries(ORG), []);
});

it("fences dismissal against retries across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const item = await observeWorkAsTestState(f, "failed");
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [dismissed, started] = await Promise.all([
    f.store.dismissWorkItem({ expected_item: item, now: LATER }),
    second.claimWorkRunStart({
      expected_item: item, retry: "manual",
      run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
    }),
  ]);
  assert.equal(Number(dismissed.outcome === "applied") + Number(started), 1);
  const saved = await second.getWorkItem(ORG, item.id);
  assert.equal(saved.version, item.version + 1);
  assert.equal(saved.status, started ? "running" : "skipped");
  assert.equal(saved.current_run_id, started ? "real-start" : f.run.id);
});

it("fences preflight failures against a real start across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver, {}, true, { startRun: false });
  await seedLegacyWorkRun(f, driver, { ...f.run, status: "failed", start_state: undefined });
  const item = await f.store.getWorkItem(ORG, f.item.id);
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const [failure, started] = await Promise.all([
    f.store.recordWorkRunStartFailure({
      expected_item: item, mode: "manual",
      run: {
        id: "preflight-failure", org_id: ORG, work_item_id: item.id, recipe_id: item.recipe_id,
        executor_type: "missing", status: "failed", result: { summary: "Unknown executor" },
        write_back_required: false, created_at: LATER, updated_at: LATER,
      },
    }),
    second.claimWorkRunStart({
      expected_item: item,
      run: { ...f.run, id: "real-start", status: "running", start_state: "pending" },
    }),
  ]);
  assert.equal(Number(failure.outcome === "applied") + Number(started), 1);
  assert.equal((await second.getWorkItem(ORG, item.id)).version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("fences manual and automatic retries across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const item = await observeWorkAsTestState(f, "failed");
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.claimWorkRunStart({
      expected_item: item, retry: index === 0 ? "manual" : "automatic",
      run: { ...f.run, id: `retry-${index}`, status: "running", start_state: "pending" },
    })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await second.getWorkItem(ORG, item.id)).version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("fences competing rule selections across independent SQLite writer workers", async (t) => {
  const driver = drivers.find((d) => d.name === "sqlite writer RPC");
  const f = await fixture(t, driver);
  const item = await observeWorkAsTestState(f, "failed");
  const second = await SqliteSplitAuthorityStore.open(f.path);
  t.after(() => second.close());
  for (const id of ["selected-0", "selected-1"]) {
    await f.store.putRecipe({ ...f.recipe, id });
  }
  const results = await Promise.all([f.store, second].map((store, index) =>
    store.claimWorkRunStart({
      expected_item: item, retry: "manual", rebind: "manual",
      run: { ...f.run, id: `trial-${index}`, recipe_id: `selected-${index}`, status: "running", start_state: "pending" },
    })));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.indexOf(true);
  const saved = await second.getWorkItem(ORG, item.id);
  assert.equal(saved.recipe_id, `selected-${winner}`);
  assert.equal(saved.current_run_id, `trial-${winner}`);
  assert.equal(saved.version, item.version + 1);
  assert.equal((await second.listWorkRuns(ORG, item.id)).length, 2);
});

it("migrates the v59 delivery table without changing request identities or inventing snapshots", async (t) => {
  const root = join(process.cwd(), `.test-work-ledger-migration-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  let store;
  t.after(async () => {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = new Database(path);
  db.function("conversation_id", (source, externalId, fallbackId) =>
    conversationId(source, externalId, fallbackId));
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= 59)) {
    db.exec(migration.sql);
  }
  db.prepare(`INSERT INTO work_items (
    id, org_id, thread_id, unit_key, record_class, thread_facet, status, created_at, updated_at
  ) VALUES ('legacy-work', ?, 'source:legacy', 'unit', 'task', 'ticket', 'done', ?, ?)`).run(ORG, NOW, NOW);
  db.prepare(`INSERT INTO work_runs (
    id, org_id, work_item_id, recipe_id, executor_type, status, created_at, updated_at
  ) VALUES ('legacy-run', ?, 'legacy-work', 'rule', 'test', 'completed', ?, ?)`).run(ORG, NOW, NOW);
  db.prepare(`INSERT INTO work_deliveries (
    id, org_id, work_item_id, recipe_id, kind, unit_key, status, write_back, attempts,
    payload_json, idempotency_key, channel_receipt_json, created_at, updated_at
  ) VALUES ('legacy-delivery', ?, 'legacy-work', 'rule', 'push', 'unit', 'acked', 'sent', 1,
    '{"summary":"Original result"}', 'original-key', '{"accepted":true,"rpc_id":"original-receipt"}', ?, ?)`)
    .run(ORG, NOW, NOW);
  const before = db.prepare("SELECT * FROM work_deliveries").get();
  db.pragma("user_version = 59");
  db.close();
  store = new SqliteAuthorityStore(path);
  const inspect = new Database(path, { readonly: true });
  try {
    const after = inspect.prepare("SELECT * FROM work_deliveries").get();
    for (const [field, value] of Object.entries(before)) assert.deepEqual(after[field], value);
    assert.equal(after.run_id, null);
    assert.equal(after.target_json, null);
    assert.equal(inspect.prepare("SELECT count(*) AS total FROM work_deliveries").get().total, 1);
    assert.deepEqual(inspect.prepare(`SELECT write_back_required, write_back_target_json, trigger_kind,
      executor_config_json, include_context FROM work_runs`).get(),
    {
      write_back_required: null, write_back_target_json: null, trigger_kind: null,
      executor_config_json: null, include_context: null,
    });
    assert.deepEqual(inspect.pragma("foreign_key_check"), []);
  } finally {
    inspect.close();
  }
});

it("migrates schema 56 without inferring historical current-run identity", async (t) => {
  const root = join(process.cwd(), `.test-work-migration-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  let store;
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = new Database(path);
  db.function("conversation_id", (source, externalId, fallbackId) =>
    conversationId(source, externalId, fallbackId));
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= 56)) {
    db.exec(migration.sql);
  }
  const insertItem = db.prepare(`INSERT INTO work_items (
    id, org_id, thread_id, unit_key, record_class, thread_facet, status, recipe_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'task', 'ticket', ?, ?, ?, ?)`);
  const insertRun = db.prepare(`INSERT INTO work_runs (
    id, org_id, work_item_id, recipe_id, executor_type, status, created_at, updated_at
  ) VALUES (?, ?, ?, 'legacy-recipe', 'test', ?, ?, ?)`);
  insertItem.run("legacy-work", ORG, "source:legacy", "legacy-unit", "done", null, NOW, NOW);
  insertRun.run("legacy-run", ORG, "legacy-work", "completed", NOW, NOW);
  for (const [id, count, status] of [
    ["single-active", 1, "running"],
    ["ambiguous-active", 2, "running"],
    ["single-waiting", 1, "waiting_human"],
    ["terminal-only", 1, "failed"],
  ]) {
    insertItem.run(id, ORG, `source:${id}`, id, "running", "legacy-recipe", NOW, NOW);
    for (let index = 0; index < count; index += 1) {
      insertRun.run(`${id}-${index}`, ORG, id, status, NOW, NOW);
    }
  }
  db.pragma("user_version = 56");
  db.close();
  store = new SqliteAuthorityStore(path);
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual(await store.getWorkItem(ORG, "legacy-work"), {
    id: "legacy-work", org_id: ORG, thread_id: "source:legacy",
    unit_key: "legacy-unit", head_event_id: undefined, record_class: "task",
    thread_facet: "ticket", status: "done", recipe_id: undefined,
    current_run_id: undefined, acknowledged_run_id: undefined, version: 0, visibility_intent_version: 0,
    created_at: NOW, updated_at: NOW,
  });
  assert.equal((await store.getWorkRun(ORG, "legacy-run")).version, 0);
  for (const id of ["single-active", "single-waiting"]) {
    assert.equal((await store.getWorkItem(ORG, id)).current_run_id, `${id}-0`);
    assert.equal((await store.getActiveWorkRun(ORG, id)).id, `${id}-0`);
  }
  for (const id of ["ambiguous-active", "terminal-only"]) {
    assert.equal((await store.getWorkItem(ORG, id)).current_run_id, undefined);
    assert.equal(await store.getActiveWorkRun(ORG, id), null);
  }
});
