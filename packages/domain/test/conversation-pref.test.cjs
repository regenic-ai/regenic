const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryAuthorityStore, MemoryWorkStore, collectListSurfacePatches, conversationId } = require("../dist");

function workRecipe(id, orgId, now) {
  return {
    id: `recipe-${id}`,
    org_id: orgId,
    name: "Fixture work",
    match: { record_class: "task" },
    trigger: { kind: "manual" },
    executor_type: "session",
    executor_config: {},
    can_write_back: false,
    include_context: false,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
}

async function createWorkItem(store, item, now) {
  const recipe = workRecipe(item.id, item.org_id, now);
  await store.putRecipe(recipe);
  const result = await store.createWorkItem({
    item: {
      ...item,
      recipe_id: recipe.id,
      status: "open",
      created_at: now,
      updated_at: now,
    },
    recipe,
    expected_recipe: recipe,
  });
  assert.equal(result.outcome, "applied");
  return { item: result.item, recipe };
}

async function completeWorkItem(store, item, recipe, now) {
  const run = {
    id: `run-${item.id}`,
    org_id: item.org_id,
    work_item_id: item.id,
    recipe_id: recipe.id,
    executor_type: recipe.executor_type,
    status: "running",
    start_state: "pending",
    created_at: now,
    updated_at: now,
  };
  assert.equal(await store.claimWorkRunStart({
    run,
    expected_item: item,
    expected_recipe: recipe,
  }), true);
  const reservedItem = await store.getWorkItem(item.org_id, item.id);
  const reservedRun = await store.getWorkRun(item.org_id, run.id);
  const checkpoint = await store.checkpointWorkRunStart({
    expected_item: reservedItem,
    expected_run: reservedRun,
    kind: "submitted",
    external_run_id: `external-${run.id}`,
    now,
  });
  assert.equal(checkpoint.outcome, "applied");
  const observed = await store.commitWorkObservation({
    expected_item: checkpoint.item,
    expected_run: checkpoint.run,
    handle: {
      external_run_id: `external-${run.id}`,
      status: "completed",
      result: { summary: "Completed for fixture" },
    },
    can_write_back: false,
    trigger_kind: "manual",
    now,
  });
  assert.equal(observed.outcome, "applied");
}

describe("conversation prefs", () => {
  it("rejects mismatched sync-page attempt identities before memory authority writes", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const page = {
      attempt: { id: "attempt", org_id: "org", connector_installation_id: "installation",
        stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ id: "event", org_id: "org", source: "synthetic", external_id: "source",
        content_hash: "hash", content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null }], dispositions: [] },
      prefs: [{ org_id: "org", thread_id: "thread", hidden: true, expected_visibility_version: 0, updated_at: now }],
      settle: { attempt_id: "attempt", installation_id: "installation", stream_key: "personal",
        lease_owner: "worker", finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    };
    for (const change of [{ attempt_id: "other" }, { installation_id: "other" }, { stream_key: "other" }]) {
      await assert.rejects(store.commitSyncPage({ ...page, settle: { ...page.settle, ...change } }),
        /Sync page attempt identity/);
      assert.deepEqual(store.allEvents(), []);
      assert.equal(await store.getConversationPref("org", "thread"), null);
    }
    for (const changed of [
      { ingest: { appends: [{ ...page.ingest.appends[0], org_id: "other" }], dispositions: [] } },
      { ingest: { appends: page.ingest.appends, dispositions: [{
        event_id: "event", org_id: "other", disposition: "current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      }] } },
      { prefs: [{ ...page.prefs[0], org_id: "other" }] },
    ]) {
      await assert.rejects(store.commitSyncPage({ ...page, ...changed }), /organization/i);
      assert.deepEqual(store.allEvents(), []);
      assert.equal(await store.getConversationPref("other", "thread"), null);
    }
    assert.equal((await store.commitSyncPage(page)).events.length, 1);
  });

  it("rejects uncloneable event metadata before writing any ingest records", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic", content_hash: "hash",
      content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: null };
    await assert.rejects(store.commitIngest({
      appends: [{ ...base, id: "first", external_id: "one" },
        { ...base, id: "second", external_id: "two", attrs: { invalid: () => {} } }],
      dispositions: [],
    }), { name: "DataCloneError" });
    assert.deepEqual(store.allEvents(), []);
    assert.equal(await store.findBlob("hash"), null);
    assert.equal(await store.findBySourceIdentity({ ...base, external_id: "one" }), null);
  });

  it("rolls back an ingest after a later disposition fails", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic",
      content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: null };
    const threadId = conversationId("synthetic", "one", "first");
    const pref = { org_id: "org", thread_id: threadId, hidden: true,
      expected_visibility_version: 0, updated_at: now };
    await store.setConversationPolicyVisibility(pref);
    store.recordCurrentWorkEvidence("second");
    const decision = (event_id) => ({ event_id, org_id: "org", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now });
    await assert.rejects(store.commitIngest({
      appends: [
        { ...base, id: "first", external_id: "one", content_hash: "one",
          extra_blobs: [{ content_hash: "extra", media_type: "text/plain", byte_size: 1 }] },
        { ...base, id: "second", external_id: "two", content_hash: "two" },
        { ...base, id: "third", external_id: "three", content_hash: "three" },
        { ...base, external_id: "generated", content_hash: "generated" },
      ],
      dispositions: [decision("first"), { ...decision("second"), disposition: "outside_current_work" },
        { ...decision("third"), reason_codes: null }],
    }), TypeError);
    assert.deepEqual(store.allEvents(), []);
    assert.equal(await store.findBySourceIdentity({ ...base, external_id: "one" }), null);
    for (const hash of ["one", "two", "three", "generated", "extra"]) {
      assert.equal(await store.findBlob(hash), null);
    }
    assert.equal(await store.getDisposition("first"), null);
    assert.equal((await store.getConversationPref("org", threadId)).hidden, true);
    assert.deepEqual(store.listIngestionLifecycleEvents(), []);
    assert.deepEqual(store.listCurrentWorkVisibilityEvents(), []);
    assert.equal(MemoryWorkStore.prototype.hasCurrentWorkEvidence.call(store, "first", "org", "thread"), false);
    assert.equal(MemoryWorkStore.prototype.hasCurrentWorkEvidence.call(store, "second", "org", "thread"), true);
    const created = await store.append({ ...base, external_id: "later", content_hash: "later" });
    assert.equal(created.id, "event-1");
  });

  it("rolls back a sync page when a later visibility projection fails", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const source = { org_id: "org", source: "synthetic", external_id: "source", thread_id: "first" };
    await store.append({ ...source, id: "original", content_hash: "hash",
      content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: null });
    await store.putConversationPref({ org_id: "org", thread_id: "first", title: "Keep",
      updated_at: now });
    await store.setConversationPolicyVisibility({ org_id: "org", thread_id: "untouched",
      hidden: true, expected_visibility_version: 0, updated_at: now });
    const original = store.setConversationPolicyVisibilityWithinTurn.bind(store);
    store.setConversationPolicyVisibilityWithinTurn = (input) => {
      const result = original(input);
      if (input.thread_id === "second") throw new Error("visibility write failed");
      return result;
    };
    await assert.rejects(store.commitSyncPage({
      attempt: { id: "attempt", org_id: "org", connector_installation_id: "installation",
        stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ ...source, id: "event", operation: "tombstone", content_hash: "hash",
        content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: "original" }],
        dispositions: [] },
      prefs: [
        { org_id: "org", thread_id: "first", hidden: true, expected_visibility_version: 0,
          updated_at: now, fold_current_tombstone_event_ids: ["event"] },
        { org_id: "org", thread_id: "second", hidden: true, expected_visibility_version: 0, updated_at: now },
      ],
      settle: { attempt_id: "attempt", installation_id: "installation", stream_key: "personal",
        lease_owner: "worker", finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    }), /visibility write failed/);
    assert.deepEqual(store.allEvents().map((event) => event.id), ["original"]);
    assert.equal((await store.findBySourceIdentity(source)).id, "original");
    assert.notEqual(await store.findBlob("hash"), null);
    assert.equal((await store.getConversationPref("org", "first")).title, "Keep");
    assert.equal((await store.getConversationPref("org", "first")).hidden, false);
    assert.equal(await store.getConversationPref("org", "second"), null);
    assert.deepEqual(store.listTombstoneVisibilityEvents(), []);
    assert.deepEqual(store.listPolicyVisibilityEvents().map((event) => event.thread_id), ["untouched"]);
  });

  it("does not interleave source revisions between a memory sync page and its visibility projection", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic", external_id: "source", thread_id: "thread",
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1, occurred_at: now };
    await store.append({ ...base, id: "original", expected_head_id: null });
    const page = store.commitSyncPage({
      attempt: { id: "attempt", org_id: "org", connector_installation_id: "installation",
        stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ ...base, id: "deleted", operation: "tombstone", expected_head_id: "original" }],
        dispositions: [] },
      prefs: [{ org_id: "org", thread_id: "thread", hidden: true, expected_visibility_version: 0,
        updated_at: now, fold_current_tombstone_event_ids: ["deleted"] }],
      settle: { attempt_id: "attempt", installation_id: "installation", stream_key: "personal",
        lease_owner: "worker", finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    });
    const revision = store.appendRevision({
      ...base, id: "replacement", parent_event_id: "deleted", expected_head_id: "deleted",
      disposition: { event_id: "replacement", org_id: "org", disposition: "outside_current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now },
    });
    await Promise.all([page, revision]);
    assert.equal((await store.getConversationPref("org", "thread")).hidden_reason, "policy");
    assert.equal(store.listTombstoneVisibilityEvents().length, 1);
    assert.equal((await store.findBySourceIdentity(base)).id, "replacement");
  });

  it("applies all memory sync-page visibility projections before a concurrent human command", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const page = store.commitSyncPage({
      attempt: { id: "attempt", org_id: "org", connector_installation_id: "installation",
        stream_key: "personal", delivery_id: "page", started_at: now },
      prefs: ["first", "second"].map((thread_id) => ({
        org_id: "org", thread_id, hidden: true, expected_visibility_version: 0, updated_at: now,
      })),
      settle: { attempt_id: "attempt", installation_id: "installation", stream_key: "personal",
        lease_owner: "worker", finished_at: now, accepted_count: 0, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    });
    const human = store.setConversationVisibility({
      org_id: "org", thread_id: "second", hidden: false, expected_version: 0, updated_at: now,
    });
    await Promise.all([page, human]);
    assert.deepEqual(store.listPolicyVisibilityEvents().map((entry) => entry.thread_id), ["first", "second"]);
    assert.equal((await store.getConversationPref("org", "second")).hidden, false);
    assert.equal((await store.getConversationPref("org", "second")).visibility_version, 1);
  });

  it("audits only applied generic policy visibility changes", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const input = { org_id: "org", thread_id: "thread", expected_visibility_version: 0, updated_at: now };
    assert.equal((await store.setConversationPolicyHidden(input)).outcome, "applied");
    assert.deepEqual(await store.setConversationPolicyHidden(input), { outcome: "unchanged" });
    assert.equal((await store.setConversationPolicyVisibility({ ...input, hidden: false })).outcome, "applied");
    assert.deepEqual(await store.setConversationPolicyVisibility({ ...input, hidden: false }), { outcome: "unchanged" });
    assert.deepEqual(await store.setConversationPolicyHidden({ ...input, expected_visibility_version: 1 }),
      { outcome: "conflict", current_version: 0 });
    await store.setConversationVisibility({ org_id: "org", thread_id: "thread", hidden: true,
      expected_version: 0, updated_at: now });
    assert.deepEqual(await store.setConversationPolicyVisibility({ ...input, hidden: false,
      expected_visibility_version: 1 }), { outcome: "unchanged" });
    assert.deepEqual(store.listPolicyVisibilityEvents().map((entry) => ({
      version: entry.aggregate_version, payload: entry.payload,
    })), [
      { version: 0, payload: { hidden: true, hidden_reason: "policy", cause: "policy_visibility_applied" } },
      { version: 0, payload: { hidden: false, hidden_reason: null, cause: "policy_visibility_applied" } },
    ]);
    const snapshot = store.listPolicyVisibilityEvents();
    snapshot[0].payload.hidden = false;
    assert.equal(store.listPolicyVisibilityEvents()[0].payload.hidden, true);
    await store.setConversationPolicyHidden({ ...input, org_id: "other-org" });
    await store.clearOperationalData("org", now);
    assert.deepEqual(store.listPolicyVisibilityEvents().map((entry) => entry.org_id), ["other-org"]);
  });

  it("only folds a tombstone that is still a current head", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic", external_id: "source",
      thread_id: "thread", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now };
    await store.append({ ...base, id: "original", expected_head_id: null });
    const deleted = await store.markTombstone({ ...base, id: "deleted", expected_head_id: "original" });
    const [stale] = await collectListSurfacePatches(store, "org", [deleted.id], { now });
    assert.deepEqual(stale.fold_current_tombstone_event_ids, [deleted.id]);
    await store.appendRevision({
      ...base, id: "replacement", parent_event_id: deleted.id, expected_head_id: deleted.id,
      disposition: { event_id: "replacement", org_id: "org", disposition: "outside_current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now },
    });
    assert.deepEqual(await store.setConversationPolicyVisibility(stale), { outcome: "unchanged" });
    assert.notEqual((await store.getConversationPref("org", "thread"))?.hidden, true);
    const current = await store.markTombstone({ ...base, id: "deleted-again", expected_head_id: "replacement" });
    const [valid] = await collectListSurfacePatches(store, "org", [current.id], { now });
    assert.equal((await store.setConversationPolicyVisibility(valid)).outcome, "applied");
    assert.deepEqual(await store.setConversationPolicyVisibility(valid), { outcome: "unchanged" });
    assert.deepEqual(store.listTombstoneVisibilityEvents().map((entry) => entry.payload), [{
      hidden: true, hidden_reason: "policy", cause: "tombstone_visibility_reconciled", event_id: current.id,
    }]);
    const snapshot = store.listTombstoneVisibilityEvents();
    snapshot[0].payload.event_id = "modified";
    assert.equal(store.listTombstoneVisibilityEvents()[0].payload.event_id, current.id);
    await store.clearOperationalData("org", now);
    assert.deepEqual(store.listTombstoneVisibilityEvents(), []);
  });

  it("serializes in-memory tombstones against the same source head", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic", external_id: "source",
      thread_id: "thread", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now };
    await store.append({ ...base, id: "original", expected_head_id: null });
    const outcomes = await Promise.allSettled([
      store.markTombstone({ ...base, id: "deleted-1", expected_head_id: "original" }),
      store.markTombstone({ ...base, id: "deleted-2", expected_head_id: "original" }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(store.allEvents().length, 2);
  });

  it("rejects malformed tombstone folds before memory sync-page ingest", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    await assert.rejects(store.commitSyncPage({
      attempt: { id: "attempt", org_id: "org", connector_installation_id: "installation",
        stream_key: "personal", delivery_id: "page", started_at: now },
      ingest: { appends: [{ id: "new-event", org_id: "org", source: "synthetic",
        external_id: "source", thread_id: "thread", content_hash: "a".repeat(64),
        content_media_type: "text/plain", content_byte_size: 1, occurred_at: now, expected_head_id: null }],
        dispositions: [] },
      prefs: [{ org_id: "org", thread_id: "thread", hidden: true,
        expected_visibility_version: 0, updated_at: now, fold_current_tombstone_event_ids: [] }],
      settle: { attempt_id: "attempt", installation_id: "installation", stream_key: "personal",
        lease_owner: "worker", finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, quarantines: [] },
    }), /non-empty tombstone event IDs/);
    assert.equal(await store.getEvent("org", "new-event"), null);
  });

  it("audits the first still-valid event from an ingest unfold", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const base = { org_id: "org", source: "synthetic", thread_id: "thread",
      occurred_at: now, expected_head_id: null };
    const appends = ["first", "second"].map((id) => ({ ...base, id, external_id: id }));
    const dispositions = appends.map(({ id }) => ({
      event_id: id, org_id: "org", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    }));
    await store.commitIngest({ appends, dispositions });
    store.prefs.set("org\0thread", { org_id: "org", thread_id: "thread",
      hidden: true, hidden_reason: "policy", visibility_version: 0 });
    assert.equal((await store.setConversationPolicyVisibility({
      org_id: "org", thread_id: "thread", hidden: false, expected_visibility_version: 0,
      updated_at: now, unfold_current_work_event_ids: ["missing", "second", "first"],
    })).outcome, "applied");
    assert.equal(store.listCurrentWorkVisibilityEvents()[0].payload.event_id, "second");
  });

  it("rechecks ingest-derived unfolds against current heads and dispositions", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const event = {
      id: "observed", org_id: "org", source: "synthetic", external_id: "source",
      thread_id: "thread", occurred_at: now, expected_head_id: null,
    };
    const decision = {
      event_id: event.id, org_id: event.org_id, disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    };
    await store.commitIngest({ appends: [event], dispositions: [decision] });
    // Simulate a policy-hidden preference persisted by an older writer.
    store.prefs.set("org\0thread", { org_id: "org", thread_id: "thread",
      hidden: true, hidden_reason: "policy", visibility_version: 0 });
    const [guard] = await collectListSurfacePatches(store, "org", [event.id], { now });
    assert.deepEqual(guard.unfold_current_work_event_ids, [event.id]);
    assert.equal((await store.setConversationPolicyVisibility(guard)).outcome, "applied");
    assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
    assert.deepEqual(store.listCurrentWorkVisibilityEvents().map((entry) => entry.payload), [{
      hidden: false, hidden_reason: null, cause: "current_work_visibility_reconciled", event_id: event.id,
    }]);
    await store.setConversationVisibility({
      org_id: "org", thread_id: "thread", hidden: true, expected_version: 0, updated_at: now,
    });
    assert.deepEqual(await store.setConversationPolicyVisibility({
      ...guard, expected_visibility_version: 1,
    }), { outcome: "unchanged" });
    assert.equal((await store.getConversationPref("org", "thread")).hidden_reason, "human");
    await store.setConversationVisibility({
      org_id: "org", thread_id: "thread", hidden: false, expected_version: 1, updated_at: now,
    });
    store.prefs.set("org\0thread", { org_id: "org", thread_id: "thread",
      hidden: true, hidden_reason: "policy", visibility_version: 2 });
    const [staleGuard] = await collectListSurfacePatches(store, "org", [event.id], { now });
    const expected = await store.getDisposition(event.id);
    const next = { ...expected, disposition: "outside_current_work" };
    await store.transitionDisposition({
      expected, decision: next,
      command: { org_id: "org", event_id: event.id, action: "triage",
        disposition: next.disposition, command_id: "close-observed", issued_at: now },
    });
    assert.deepEqual(await store.setConversationPolicyVisibility(staleGuard), { outcome: "unchanged" });
    assert.equal((await store.getConversationPref("org", "thread")).hidden_reason, "policy");
    assert.equal(store.listCurrentWorkVisibilityEvents().length, 1);
  });

  it("does not list tombstones as current work even when their historical decision says so", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const thread = "synthetic:thread";
    const initial = {
      id: "original", org_id: "local-owner", source: "synthetic", external_id: "source",
      thread_id: thread, content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    const decision = (id) => ({
      event_id: id, org_id: "local-owner", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    });
    await store.commitIngest({ appends: [initial], dispositions: [decision(initial.id)] });
    await store.markTombstone({
      id: "deleted", org_id: "local-owner", source: initial.source, external_id: initial.external_id,
      thread_id: thread, occurred_at: now, expected_head_id: initial.id,
      disposition: decision("deleted"),
    });
    for (const query of [undefined, { thread_ids: [thread] }, { heads: true }, { heads: true, thread_ids: [thread] }, { siblings: true }]) {
      assert.deepEqual(await store.listInbox("local-owner", query), []);
    }
    assert.equal((await store.summarizeInbox("local-owner")).count, 0);
    const live = { ...initial, id: "live", external_id: "live", occurred_at: "2026-08-22T00:00:01.000Z" };
    await store.commitIngest({ appends: [live], dispositions: [decision(live.id)] });
    assert.deepEqual((await store.listInbox("local-owner")).map((row) => row.event.id), [live.id]);
    assert.deepEqual((await store.listInbox("local-owner", { heads: true })).map((row) => row.event.id), [live.id]);
    assert.equal((await store.summarizeInbox("local-owner")).count, 1);
    const expected = await store.getDisposition(live.id);
    const next = { ...expected, disposition: "outside_current_work" };
    assert.equal((await store.transitionDisposition({
      expected, decision: next,
      command: {
        org_id: "local-owner", event_id: live.id, action: "triage", disposition: next.disposition,
        command_id: "close-live", issued_at: now,
      },
    })).outcome, "applied");
    assert.equal((await store.summarizeInbox("local-owner")).count, 0);
    await store.setConversationVisibility({
      org_id: "local-owner", thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
    });
    assert.ok((await store.listInbox("local-owner", { list: "hidden" }))
      .some((row) => row.event.id === "deleted"));
  });

  it("does not treat a current-head tombstone as remaining work when folding", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-22T00:00:00.000Z";
    const tombstone = await store.markTombstone({
      id: "deleted", org_id: "local-owner", source: "synthetic", external_id: "deleted",
      thread_id: "synthetic:thread", expected_head_id: null, occurred_at: now,
    });
    await store.putDispositionIfAbsent({
      event_id: tombstone.id, org_id: "local-owner", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    });
    assert.equal((await store.setConversationPolicyHidden({
      org_id: "local-owner", thread_id: "synthetic:thread",
      expected_visibility_version: 0, updated_at: now,
    })).outcome, "applied");
    const active = await store.append({
      id: "active", org_id: "local-owner", source: "synthetic", external_id: "active",
      thread_id: "synthetic:other", expected_head_id: null, occurred_at: now,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
    });
    await store.putDispositionIfAbsent({
      event_id: active.id, org_id: "local-owner", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    });
    assert.equal((await store.setConversationPolicyHidden({
      org_id: "local-owner", thread_id: "synthetic:other",
      expected_visibility_version: 0, updated_at: now,
    })).outcome, "unchanged");
  });

  it("patches title and pin independently", async () => {
    const store = new MemoryAuthorityStore();
    const first = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: "Release",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(first.pinned, false);
    assert.equal(first.last_read_at, null);
    const read = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      last_read_external_id: "sess-a:3",
      last_read_at: "2026-08-22T00:00:30.000Z",
      updated_at: "2026-08-22T00:00:30.000Z",
    });
    assert.equal(read.title, "Release");
    assert.equal(read.last_read_external_id, "sess-a:3");
    const staleRead = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      last_read_external_id: "sess-a:2",
      last_read_at: "2026-08-22T00:00:20.000Z",
      updated_at: "2026-08-22T00:00:40.000Z",
    });
    assert.equal(staleRead.last_read_at, "2026-08-22T00:00:30.000Z");
    assert.equal(staleRead.last_read_external_id, "sess-a:3");
    const pinned = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      pinned: true,
      updated_at: "2026-08-22T00:01:00.000Z",
    });
    assert.equal(pinned.title, "Release");
    assert.equal(pinned.pinned, true);
    const cleared = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: null,
      updated_at: "2026-08-22T00:02:00.000Z",
    });
    assert.equal(cleared.title, null);
    assert.equal(cleared.pinned, true);
    const listed = await store.listConversationPrefs("local-owner");
    assert.equal(listed.length, 1);
    assert.equal(await store.getConversationPref("other", "dsh:session-a"), null);
  });

  it("increments only explicit visibility commands and rejects stale versions", async () => {
    const store = new MemoryAuthorityStore();
    const first = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: true,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });

    assert.equal(first.outcome, "applied");
    assert.equal(first.pref.visibility_version, 1);
    assert.equal(first.pref.hidden, true);

    const stale = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.deepEqual(stale, { outcome: "conflict", current_version: 1 });

    const patched = await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: "Release",
      pinned: true,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    assert.equal(patched.visibility_version, 1);
    assert.equal(patched.hidden, true);

    const shown = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    assert.equal(shown.outcome, "applied");
    assert.equal(shown.pref.visibility_version, 2);
    assert.equal(shown.pref.hidden, false);
    assert.equal(shown.pref.title, "Release");
    assert.equal(shown.pref.pinned, true);
  });

  it("rejects visibility changes through ordinary preference writes", async () => {
    const store = new MemoryAuthorityStore();
    await assert.rejects(
      store.putConversationPref({
        org_id: "local-owner",
        thread_id: "dsh:session-a",
        hidden: true,
        updated_at: "2026-08-22T00:00:00.000Z",
      }),
      /visibility must use a visibility command/,
    );
    assert.equal(await store.getConversationPref("local-owner", "dsh:session-a"), null);
  });

  it("replays a visibility command by command id and rejects changed parameters", async () => {
    const store = new MemoryAuthorityStore();
    const command = {
      org_id: "local-owner",
      thread_id: "dsh:session-command",
      hidden: true,
      expected_version: 0,
      command_id: "visibility-command-1",
      issued_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    };
    const applied = await store.setConversationVisibility(command);
    assert.equal(applied.outcome, "applied");
    const later = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-command",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.equal(later.outcome, "applied");

    const replay = await store.setConversationVisibility(command);
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.pref.hidden, true);
    assert.equal(replay.pref.visibility_version, 1);
    assert.equal(
      (await store.getConversationPref("local-owner", "dsh:session-command")).hidden,
      false,
    );
    const changed = await store.setConversationVisibility({
      ...command,
      hidden: false,
    });
    assert.deepEqual(changed, { outcome: "command_conflict" });
  });

  it("applies policy folding only against the visibility version it observed", async () => {
    const store = new MemoryAuthorityStore();
    const shown = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(shown.outcome, "applied");
    const stale = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.deepEqual(stale, { outcome: "conflict", current_version: 1 });
    assert.equal((await store.getConversationPref("local-owner", "dsh:session-a")).hidden, false);

    const folded = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 1,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    assert.equal(folded.outcome, "applied");
    assert.equal(folded.pref.visibility_version, 1);
    assert.equal(folded.pref.hidden_reason, "policy");

    const humanShow = await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: false,
      expected_version: 1,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    assert.equal(humanShow.outcome, "applied");
    const lateFold = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      expected_visibility_version: 1,
      updated_at: "2026-08-22T00:00:04.000Z",
    });
    assert.deepEqual(lateFold, { outcome: "conflict", current_version: 2 });
    assert.equal((await store.getConversationPref("local-owner", "dsh:session-a")).hidden, false);
  });

  it("does not policy-hide a thread while a work item remains unsettled", async () => {
    const store = new MemoryAuthorityStore();
    const threadId = "dsh:session-unsettled-work";
    await createWorkItem(store, {
      id: "work-unsettled",
      org_id: "local-owner",
      thread_id: threadId,
      unit_key: "unit-unsettled",
      record_class: "task",
      thread_facet: "ticket",
    }, "2026-08-22T00:00:00.000Z");
    const blocked = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: threadId,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.deepEqual(blocked, { outcome: "unchanged" });
    assert.equal((await store.getConversationPref("local-owner", threadId))?.hidden, undefined);

    await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: false,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    const stale = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: threadId,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    assert.deepEqual(stale, { outcome: "conflict", current_version: 1 });

    const item = await store.getWorkItem("local-owner", "work-unsettled");
    const dismissed = await store.dismissWorkItem({
      expected_item: item,
      now: "2026-08-22T00:00:03.500Z",
    });
    assert.equal(dismissed.outcome, "applied");
    const folded = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: threadId,
      expected_visibility_version: 1,
      updated_at: "2026-08-22T00:00:04.000Z",
    });
    assert.deepEqual(folded, { outcome: "unchanged" });
    const pref = await store.getConversationPref("local-owner", threadId);
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
  });

  it("does not policy-hide a thread before the current completed run is acknowledged", async () => {
    const store = new MemoryAuthorityStore();
    const threadId = "dsh:session-unacknowledged-run";
    const now = "2026-08-22T00:00:00.000Z";
    const created = await createWorkItem(store, {
      id: "work-unacknowledged",
      org_id: "local-owner",
      thread_id: threadId,
      unit_key: "unit-unacknowledged",
      record_class: "task",
      thread_facet: "ticket",
    }, now);
    await completeWorkItem(store, created.item, created.recipe, now);

    const folded = await store.setConversationPolicyHidden({
      org_id: "local-owner",
      thread_id: threadId,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });

    assert.deepEqual(folded, { outcome: "unchanged" });
    assert.equal((await store.getConversationPref("local-owner", threadId))?.hidden, undefined);
  });

  it("applies policy unfold only while the observed policy visibility is current", async () => {
    const store = new MemoryAuthorityStore();
    const threadId = "dsh:session-policy-unfold";
    await store.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: true,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    const shown = await store.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: false,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    assert.equal(shown.outcome, "applied");
    assert.equal(shown.pref.hidden, false);
    assert.equal(shown.pref.hidden_reason, null);
    assert.equal(shown.pref.visibility_version, 0);

    await store.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: true,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:02.000Z",
    });
    await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: true,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:03.000Z",
    });
    const staleUnfold = await store.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: false,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:04.000Z",
    });
    assert.deepEqual(staleUnfold, { outcome: "conflict", current_version: 1 });
    const pref = await store.getConversationPref("local-owner", threadId);
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "human");
    assert.equal(pref.visibility_version, 1);
  });

  it("keeps a sync-page visibility projection from overwriting manual intent", async () => {
    const store = new MemoryAuthorityStore();
    const threadId = "dsh:session-sync-visibility";
    await store.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: true,
      expected_visibility_version: 0,
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: threadId,
      hidden: true,
      expected_version: 0,
      updated_at: "2026-08-22T00:00:01.000Z",
    });
    await store.commitSyncPage({
      attempt: {
        id: "attempt",
        org_id: "local-owner",
        connector_installation_id: "installation",
        stream_key: "stream",
        delivery_id: "delivery",
        started_at: "2026-08-22T00:00:00.000Z",
      },
      settle: {
        attempt_id: "attempt",
        installation_id: "installation",
        stream_key: "stream",
        lease_owner: "worker",
        finished_at: "2026-08-22T00:00:02.000Z",
        accepted_count: 1,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 0,
        quarantines: [],
      },
      prefs: [{
        org_id: "local-owner",
        thread_id: threadId,
        hidden: false,
        expected_visibility_version: 0,
        updated_at: "2026-08-22T00:00:02.000Z",
      }],
    });
    const pref = await store.getConversationPref("local-owner", threadId);
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "human");
    assert.equal(pref.visibility_version, 1);
  });

  it("clears operational data and keeps recipes", async () => {
    const store = new MemoryAuthorityStore();
    await store.append({
      org_id: "local-owner",
      source: "regenic",
      external_id: "ask-1",
      content_hash: "a".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 4,
      occurred_at: "2026-08-26T00:00:00.000Z",
      expected_head_id: null,
    });
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "regenic:ask-1",
      title: "Scratch",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await store.putRecipe({
      id: "keep-recipe",
      org_id: "local-owner",
      name: "Keep me",
      match: { record_class: "task" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    const recipe = await store.getRecipe("local-owner", "keep-recipe");
    const created = await store.createWorkItem({
      item: {
        id: "drop-work",
        org_id: "local-owner",
        thread_id: "regenic:ask-1",
        unit_key: "unit-1",
        recipe_id: recipe.id,
        record_class: "utterance",
        thread_facet: "chat",
        status: "open",
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
      recipe,
      expected_recipe: recipe,
    });
    assert.equal(created.outcome, "applied");
    const before = await store.summarizeStore("local-owner");
    const cleared = await store.clearOperationalData(
      "local-owner",
      "2026-08-26T00:01:00.000Z",
    );
    const after = await store.summarizeStore("local-owner");
    assert.equal(before.events, 1);
    assert.equal(before.work_items, 1);
    assert.equal(cleared.cleared.events, 1);
    assert.equal(cleared.kept.recipes, 1);
    assert.equal(after.events, 0);
    assert.equal(after.work_items, 0);
    assert.equal(after.recipes, 1);
    assert.equal(await store.getConversationPref("local-owner", "regenic:ask-1"), null);
    assert.equal((await store.listRecipes("local-owner"))[0].id, "keep-recipe");
  });
});
