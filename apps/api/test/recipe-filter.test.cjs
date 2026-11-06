const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const { normalizeRecipe } = require("../dist/personal-work-recipe");
const { PersonalWorkDispatch } = require("../dist/personal-work-dispatch");
const { PersonalWorkService } = require("../dist/personal-work.service");

const ORG = "local-owner";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "regenic-recipe-filter-"));
  const authority = new SqliteAuthorityStore(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  t.after(async () => {
    authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const recipe = normalizeRecipe({
    id: "filtered", name: "Filtered rule",
    match: { thread_id: "test-chat:room", text_contains: "approve", text_excludes: "draft" },
    executor_type: "test", include_context: false, can_write_back: false,
    ...options,
  }, ORG, now);
  await authority.putRecipe(recipe);
  let starts = 0;
  const executor = {
    executor_type: "test",
    capabilities: () => ({}),
    async start() { starts++; return { status: "running" }; },
  };
  const runtime = {
    orgId: () => ORG,
    requireHost: () => ({ get: (name) => ({
      authority, blobs, executors: { get: () => executor },
    })[name] }),
  };
  const dispatch = new PersonalWorkDispatch(runtime, {
    contextFor: () => ({ org_id: ORG }),
    evidenceText: async () => "formatted evidence",
    threadContextLines: async () => ({ lines: [], overflow: false }),
  }, { applyHandle: async () => {} }, { attach() {} });
  let sequence = 0;
  const ingest = async (text) => {
    sequence++;
    const result = await new IngestionService(blobs, authority).ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "fixture", org_id: ORG, delivery_id: `delivery-${sequence}`,
      received_at: now,
      records: [channelRecord({
        channel: "test-chat", kind: "user", direction: "inbound",
        external_id: `room:message-${sequence}`, scope_id: "room",
        occurred_at: new Date(Date.parse(now) + sequence * 1000).toISOString(),
        actor_id: "person", type: "task", text,
      })],
    });
    return result.records[0].event_id;
  };
  const service = new PersonalWorkService(
    runtime, {}, { ensureMounted: async () => {} }, { touchInboxDigest() {} }, {}, {},
  );
  return { authority, recipe, dispatch, service, ingest, starts: () => starts, now };
}

describe("recipe text filters", () => {
  it("validates filters, preserves exact strings and allows clearing them", () => {
    const input = {
      name: "Filter", executor_type: "test",
      match: { record_class: "task", text_contains: " approve ", text_excludes: "draft" },
    };
    const saved = normalizeRecipe(input, ORG, "now");
    assert.deepEqual(saved.match, input.match);
    assert.deepEqual(normalizeRecipe({ name: "Renamed" }, ORG, "later", saved).match, input.match);
    assert.deepEqual(normalizeRecipe({ match: { record_class: "task" } }, ORG, "later", saved).match,
      { record_class: "task" });
    for (const key of ["text_contains", "text_excludes"]) {
      for (const value of [null, 42, true, [], {}, "", "   "]) {
        assert.throws(() => normalizeRecipe({
          ...input, match: { record_class: "task", [key]: value },
        }, ORG, "now"), (error) => error.code === "invalid_config");
      }
    }
    assert.throws(() => normalizeRecipe({
      ...input, match: { text_contains: "approve" },
    }, ORG, "now"), (error) => error.code === "invalid_config");
  });

  it("round-trips both filters in the authority store", async (t) => {
    const f = await fixture(t);
    assert.deepEqual((await f.authority.getRecipe(ORG, f.recipe.id)).match, f.recipe.match);
    assert.deepEqual((await f.authority.listRecipes(ORG))[0].match, f.recipe.match);
  });

  it("starts only matching push events while still ingesting rejected tasks", async (t) => {
    const f = await fixture(t);
    await f.ingest("please APPROVE this DRAFT");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkItems(ORG)).length, 1);
    await f.ingest("please APPROVE this release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts(), 1);
    const runs = await f.authority.listWorkRuns(ORG);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].recipe_id, f.recipe.id);
  });

  it("does not bypass changed filters through fill-open-slots or manual starts", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("please approve this draft");
    const item = await f.authority.putWorkItem({
      id: "queued", org_id: ORG, recipe_id: f.recipe.id,
      thread_id: "test-chat:room", unit_key: eventId, head_event_id: eventId,
      record_class: "task", thread_facet: "ticket", status: "open",
      created_at: f.now, updated_at: f.now,
    });
    await f.dispatch.fillOpenSlots();
    assert.equal(f.starts(), 0);
    await assert.rejects(f.dispatch.startItem(item, f.recipe, "approve", "manual"),
      (error) => error.code === "invalid_config");
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkRuns(ORG)).length, 0);
  });

  it("binds a newly created filtered rule to a matching task already in the inbox", async (t) => {
    const f = await fixture(t);
    await f.authority.deleteRecipe(ORG, f.recipe.id);
    await f.ingest("approve release");
    await f.dispatch.reconcileInbox();
    const before = (await f.authority.listWorkItems(ORG))[0];
    assert.equal(before.recipe_id, undefined);
    assert.equal(f.starts(), 0);
    await f.authority.putRecipe(f.recipe);
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts(), 1);
    assert.equal((await f.authority.getWorkItem(ORG, before.id)).recipe_id, f.recipe.id);
  });

  it("ignores a rejected follow-up while a matching run is active", async (t) => {
    const f = await fixture(t);
    const acceptedId = await f.ingest("approve release");
    await f.dispatch.reconcileInbox();
    assert.equal(f.starts(), 1);
    await f.ingest("approve draft");
    await f.dispatch.reconcileInbox();
    const running = (await f.authority.listWorkItems(ORG)).find((item) => item.status === "running");
    assert.equal(running.head_event_id, acceptedId);
    assert.equal(f.starts(), 1);
  });

  it("does not use a newer matching message to start a rejected older work unit", async (t) => {
    const f = await fixture(t);
    const eventId = await f.ingest("approve draft");
    await f.ingest("approve release");
    const item = await f.authority.putWorkItem({
      id: "older", org_id: ORG, recipe_id: f.recipe.id,
      thread_id: "test-chat:room", unit_key: eventId, head_event_id: eventId,
      record_class: "task", thread_facet: "ticket", status: "open",
      created_at: f.now, updated_at: f.now,
    });
    await f.dispatch.startItem(item, f.recipe);
    assert.equal(f.starts(), 0);
  });

  it("rejects a nonmatching try and anchors a matching try to the latest message", async (t) => {
    const f = await fixture(t);
    const rejectedId = await f.ingest("approve draft");
    const old = await f.authority.putWorkItem({
      id: "old", org_id: ORG, recipe_id: f.recipe.id,
      thread_id: "test-chat:room", unit_key: rejectedId, head_event_id: rejectedId,
      record_class: "task", thread_facet: "ticket", status: "done",
      created_at: f.now, updated_at: f.now,
    });
    await assert.rejects(f.service.tryRecipe(f.recipe.id, {}),
      (error) => error.code === "invalid_config");
    assert.equal((await f.authority.getWorkItem(ORG, old.id)).status, "done");
    const latestId = await f.ingest("approve release");
    t.mock.method(f.service, "runWorkItem", async (id) => ({
      work_item: await f.authority.getWorkItem(ORG, id),
    }));
    const result = await f.service.tryRecipe(f.recipe.id, {});
    assert.notEqual(result.work_item.id, old.id);
    assert.equal(result.work_item.head_event_id, latestId);
    assert.equal(result.work_item.recipe_id, f.recipe.id);
  });

  it("advances a rejected schedule without opening work, then starts on a matching head", async (t) => {
    const f = await fixture(t, { trigger: { kind: "pull", interval_ms: 60_000 } });
    await f.ingest("approve draft");
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkItems(ORG)).length, 0);
    assert.ok((await f.authority.getRecipe(ORG, f.recipe.id)).next_run_at > f.now);
    await f.ingest("approve release");
    await f.authority.putRecipe({ ...f.recipe, next_run_at: f.now });
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 1);
  });

  it("does not pass exclusion-only filters when no message content is available", async (t) => {
    const f = await fixture(t, {
      match: { thread_id: "test-chat:room", text_excludes: "draft" },
      trigger: { kind: "pull", interval_ms: 60_000 },
    });
    await f.dispatch.dispatchPullRecipes();
    assert.equal(f.starts(), 0);
    assert.equal((await f.authority.listWorkItems(ORG)).length, 0);
  });
});
