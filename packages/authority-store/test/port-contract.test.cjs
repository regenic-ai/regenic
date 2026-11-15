const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ConnectorRunner,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  TASK_INBOX_REASON,
  hashCanonicalContext,
  hashContextArtifactInputs,
  hashContextSnapshot,
} = require("@regenic/domain");
const { FsBlobStore } = require("@regenic/blob-store");
const { createHost } = require("@regenic/plugin-host");
const { Client } = require("pg");
const { sqliteAuthorityPlugin } = require("../dist/sqlite");
const { postgresAuthorityPlugin } = require("../dist/postgres");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const KEEP = 64;

async function isolatedPostgresUrl(base) {
  const schema = `s${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await client.end();
  }
  const url = new URL(base);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return {
    connectionString: url.toString(),
    async cleanup() {
      const cleanupClient = new Client({ connectionString: base });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanupClient.end();
      }
    },
  };
}

const drivers = [
  {
    name: "sqlite",
    async setup() {
      const root = await mkdtemp(join(tmpdir(), "regenic-port-sqlite-"));
      return {
        plugin: sqliteAuthorityPlugin,
        config: { path: join(root, "authority.db") },
        blobRoot: join(root, "blobs"),
        async teardown() {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

if (process.env.TEST_DATABASE_URL?.trim()) {
  drivers.push({
    name: "postgres",
    async setup() {
      const root = await mkdtemp(join(tmpdir(), "regenic-port-pg-"));
      const postgres = await isolatedPostgresUrl(
        process.env.TEST_DATABASE_URL.trim(),
      );
      return {
        plugin: postgresAuthorityPlugin,
        config: {
          connectionString: postgres.connectionString,
        },
        blobRoot: join(root, "blobs"),
        async teardown() {
          try {
            await postgres.cleanup();
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        },
      };
    },
  });
}

function createBatch(orgId, externalId) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: orgId,
    delivery_id: `delivery-${externalId}`,
    received_at: "2026-08-24T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: externalId,
        occurred_at: "2026-08-24T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          { role: "body", media_type: "text/plain", text: "Port contract body." },
        ],
      },
    ],
  };
}

async function createTestWorkItem(store, item, search_answer) {
  const recipe = await store.getRecipe(item.org_id, item.recipe_id);
  assert.ok(recipe);
  const result = await store.createWorkItem({
    item,
    recipe,
    expected_recipe: recipe,
    ...(search_answer ? { search_answer } : {}),
  });
  assert.equal(result.outcome, "applied");
  return result;
}

function snapshotFor(orgId) {
  const value = {
    schema_version: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: "pending",
    org_id: orgId,
    request_hash: HASH_A,
    principal_policy_hash: HASH_B,
    read_epoch: "authority:42",
    retrieval_profile_version: "deterministic-v1",
    assembly_profile_version: "event-evidence-v1",
    bundle_payload_hash: HASH_A,
    selected: [
      {
        candidate_id: "event:event-1",
        resource_id: "event-1",
        kind: "event",
        content_hash: HASH_A,
      },
    ],
    budget_ledger: {
      profile: "test",
      max_tokens: 10,
      max_items: 1,
      max_raw_evidence: 1,
      requested_tokens: 1,
      selected_tokens: 1,
      reserved_tokens: 0,
      selected_items: 1,
      truncated_items: 0,
      sections: [
        {
          kind: "evidence",
          requested_tokens: 1,
          selected_tokens: 1,
          reserved_tokens: 0,
          selected_items: 1,
          truncated_items: 0,
        },
      ],
    },
    degradation_flags: ["model_absent"],
    content_hash: "",
    created_at: "2026-08-30T00:02:00.000Z",
  };
  value.content_hash = hashContextSnapshot(value);
  value.id = `context-snapshot:${value.content_hash}`;
  return value;
}

for (const driver of drivers) {
  describe(`${driver.name} authority port contract`, () => {
    const teardowns = [];

    after(async () => {
      for (const fn of teardowns.splice(0).reverse()) {
        await fn();
      }
    });

    async function openBoundStore() {
      const binding = await driver.setup();
      teardowns.push(binding.teardown);
      const host = await createHost();
      const handle = await host.plugin(binding.plugin, binding.config);
      await handle.ready();
      teardowns.push(() => host.dispose());
      return {
        store: host.get("authority"),
        blobs: new FsBlobStore(binding.blobRoot),
        orgId: `org-${randomUUID()}`,
      };
    }

    it("does not expose raw WorkItem, Run, or Delivery writes", async () => {
      const { store } = await openBoundStore();
      for (const method of ["putWorkItem", "putWorkRun", "putWorkDelivery"]) {
        assert.equal(store[method], undefined, `${method} must stay behind lifecycle commands`);
      }
    });

    it("rechecks tombstone fold evidence and preserves other work and human intent", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      for (const mode of ["valid", "stale", "other-thread", "other-org", "not-tombstone", "other-work", "human"]) {
        const id = `tombstone-${mode}-${randomUUID()}`;
        const thread = `thread-${id}`;
        const base = {
          org_id: orgId, source: "synthetic", external_id: id, thread_id: thread,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1, occurred_at: now,
        };
        await store.append({ ...base, id, expected_head_id: null });
        const tombstoneId = `${id}-deleted`;
        await store.markTombstone({ ...base, id: tombstoneId, expected_head_id: id });
        if (mode === "stale" || mode === "not-tombstone") {
          await store.appendRevision({
            ...base, id: `${id}-replacement`, parent_event_id: tombstoneId, expected_head_id: tombstoneId,
            disposition: { event_id: `${id}-replacement`, org_id: orgId,
              disposition: "outside_current_work", layer: "L1_event", reason_codes: [], score: 1, decided_at: now },
          });
        }
        if (mode === "other-work") {
          const other = { ...base, id: `${id}-work`, external_id: `${id}-other`, expected_head_id: null };
          await store.commitIngest({ appends: [other], dispositions: [{
            event_id: other.id, org_id: orgId, disposition: "current_work", layer: "L1_event",
            reason_codes: [], score: 1, decided_at: now,
          }] });
        }
        const targetOrg = mode === "other-org" ? `${orgId}-other` : orgId;
        const targetThread = mode === "other-thread" ? `${thread}-other` : thread;
        if (mode === "human") {
          await store.setConversationVisibility({
            org_id: targetOrg, thread_id: targetThread, hidden: true, expected_version: 0, updated_at: now,
          });
        }
        const guard = {
          org_id: targetOrg, thread_id: targetThread, hidden: true,
          expected_visibility_version: mode === "human" ? 1 : 0, updated_at: now,
          fold_current_tombstone_event_ids: [mode === "not-tombstone" ? `${id}-replacement` : tombstoneId],
        };
        const result = await store.setConversationPolicyVisibility(guard);
        assert.equal(result.outcome, mode === "valid" ? "applied" : "unchanged");
        if (mode === "valid") {
          assert.equal(result.pref.hidden_reason, "policy");
          assert.deepEqual(await store.setConversationPolicyVisibility(guard), { outcome: "unchanged" });
        } else if (mode === "human") {
          assert.equal((await store.getConversationPref(targetOrg, targetThread)).hidden_reason, "human");
        } else {
          assert.notEqual((await store.getConversationPref(targetOrg, targetThread))?.hidden, true);
        }
      }
      await assert.rejects(store.setConversationPolicyVisibility({
        org_id: orgId, thread_id: "invalid", hidden: true, expected_visibility_version: 0,
        updated_at: now, fold_current_tombstone_event_ids: [],
      }), /non-empty tombstone event IDs/);
      await assert.rejects(store.setConversationPolicyVisibility({
        org_id: orgId, thread_id: "invalid", hidden: false, expected_visibility_version: 0,
        updated_at: now, fold_current_tombstone_event_ids: ["not-a-fold"],
      }), /non-empty tombstone event IDs/);
    });

    it("rejects stale ingest-derived unfolds under the conversation lock", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      for (const mode of ["disposition", "revision", "tombstone", "other-thread", "other-org"]) {
        const id = `unfold-${mode}-${randomUUID()}`;
        const thread = `thread-${id}`;
        const source = {
          id, org_id: orgId, source: "synthetic", external_id: id, thread_id: thread,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        };
        const decision = (eventId, disposition) => ({
          event_id: eventId, org_id: orgId, disposition, layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        });
        await store.commitIngest({ appends: [source], dispositions: [decision(id, "current_work")] });
        if (mode === "disposition") {
          const expected = await store.getDisposition(id);
          const next = { ...expected, disposition: "outside_current_work" };
          await store.transitionDisposition({
            expected, decision: next,
            command: { org_id: orgId, event_id: id, action: "triage",
              disposition: next.disposition, command_id: `close-${id}`, issued_at: now },
          });
        } else if (mode === "revision") {
          await store.appendRevision({
            ...source, id: `${id}-revision`, parent_event_id: id, expected_head_id: id,
            disposition: decision(`${id}-revision`, "outside_current_work"),
          });
        } else if (mode === "tombstone") {
          await store.markTombstone({
            id: `${id}-deleted`, org_id: orgId, source: source.source,
            external_id: source.external_id, thread_id: thread, expected_head_id: id,
            occurred_at: now, disposition: decision(`${id}-deleted`, "current_work"),
          });
        }
        const targetOrg = mode === "other-org" ? `${orgId}-other` : orgId;
        const targetThread = mode === "other-thread" ? `${thread}-other` : thread;
        await store.setConversationPolicyHidden({
          org_id: targetOrg, thread_id: targetThread, expected_visibility_version: 0, updated_at: now,
        });
        const candidate = mode === "tombstone" ? `${id}-deleted` : id;
        assert.deepEqual(await store.setConversationPolicyVisibility({
          org_id: targetOrg, thread_id: targetThread, hidden: false,
          expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [candidate],
        }), { outcome: "unchanged" });
        assert.equal((await store.getConversationPref(targetOrg, targetThread)).hidden_reason, "policy");
      }
      await assert.rejects(store.setConversationPolicyVisibility({
        org_id: orgId, thread_id: "invalid", hidden: false,
        expected_visibility_version: 0, updated_at: now, unfold_current_work_event_ids: [],
      }), /non-empty current-work event IDs/);
    });

    it("does not let another organization claim an existing WorkItem ID", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const recipe = {
        id: `recipe-${randomUUID()}`, org_id: orgId, name: "Work identity",
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: "session", executor_config: {}, include_context: false,
        can_write_back: false, enabled: true, created_at: now, updated_at: now,
      };
      await store.putRecipe(recipe);
      const item = {
        id: `shared-work-${randomUUID()}`,
        org_id: orgId,
        thread_id: "source:work-item-owner",
        unit_key: "unit-1",
        recipe_id: recipe.id,
        record_class: "task",
        thread_facet: "ticket",
        status: "open",
        created_at: now,
        updated_at: now,
      };
      const created = await createTestWorkItem(store, item);
      const foreignOrg = `${orgId}-other`;
      const foreignRecipe = {
        ...recipe, id: `recipe-${randomUUID()}`, org_id: foreignOrg,
      };
      await store.putRecipe(foreignRecipe);
      const foreignItem = {
        ...item, org_id: foreignOrg, recipe_id: foreignRecipe.id,
        thread_id: "source:work-item-other", unit_key: "unit-2",
      };
      const expectedRecipe = await store.getRecipe(foreignOrg, foreignRecipe.id);
      const attempt = await store.createWorkItem({
        item: foreignItem, recipe: expectedRecipe, expected_recipe: expectedRecipe,
      });
      assert.deepEqual(attempt, { outcome: "conflict", reason: "work_exists" });
      assert.deepEqual(await store.getWorkItem(orgId, item.id), created.item);
      assert.equal(await store.getWorkItem(foreignOrg, item.id), null);
    });

    it("commits an ingest page and lists inbox", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const service = new IngestionService(blobs, store);
      const result = await service.ingest(createBatch(orgId, "page-1"));
      assert.equal(result.valid, true);
      assert.equal(
        result.records.filter((record) => record.status === "accepted").length,
        1,
      );
      const inbox = await store.listInbox(orgId);
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].event.org_id, orgId);
    });

    it("atomically compares, audits, and replays inbox disposition commands", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const ingested = await new IngestionService(blobs, store).ingest(createBatch(orgId, "disposition-1"));
      const eventId = ingested.records[0].event_id;
      const expected = await store.getDisposition(eventId);
      assert.ok(expected);
      const decision = {
        ...expected,
        disposition: "pending",
        reason_codes: [...expected.reason_codes, "human_triage"],
        decided_at: "2026-08-30T00:00:00.000Z",
      };
      const input = {
        expected,
        decision,
        command: {
          org_id: orgId,
          event_id: eventId,
          action: "triage",
          disposition: "pending",
          command_id: `inbox-disposition-${randomUUID()}`,
          issued_at: "2026-08-30T00:00:00.000Z",
        },
      };
      const alternateInput = {
        ...input,
        decision: { ...decision, disposition: "outside_current_work" },
        command: {
          ...input.command,
          command_id: `inbox-disposition-${randomUUID()}`,
          disposition: "outside_current_work",
        },
      };
      const [left, right] = await Promise.all([
        store.transitionDisposition(input),
        store.transitionDisposition(alternateInput),
      ]);
      assert.deepEqual([left.outcome, right.outcome].sort(), ["applied", "conflict"]);
      const applied = left.outcome === "applied" ? left : right;
      const winningInput = left.outcome === "applied" ? input : alternateInput;
      assert.equal((await store.transitionDisposition(winningInput)).outcome, "replayed");
      assert.equal(applied.decision.disposition, (await store.getDisposition(eventId)).disposition);
    });

    it("inserts a missing disposition only once under concurrent repair", async () => {
      const { store, orgId } = await openBoundStore();
      const event = await store.append({
        id: `event-${randomUUID()}`,
        org_id: orgId,
        source: "regenic",
        external_id: `missing-disposition-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      const decisions = [
        {
          event_id: event.id,
          org_id: orgId,
          disposition: "current_work",
          layer: "L1_event",
          reason_codes: ["repair-left"],
          score: 0.5,
          decided_at: "2026-08-30T00:00:00.000Z",
        },
        {
          event_id: event.id,
          org_id: orgId,
          disposition: "pending",
          layer: "L1_event",
          reason_codes: ["repair-right"],
          score: 0.6,
          decided_at: "2026-08-30T00:00:01.000Z",
        },
      ];
      const outcomes = await Promise.all(
        decisions.map((decision) => store.putDispositionIfAbsent(decision)),
      );
      assert.deepEqual([...outcomes].sort(), [false, true]);
      const saved = await store.getDisposition(event.id);
      const winner = outcomes[0] ? decisions[0] : decisions[1];
      assert.deepEqual(saved, { ...winner, version: 0 });
      await assert.rejects(
        store.putDispositionIfAbsent({
          ...decisions[0],
          event_id: `missing-${randomUUID()}`,
        }),
        /not owned by the requested organization/,
      );
      const untriagedEvent = await store.append({
        id: `event-${randomUUID()}`,
        org_id: orgId,
        source: "regenic",
        external_id: `cross-org-disposition-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      await assert.rejects(
        store.putDispositionIfAbsent({
          ...decisions[0],
          event_id: untriagedEvent.id,
          org_id: `other-${randomUUID()}`,
        }),
        /not owned by the requested organization/,
      );
    });

    it("does not expose tombstones as current work in visible inbox projections", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const thread = `thread-${randomUUID()}`;
      const firstId = `first-${randomUUID()}`;
      const initial = {
        id: firstId, org_id: orgId, source: "synthetic", external_id: `source-${firstId}`,
        thread_id: thread, content_hash: HASH_A, content_media_type: "text/plain",
        content_byte_size: 1, occurred_at: now, expected_head_id: null,
      };
      const decision = (id) => ({
        event_id: id, org_id: orgId, disposition: "current_work", layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      });
      await store.commitIngest({ appends: [initial], dispositions: [decision(firstId)] });
      const tombstoneId = `tombstone-${randomUUID()}`;
      await store.markTombstone({
        id: tombstoneId, org_id: orgId, source: initial.source, external_id: initial.external_id,
        thread_id: thread, occurred_at: now, expected_head_id: firstId,
        disposition: decision(tombstoneId),
      });
      for (const query of [undefined, { thread_ids: [thread] }, { heads: true }, { heads: true, thread_ids: [thread] }, { siblings: true }]) {
        assert.deepEqual(await store.listInbox(orgId, query), []);
      }
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      assert.equal((await store.getDisposition(tombstoneId)).disposition, "current_work");
      const liveId = `live-${randomUUID()}`;
      const live = {
        ...initial, id: liveId, external_id: liveId, occurred_at: "2026-08-30T00:00:01.000Z",
      };
      await store.commitIngest({ appends: [live], dispositions: [decision(liveId)] });
      assert.deepEqual((await store.listInbox(orgId)).map((row) => row.event.id), [liveId]);
      assert.deepEqual((await store.listInbox(orgId, { heads: true })).map((row) => row.event.id), [liveId]);
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      const expected = await store.getDisposition(liveId);
      const next = { ...expected, disposition: "outside_current_work" };
      assert.equal((await store.transitionDisposition({
        expected, decision: next,
        command: {
          org_id: orgId, event_id: liveId, action: "triage", disposition: next.disposition,
          command_id: `close-${liveId}`, issued_at: now,
        },
      })).outcome, "applied");
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      await store.setConversationVisibility({
        org_id: orgId, thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
      });
      assert.ok((await store.listInbox(orgId, { list: "hidden" }))
        .some((row) => row.event.id === tombstoneId));
    });

    it("does not let tombstone dispositions block policy folding", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const thread = `thread-${randomUUID()}`;
      const tombstone = await store.markTombstone({
        org_id: orgId, source: "synthetic", external_id: `deleted-${randomUUID()}`,
        thread_id: thread, expected_head_id: null, occurred_at: now,
      });
      await store.putDispositionIfAbsent({
        event_id: tombstone.id, org_id: orgId, disposition: "current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      });
      assert.equal((await store.setConversationPolicyHidden({
        org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
      })).outcome, "applied");
      assert.equal((await store.getDisposition(tombstone.id)).disposition, "current_work");
      const activeId = `active-${randomUUID()}`;
      await store.commitIngest({
        appends: [{
          id: activeId, org_id: orgId, source: "synthetic", external_id: activeId, thread_id: thread,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        }],
        dispositions: [{
          event_id: activeId, org_id: orgId, disposition: "current_work",
          layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
        }],
      });
      assert.equal((await store.getConversationPref(orgId, thread)).hidden, false);
      assert.equal((await store.setConversationPolicyHidden({
        org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
      })).outcome, "unchanged");
    });

    it("unfolds restored or reclassified current work without exposing human-hidden or stale events", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      for (const mode of ["transition", "restore", "human", "stale", "tombstone"]) {
        const id = `event-${randomUUID()}`;
        const thread = `thread-${randomUUID()}`;
        const first = await store.append({
          id, org_id: orgId, source: "synthetic", external_id: id, thread_id: thread,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        });
        let target = first;
        if (mode === "stale") {
          await store.appendRevision({
            ...first, id: `event-${randomUUID()}`, parent_event_id: first.id, expected_head_id: first.id,
            content_media_type: "text/plain", content_byte_size: 1,
          });
        } else if (mode === "tombstone") {
          target = await store.markTombstone({
            org_id: orgId, source: first.source, external_id: first.external_id, thread_id: thread,
            expected_head_id: first.id, occurred_at: now,
          });
        }
        const initial = {
          event_id: target.id, org_id: orgId, disposition: "outside_current_work", layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        };
        if (mode !== "restore") await store.putDispositionIfAbsent(initial);
        if (mode === "human") {
          await store.setConversationVisibility({
            org_id: orgId, thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
          });
        } else {
          assert.equal((await store.setConversationPolicyHidden({
            org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
          })).outcome, "applied");
        }
        const work = { ...initial, disposition: "current_work" };
        let transition;
        if (mode === "restore") {
          assert.equal(await store.putDispositionIfAbsent(work), true);
          assert.equal(await store.putDispositionIfAbsent(work), false);
        } else {
          const expected = await store.getDisposition(target.id);
          transition = {
            expected, decision: work,
            command: {
              org_id: orgId, event_id: target.id, action: "triage", disposition: "current_work",
              command_id: `command-${id}`, issued_at: now,
            },
          };
          assert.equal((await store.transitionDisposition(transition)).outcome, "applied");
          assert.equal((await store.transitionDisposition(transition)).outcome, "replayed");
        }
        const pref = await store.getConversationPref(orgId, thread);
        assert.equal(pref.hidden, !["transition", "restore"].includes(mode));
        assert.equal(pref.hidden_reason, mode === "human" ? "human"
          : ["transition", "restore"].includes(mode) ? null : "policy");
        assert.equal(pref.visibility_version, mode === "human" ? 1 : 0);
        if (mode === "transition") {
          await store.setConversationVisibility({
            org_id: orgId, thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
          });
          assert.equal((await store.transitionDisposition(transition)).outcome, "replayed");
          assert.equal((await store.getConversationPref(orgId, thread)).hidden_reason, "human");
        }
      }
    });

    it("does not let putDispositionIfAbsent overwrite an existing decision", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const ingested = await new IngestionService(blobs, store).ingest(createBatch(orgId, "immutable-disposition"));
      const eventId = ingested.records[0].event_id;
      const original = await store.getDisposition(eventId);
      assert.ok(original);
      assert.equal(await store.putDispositionIfAbsent(original), false);
      assert.equal(await store.putDispositionIfAbsent({
        ...original,
        disposition: "outside_current_work",
        reason_codes: ["put-if-absent-overwrite"],
        decided_at: "2026-08-30T00:00:01.000Z",
      }), false);
      assert.deepEqual(await store.getDisposition(eventId), original);
    });

    it("fences competing conversation visibility commands by version", async () => {
      const { store, orgId } = await openBoundStore();
      const threadId = "dsh:session-a";
      const [left, right] = await Promise.all([
        store.setConversationVisibility({
          org_id: orgId,
          thread_id: threadId,
          hidden: true,
          expected_version: 0,
          updated_at: "2026-08-30T00:00:00.000Z",
        }),
        store.setConversationVisibility({
          org_id: orgId,
          thread_id: threadId,
          hidden: false,
          expected_version: 0,
          updated_at: "2026-08-30T00:00:01.000Z",
        }),
      ]);
      assert.deepEqual(
        [left.outcome, right.outcome].sort(),
        ["applied", "conflict"],
      );
      const current = await store.getConversationPref(orgId, threadId);
      assert.equal(current.visibility_version, 1);
      const readCursor = await store.putConversationPref({
        org_id: orgId,
        thread_id: threadId,
        last_read_at: "2026-08-30T00:00:10.000Z",
        last_read_external_id: "event-later",
        updated_at: "2026-08-30T00:00:10.000Z",
      });
      const staleReadCursor = await store.putConversationPref({
        org_id: orgId,
        thread_id: threadId,
        last_read_at: "2026-08-30T00:00:05.000Z",
        last_read_external_id: "event-earlier",
        updated_at: "2026-08-30T00:00:11.000Z",
      });
      assert.equal(staleReadCursor.last_read_at, readCursor.last_read_at);
      assert.equal(staleReadCursor.last_read_external_id, readCursor.last_read_external_id);
      const patched = await store.putConversationPref({
        org_id: orgId,
        thread_id: threadId,
        title: "Release",
        pinned: true,
        updated_at: "2026-08-30T00:00:02.000Z",
      });

      assert.equal(patched.visibility_version, 1);
      assert.equal((await store.getConversationPref(orgId, threadId)).visibility_version, 1);
      await assert.rejects(
        () => store.putConversationPref({
          org_id: orgId,
          thread_id: threadId,
          hidden: true,
          updated_at: "2026-08-30T00:00:03.000Z",
        }),
        /visibility must use a visibility command/,
      );
      assert.equal((await store.getConversationPref(orgId, threadId)).visibility_version, 1);
    });

    it("replays visibility commands from the original audit fact", async () => {
      const { store, orgId } = await openBoundStore();
      const command = {
        org_id: orgId,
        thread_id: "dsh:session-command-replay",
        hidden: true,
        expected_version: 0,
        command_id: "visibility-command-1",
        issued_at: "2026-08-30T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
      };
      const applied = await store.setConversationVisibility(command);
      assert.equal(applied.outcome, "applied");
      await store.setConversationVisibility({
        org_id: orgId,
        thread_id: command.thread_id,
        hidden: false,
        expected_version: 1,
        updated_at: "2026-08-30T00:00:01.000Z",
      });

      const replay = await store.setConversationVisibility(command);
      assert.equal(replay.outcome, "replayed");
      assert.equal(replay.pref.hidden, true);
      assert.equal(replay.pref.visibility_version, 1);
      assert.equal(
        (await store.getConversationPref(orgId, command.thread_id)).hidden,
        false,
      );
      const changed = await store.setConversationVisibility({
        ...command,
        hidden: false,
      });
      assert.deepEqual(changed, { outcome: "command_conflict" });
    });

    it("does not let a stale policy fold overwrite a newer manual visibility command", async () => {
      const { store, orgId } = await openBoundStore();
      const threadId = "dsh:session-policy-fold";
      await store.setConversationVisibility({
        org_id: orgId, thread_id: threadId, hidden: false, expected_version: 0,
        updated_at: "2026-08-30T00:00:00.000Z",
      });
      const changed = await store.setConversationVisibility({
        org_id: orgId, thread_id: threadId, hidden: true, expected_version: 1,
        updated_at: "2026-08-30T00:00:01.000Z",
      });
      assert.equal(changed.outcome, "applied");
      const staleFold = await store.setConversationPolicyHidden({
        org_id: orgId, thread_id: threadId, expected_visibility_version: 1,
        updated_at: "2026-08-30T00:00:02.000Z",
      });
      assert.deepEqual(staleFold, { outcome: "conflict", current_version: 2 });
      const pref = await store.getConversationPref(orgId, threadId);
      assert.equal(pref.hidden, true);
      assert.equal(pref.hidden_reason, "human");
      assert.equal(pref.visibility_version, 2);
    });

    it("policy-hides a thread in the same commit that dismisses its last work item", async () => {
      const { store, orgId } = await openBoundStore();
      const threadId = `source:pending-${randomUUID()}`;
      const triggerEvent = await store.append({
        id: `event-dismiss-${randomUUID()}`,
        org_id: orgId,
        source: "source",
        external_id: `external-dismiss-${randomUUID()}`,
        thread_id: threadId,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      await store.putDispositionIfAbsent({
        event_id: triggerEvent.id,
        org_id: orgId,
        disposition: "current_work",
        layer: "L1_event",
        reason_codes: ["task"],
        score: 1,
        decided_at: "2026-08-30T00:00:00.000Z",
      });
      const recipe = {
        id: `recipe-${randomUUID()}`, org_id: orgId, name: "Pending dismissal",
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: "session", executor_config: {}, include_context: false,
        can_write_back: false, enabled: true, created_at: "2026-08-30T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
      };
      await store.putRecipe(recipe);
      const { item } = await createTestWorkItem(store, {
        id: `work-pending-${randomUUID()}`,
        org_id: orgId,
        recipe_id: recipe.id,
        thread_id: threadId,
        unit_key: "pending-unit",
        head_event_id: triggerEvent.id,
        record_class: "task",
        thread_facet: "ticket",
        status: "open",
        created_at: "2026-08-30T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
      });
      assert.deepEqual(await store.setConversationPolicyHidden({
        org_id: orgId,
        thread_id: threadId,
        expected_visibility_version: 0,
        updated_at: "2026-08-30T00:00:01.000Z",
      }), { outcome: "unchanged" });
      assert.notEqual((await store.getConversationPref(orgId, threadId))?.hidden, true);

      await store.dismissWorkItem({
        expected_item: item,
        now: "2026-08-30T00:00:02.000Z",
      });
      const folded = await store.getConversationPref(orgId, threadId);
      assert.equal(folded.hidden, true);
      assert.equal(folded.hidden_reason, "policy");
      assert.equal((await store.getDisposition(triggerEvent.id)).disposition, "current_work");
      assert.deepEqual(await store.setConversationPolicyHidden({
        org_id: orgId,
        thread_id: threadId,
        expected_visibility_version: 0,
        updated_at: "2026-08-30T00:00:03.000Z",
      }), { outcome: "unchanged" });
    });

    it("captures the current conversation visibility version when reserving a work run", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const recipeId = `recipe-${randomUUID()}`;
      const itemId = `work-${randomUUID()}`;
      const threadId = "dsh:session-visibility";
      await store.putRecipe({
        id: recipeId, org_id: orgId, name: "Visibility snapshot",
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: "session", executor_config: {}, include_context: false,
        can_write_back: false, enabled: true, created_at: now, updated_at: now,
      });
      const { item } = await createTestWorkItem(store, {
        id: itemId, org_id: orgId, recipe_id: recipeId, thread_id: threadId,
        unit_key: "task-visibility", record_class: "task", thread_facet: "ticket",
        status: "open", created_at: now, updated_at: now,
      });
      await store.setConversationVisibility({
        org_id: orgId, thread_id: threadId, hidden: true, expected_version: 0,
        updated_at: now,
      });
      const expectedItem = await store.getWorkItem(orgId, itemId);
      const run = {
        id: `run-${randomUUID()}`, org_id: orgId, work_item_id: itemId,
        recipe_id: recipeId, executor_type: "session", status: "running",
        start_state: "pending", created_at: now, updated_at: now,
      };
      assert.equal(await store.claimWorkRunStart({
        run, expected_item: expectedItem, visibility_intent_version: 0,
      }), false);
      assert.equal(await store.claimWorkRunStart({
        run, expected_item: expectedItem, visibility_intent_version: 1,
      }), true);
      const claimed = await store.getWorkItem(orgId, itemId);
      assert.equal(claimed.visibility_intent_version, 1);
    });

    it("advances a pull schedule only if the recipe snapshot still matches", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const initial = {
        id: `recipe-${randomUUID()}`,
        org_id: orgId,
        name: "Scheduled pull",
        match: { thread_id: "dsh:session-pull" },
        trigger: { kind: "pull", interval_ms: 60 * 60 * 1000 },
        executor_type: "session",
        executor_config: {},
        can_write_back: false,
        include_context: false,
        enabled: true,
        next_run_at: now,
        created_at: now,
        updated_at: now,
      };
      await store.putRecipe(initial);
      const expected = await store.getRecipe(orgId, initial.id);
      const edited = { ...expected, name: "Edited while scheduled", updated_at: "2026-08-30T00:01:00.000Z" };
      await store.putRecipe(edited);

      assert.equal(await store.advanceRecipePullSchedule({
        expected_recipe: expected,
        next_run_at: "2026-08-30T01:00:00.000Z",
        updated_at: "2026-08-30T00:02:00.000Z",
      }), false);
      assert.deepEqual(await store.getRecipe(orgId, initial.id), edited);
      assert.equal(await store.advanceRecipePullSchedule({
        expected_recipe: edited,
        next_run_at: "2026-08-30T01:00:00.000Z",
        updated_at: "2026-08-30T00:02:00.000Z",
      }), true);
      const advanced = await store.getRecipe(orgId, initial.id);
      assert.equal(advanced.name, edited.name);
      assert.equal(advanced.next_run_at, "2026-08-30T01:00:00.000Z");
    });

    it("compares recipe snapshots atomically and prevents cross-org id takeover", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const recipe = {
        id: `recipe-${randomUUID()}`,
        org_id: orgId,
        name: "CAS recipe",
        match: { thread_id: "dsh:session-recipe-cas" },
        trigger: { kind: "push" },
        executor_type: "session",
        executor_config: {},
        can_write_back: false,
        include_context: false,
        enabled: true,
        created_at: now,
        updated_at: now,
      };
      assert.deepEqual(await store.putRecipeIfUnchanged({
        recipe,
        expected_recipe: null,
      }), { outcome: "applied", recipe });
      assert.deepEqual(await store.putRecipeIfUnchanged({
        recipe: { ...recipe, name: "Duplicate create" },
        expected_recipe: null,
      }), { outcome: "conflict" });
      assert.deepEqual(await store.putRecipeIfUnchanged({
        recipe: { ...recipe, name: "Cross-org takeover", org_id: `other-${randomUUID()}` },
        expected_recipe: null,
      }), { outcome: "conflict" });

      const expected = await store.getRecipe(orgId, recipe.id);
      const edit = { ...expected, name: "Concurrent edit", updated_at: "2026-08-30T00:01:00.000Z" };
      await store.putRecipe(edit);
      assert.deepEqual(await store.putRecipeIfUnchanged({
        recipe: { ...expected, name: "Stale edit" },
        expected_recipe: expected,
      }), { outcome: "conflict" });
      assert.deepEqual(await store.getRecipe(orgId, recipe.id), edit);

      const saved = await store.putRecipeIfUnchanged({
        recipe: { ...edit, name: "Current edit", updated_at: "2026-08-30T00:02:00.000Z" },
        expected_recipe: edit,
      });
      assert.equal(saved.outcome, "applied");
      assert.equal(saved.recipe.name, "Current edit");
    });

    it("pages push candidates by event identity, including auto pending but not human exclusions", async () => {
      const { store, orgId } = await openBoundStore();
      const at = "2026-08-30T00:00:00.000Z";
      const variants = [
        ["current_work", [], "room"],
        ["pending", ["needs_review"], "room"],
        ["pending", ["policy_default_personal_attention"], "folded"],
        ["pending", ["needs_review", "human_triage"], "room"],
        ["outside_current_work", [], "room"],
        ["current_work", [TASK_INBOX_REASON], "room"],
        ["current_work", [], "hidden"],
      ];
      for (const [i, [disposition, reason_codes, target]] of variants.entries()) {
        const event = await store.append({
          id: `candidate-${i}`, org_id: orgId, source: "synthetic",
          external_id: `${target}:${i}`, thread_id: `synthetic:${target}`,
          actor_id: "person", required_scope_ids: [], content_hash: HASH_A,
          content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: at, expected_head_id: null,
        });
        await store.putDispositionIfAbsent({
          event_id: event.id, org_id: orgId, disposition, reason_codes,
          layer: "L1_event", score: 1, decided_at: at,
        });
      }
      await store.setConversationVisibility({
        org_id: orgId, thread_id: "synthetic:hidden", hidden: true,
        expected_version: 0, command_id: "hide-push-candidate", issued_at: at, updated_at: at,
      });
      await store.setConversationPolicyVisibility({
        org_id: orgId, thread_id: "synthetic:folded", hidden: true,
        expected_visibility_version: 0, updated_at: at,
      });
      const query = { tasks: false, needs_work: true, push_candidates: true, limit: 2 };
      const recent = await store.listInbox(orgId, query);
      assert.deepEqual(recent.map((row) => row.event.id), ["candidate-1", "candidate-2"]);
      const older = await store.listInbox(orgId, {
        ...query, before: at, before_id: recent[0].event.id,
      });
      assert.deepEqual(older.map((row) => row.event.id), ["candidate-0"]);
      assert.deepEqual((await store.listInbox(orgId, { tasks: false })).map((row) => row.event.id),
        ["candidate-0"]);
      assert.deepEqual(await store.listInbox(orgId, {
        ...query, thread_ids: ["synthetic:hidden"],
      }), []);
      await store.putRecipe({
        id: "push-candidate-rule", org_id: orgId, name: "Handle candidate",
        match: { record_class: "utterance" }, trigger: { kind: "manual" },
        executor_type: "test", executor_config: {}, can_write_back: false,
        include_context: false, enabled: true, created_at: at, updated_at: at,
      });
      const handled = await createTestWorkItem(store, {
        id: "handled", org_id: orgId, thread_id: "synthetic:room",
        recipe_id: "push-candidate-rule",
        unit_key: "candidate-1", head_event_id: "candidate-1",
        record_class: "utterance", thread_facet: "chat", status: "open",
        created_at: at, updated_at: at,
      });
      const decision = await store.getDisposition("candidate-1");
      await store.transitionDisposition({
        expected: decision, decision: { ...decision, disposition: "current_work" },
        command: { org_id: orgId, event_id: "candidate-1", action: "triage",
          disposition: "current_work", command_id: "accept-handled-candidate", issued_at: at },
      });
      assert.equal(await store.claimWorkRunStart({
        expected_item: handled.item,
        run: { id: "handled-run", org_id: orgId, work_item_id: handled.item.id,
          recipe_id: "push-candidate-rule", executor_type: "test", status: "running",
          start_state: "pending", created_at: at, updated_at: at },
      }), true);
      const submitted = await store.checkpointWorkRunStart({
        expected_item: await store.getWorkItem(orgId, handled.item.id),
        expected_run: await store.getWorkRun(orgId, "handled-run"),
        kind: "submitted", external_run_id: "external-handled", now: at,
      });
      assert.equal(submitted.outcome, "applied");
      assert.equal((await store.commitWorkObservation({
        expected_item: submitted.item, expected_run: submitted.run,
        handle: { status: "completed", external_run_id: "external-handled", result: { summary: "Handled" } },
        can_write_back: false, trigger_kind: "manual", now: at,
      })).outcome, "applied");
      assert.deepEqual((await store.listInbox(orgId, query)).map((row) => row.event.id),
        ["candidate-0", "candidate-2"]);
    });

    it("restores shared-body artifacts through lifecycle transitions and preview reads", async () => {
      const { store, orgId } = await openBoundStore();
      const reference = {
        event_id: "shared-event", source: "synthetic", external_id: "shared-message",
        operation: "create", occurred_at: "2026-08-30T00:00:00.000Z", content_hash: HASH_A,
      };
      const attrs = { thread_id: "shared-thread", messages: [{ text: "A complete retained message", occurred_at: reference.occurred_at }] };
      const first = {
        id: "shared-summary-1", org_id: orgId, kind: "thread_summary", schema_version: "1.0",
        algorithm_version: "thread-summary-deterministic-v2", generation: "shared-generation",
        input_refs: [reference], input_hash: hashContextArtifactInputs({ input_refs: [reference] }),
        body_hash: hashCanonicalContext(attrs), body_storage: "artifact", status: "proposed",
        required_scope_ids: ["scope-1"], recorded_at: reference.occurred_at, attrs,
      };
      assert.deepEqual(await store.putArtifact(first), first);
      assert.deepEqual(await store.getArtifact(orgId, first.id), first);
      await store.decideArtifact({ org_id: orgId, artifact_id: first.id, status: "accepted", decided_at: first.recorded_at });
      assert.deepEqual(await store.getArtifact(orgId, first.id), { ...first, status: "accepted" });
      const replacement = {
        ...first, id: "shared-summary-2", supersedes_id: first.id, recorded_at: "2026-08-30T00:00:01.000Z",
      };
      await store.putArtifact(replacement);
      await store.supersedeArtifact({
        org_id: orgId, artifact_id: first.id, replacement_id: replacement.id,
        decided_at: replacement.recorded_at,
      });
      assert.deepEqual(await store.getArtifact(orgId, first.id), { ...first, status: "superseded" });
      assert.deepEqual(await store.listArtifacts({ org_id: orgId, statuses: ["accepted"] }), [{ ...replacement, status: "accepted" }]);
      const indexes = await store.listArtifactIndexes({ org_id: orgId });
      assert.equal(indexes[0].preview.readable_count, 1);
      assert.equal(indexes[0].preview.last_text, attrs.messages[0].text);
      assert.equal(await store.getArtifact(`${orgId}-other`, first.id), null);
    });

    it("preserves Event metadata across current heads, lists, inbox views, revisions, and tombstones", async () => {
      const { store, orgId } = await openBoundStore();
      const input = {
        id: `event-${randomUUID()}`, org_id: orgId, source: "synthetic", external_id: "metadata",
        thread_id: "metadata-thread", actor_id: "person-1", required_scope_ids: ["scope-1"],
        direction_tags: ["outbound", "follow_up"],
        weight_hints: { urgency: 0.8, importance: 0.6 },
        attrs: { entity_id: "entity-1", participants: ["owner"], nested: { enabled: false, count: 0, value: null } },
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z", expected_head_id: null,
      };
      const history = [];
      async function assertReads(expected, metadata) {
        for (const field of ["direction_tags", "weight_hints", "attrs"]) {
          assert.deepEqual(expected[field], metadata[field], field);
        }
        assert.deepEqual(await store.getEvent(orgId, expected.id), expected);
        assert.deepEqual(await store.findBySourceIdentity(input), expected);
        assert.deepEqual(await store.listEvents(orgId), history);
        const read = await store.openContextRead(orgId);
        assert.deepEqual(read.events, history.map((event) => ({ ...event, content_media_type: "text/plain" })));
      }
      async function assertInboxReads(expected, queries) {
        for (const query of queries) {
          const items = await store.listInbox(orgId, query);
          assert.deepEqual(items.map((item) => item.event), [expected]);
        }
      }
      async function arrange(event) {
        await store.putDispositionIfAbsent({
          org_id: orgId, event_id: event.id, disposition: "current_work", layer: "L1_event",
          reason_codes: [TASK_INBOX_REASON], score: 1, decided_at: event.occurred_at,
        });
      }
      const first = await store.append(input);
      history.push(first);
      await arrange(first);
      await assertReads(first, input);
      await assertInboxReads(first, [
        undefined, { heads: true }, { siblings: true }, { tasks: true },
        { thread_ids: [input.thread_id] },
      ]);
      const revisionInput = {
        ...input, id: `event-${randomUUID()}`, parent_event_id: first.id, expected_head_id: first.id,
        content_hash: HASH_B, direction_tags: ["inbound"], weight_hints: { urgency: 0 },
        attrs: { entity_id: "entity-2", revised: true }, occurred_at: "2026-08-30T00:00:01.000Z",
      };
      const revised = await store.appendRevision(revisionInput);
      history.push(revised);
      await arrange(revised);
      await assertReads(revised, revisionInput);
      await assertInboxReads(revised, [undefined, { heads: true }, { siblings: true }, { tasks: true }]);
      await store.setConversationVisibility({
        org_id: orgId, thread_id: input.thread_id, hidden: true, expected_version: 0,
        updated_at: "2026-08-30T00:00:02.000Z",
      });
      await assertInboxReads(revised, [
        { list: "hidden" }, { list: "hidden", heads: true }, { list: "hidden", siblings: true },
      ]);
      const tombstone = await store.markTombstone({
        org_id: orgId, source: input.source, external_id: input.external_id,
        thread_id: input.thread_id, actor_id: input.actor_id, required_scope_ids: input.required_scope_ids,
        occurred_at: "2026-08-30T00:00:03.000Z", expected_head_id: revised.id,
      });
      history.push(tombstone);
      await assertReads(tombstone, {});
    });

    it("refreshes both conversation projections when a source head moves", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const firstId = `event-${randomUUID()}`;
      const threadA = `thread-${randomUUID()}`;
      const threadB = `thread-${randomUUID()}`;
      const threadC = `thread-${randomUUID()}`;
      const append = {
        id: firstId, org_id: orgId, source: "synthetic", external_id: `source-${firstId}`,
        thread_id: threadA, content_hash: HASH_A, content_media_type: "text/plain",
        content_byte_size: 1, occurred_at: now, expected_head_id: null,
      };
      const decision = (eventId) => ({
        event_id: eventId, org_id: orgId, disposition: "current_work", layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      });
      await store.commitIngest({ appends: [append], dispositions: [decision(firstId)] });
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      const revisionId = `event-${randomUUID()}`;
      await store.appendRevision({
        ...append, id: revisionId, thread_id: threadB,
        parent_event_id: firstId, expected_head_id: firstId,
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      assert.deepEqual(await store.listInbox(orgId, { heads: true }), []);
      await store.putDispositionIfAbsent(decision(revisionId));
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      const nextId = `event-${randomUUID()}`;
      await store.commitIngest({
        appends: [{
          ...append, id: nextId, thread_id: threadC, operation: "revise",
          parent_event_id: revisionId, expected_head_id: revisionId,
        }],
        dispositions: [decision(nextId)],
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      assert.deepEqual((await store.listInbox(orgId, { heads: true })).map((row) => row.event.id), [nextId]);
      await store.markTombstone({
        org_id: orgId, source: append.source, external_id: append.external_id,
        occurred_at: now, expected_head_id: nextId,
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      assert.deepEqual(await store.listInbox(orgId, { heads: true }), []);
    });

    it("refreshes the inferred conversation projection when a source is tombstoned", async () => {
      const { store, orgId } = await openBoundStore();
      const id = `event-${randomUUID()}`;
      const now = "2026-08-30T00:00:00.000Z";
      const input = {
        id, org_id: orgId, source: "synthetic", external_id: `source-${id}`,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      };
      await store.commitIngest({
        appends: [input],
        dispositions: [{
          event_id: id, org_id: orgId, disposition: "current_work", layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        }],
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      await store.markTombstone({
        org_id: orgId, source: input.source, external_id: input.external_id,
        occurred_at: now, expected_head_id: id,
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      assert.deepEqual(await store.listInbox(orgId, { heads: true }), []);
    });

    it("persists generated event identities used for inferred conversation threads", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const input = {
        org_id: orgId, source: "synthetic", external_id: `:out:${randomUUID()}`,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      };
      const first = await store.append(input);
      assert.equal((await store.getEvent(orgId, first.id)).thread_id, `synthetic:${first.id}`);
      await store.putDispositionIfAbsent({
        event_id: first.id, org_id: orgId, disposition: "current_work", layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      });
      assert.equal((await store.summarizeInbox(orgId)).count, 1);
      const revision = await store.appendRevision({
        ...input, parent_event_id: first.id, expected_head_id: first.id,
      });
      assert.equal((await store.getEvent(orgId, revision.id)).thread_id, `synthetic:${revision.id}`);
      assert.equal((await store.summarizeInbox(orgId)).count, 0);
      const tombstone = await store.markTombstone({
        org_id: orgId, source: input.source, external_id: input.external_id,
        occurred_at: now, expected_head_id: revision.id,
      });
      assert.equal((await store.getEvent(orgId, tombstone.id)).thread_id, `synthetic:${tombstone.id}`);
      const [batchEvent] = await store.commitIngest({
        appends: [{ ...input, external_id: `:out:${randomUUID()}` }],
        dispositions: [],
      });
      assert.equal((await store.getEvent(orgId, batchEvent.id)).thread_id, `synthetic:${batchEvent.id}`);
    });

    it("unfolds current work in the ingestion commit without overriding human intent or stale heads", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      for (const mode of ["policy", "human", "superseded"]) {
        const id = `event-${randomUUID()}`;
        const thread = `thread-${randomUUID()}`;
        if (mode === "human") {
          await store.setConversationVisibility({
            org_id: orgId, thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
          });
        } else {
          assert.equal((await store.setConversationPolicyHidden({
            org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
          })).outcome, "applied");
        }
        const append = {
          id, org_id: orgId, source: "synthetic", external_id: `source-${id}`, thread_id: thread,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        };
        const disposition = (eventId, value) => ({
          org_id: orgId, event_id: eventId, disposition: value, layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        });
        const nextId = `event-${randomUUID()}`;
        await store.commitIngest({
          appends: mode === "superseded"
            ? [append, { ...append, id: nextId, operation: "revise", parent_event_id: id, expected_head_id: id }]
            : [append],
          dispositions: mode === "superseded"
            ? [disposition(id, "current_work"), disposition(nextId, "outside_current_work")]
            : [disposition(id, "current_work")],
        });
        const pref = await store.getConversationPref(orgId, thread);
        assert.equal(pref.hidden, mode !== "policy");
        assert.equal(pref.hidden_reason, mode === "human" ? "human" : mode === "policy" ? null : "policy");
        assert.equal(pref.visibility_version, mode === "human" ? 1 : 0);
      }
    });

    it("unfolds a policy-hidden thread when its current head is revised into work", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const thread = `revision-${randomUUID()}`;
      const first = await store.append({
        org_id: orgId, source: "synthetic", external_id: thread, thread_id: thread,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      });
      assert.equal((await store.setConversationPolicyHidden({
        org_id: orgId, thread_id: thread, expected_visibility_version: 0, updated_at: now,
      })).outcome, "applied");
      const id = `event-${randomUUID()}`;
      await store.appendRevision({
        id, org_id: orgId, source: first.source, external_id: first.external_id, thread_id: thread,
        content_hash: HASH_B, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, parent_event_id: first.id, expected_head_id: first.id,
        disposition: {
          org_id: orgId, event_id: id, disposition: "current_work", layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        },
      });
      assert.equal((await store.getConversationPref(orgId, thread)).hidden, false);
    });

    it("rejects unbound or cross-organization dispositions before any ingest write", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const id = `event-${randomUUID()}`;
      const existing = await store.append({
        id: `existing-${id}`, org_id: orgId, source: "synthetic", external_id: `old-${id}`,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      });
      const original = {
        event_id: existing.id, org_id: orgId, disposition: "outside_current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      };
      await store.putDispositionIfAbsent(original);
      const saved = await store.getDisposition(existing.id);
      const append = {
        id, org_id: orgId, source: "synthetic", external_id: `new-${id}`,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      };
      const decision = { ...original, event_id: id, disposition: "current_work" };
      for (const request of [
        { appends: [append], dispositions: [{ ...decision, event_id: existing.id }] },
        { appends: [append], dispositions: [{ ...decision, org_id: `${orgId}-other` }] },
        { appends: [append], dispositions: [decision, decision] },
        { appends: [{ ...append, id: undefined }], dispositions: [decision] },
        { appends: [append, append], dispositions: [decision] },
      ]) {
        await assert.rejects(store.commitIngest(request), /Ingest (dispositions|event IDs)/);
        assert.deepEqual(await store.getDisposition(existing.id), saved);
        assert.equal(await store.findBySourceIdentity(append), null);
      }
      await assert.rejects(store.commitIngest({
        appends: [append, { ...append, id: existing.id, external_id: `collision-${id}` }],
        dispositions: [decision, { ...decision, event_id: existing.id }],
      }));
      assert.deepEqual(await store.getDisposition(existing.id), saved);
      assert.equal(await store.findBySourceIdentity(append), null);
      const created = await store.commitIngest({ appends: [append], dispositions: [decision] });
      assert.equal(created[0].id, id);
      assert.equal((await store.getDisposition(id)).disposition, "current_work");
    });

    it("rejects mismatched disposition identities for revisions and tombstones", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-30T00:00:00.000Z";
      const id = `event-${randomUUID()}`;
      const initial = await store.append({
        id, org_id: orgId, source: "synthetic", external_id: id,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null,
      });
      const decision = {
        event_id: id, org_id: orgId, disposition: "current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      };
      const base = {
        ...initial, id: `next-${id}`, content_media_type: "text/plain", content_byte_size: 1,
        parent_event_id: initial.id, expected_head_id: initial.id, disposition: decision,
      };
      for (const input of [
        base,
        { ...base, disposition: { ...decision, event_id: base.id, org_id: `${orgId}-other` } },
        { ...base, id: undefined },
      ]) {
        await assert.rejects(store.appendRevision(input), /Event disposition must match/);
        await assert.rejects(store.markTombstone(input), /Event disposition must match/);
        assert.equal((await store.findBySourceIdentity(initial)).id, initial.id);
        assert.equal(await store.getDisposition(initial.id), null);
      }
    });

    it("distinguishes explicit empty Event metadata from absent metadata after an ingest commit", async () => {
      const { store, orgId } = await openBoundStore();
      const events = await store.commitIngest({
        appends: [
          { external_id: "empty", direction_tags: [], weight_hints: {}, attrs: {} },
          { external_id: "absent" },
        ].map((metadata) => ({
          ...metadata, org_id: orgId, source: "synthetic", thread_id: metadata.external_id,
          content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: "2026-08-30T00:00:00.000Z", expected_head_id: null,
        })),
        dispositions: [],
      });
      assert.deepEqual(await store.listEvents(orgId), events);
      for (const [index, event] of events.entries()) {
        assert.deepEqual(await store.getEvent(orgId, event.id), event);
        assert.deepEqual(await store.findBySourceIdentity(event), event);
        for (const field of ["direction_tags", "weight_hints", "attrs"]) {
          assert.deepEqual(event[field], index === 0 ? (field === "direction_tags" ? [] : {}) : undefined);
        }
      }
    });

    it("keeps context epochs stable between reads and changes them with revisions and tombstones", async () => {
      const { store, orgId } = await openBoundStore();
      const input = {
        org_id: orgId, source: "synthetic", external_id: "stable-epoch", thread_id: "epoch-thread",
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z", expected_head_id: null,
      };
      const first = await store.append(input);
      const read = await store.openContextRead(orgId);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const repeated = await store.openContextRead(orgId);
      assert.notEqual(repeated.recorded_at, read.recorded_at);
      assert.equal(repeated.read_epoch, read.read_epoch);
      await store.append({ ...input, org_id: `${orgId}-other` });
      assert.equal((await store.openContextRead(orgId)).read_epoch, read.read_epoch);
      const revised = await store.appendRevision({
        ...input, content_hash: HASH_B, parent_event_id: first.id, expected_head_id: first.id,
        occurred_at: "2026-08-30T00:00:01.000Z",
      });
      const revisedRead = await store.openContextRead(orgId);
      assert.notEqual(revisedRead.read_epoch, read.read_epoch);
      assert.equal((await store.openContextReadForThread(orgId, input.thread_id)).read_epoch, revisedRead.read_epoch);
      await store.markTombstone({
        org_id: orgId, source: input.source, external_id: input.external_id, thread_id: input.thread_id,
        occurred_at: "2026-08-30T00:00:02.000Z", expected_head_id: revised.id,
      });
      const deletedRead = await store.openContextRead(orgId);
      assert.notEqual(deletedRead.read_epoch, revisedRead.read_epoch);
      assert.equal((await store.openContextRead(orgId)).read_epoch, deletedRead.read_epoch);
    });

    it("atomically claims outbound attempts and preserves recovery metadata", async () => {
      const { store, orgId } = await openBoundStore();
      const input = {
        org_id: orgId,
        client_request_id: "shared-reply",
        thread_id: "feishu:oc_1",
        recovery_hash: HASH_A,
        now: "2026-08-24T00:00:00.000Z",
      };
      const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimOutboundAttempt(input)));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await store.claimOutboundAttempt({ ...input, org_id: `${orgId}-other` }), true);
      const pending = await store.getOutboundAttempt(orgId, input.client_request_id);
      assert.equal(pending.status, "pending");
      assert.equal(pending.recovery_hash, HASH_A);
      const receipt = { accepted: true, rpc_id: "om_1", channel_message_ids: ["om_1", "om_2"] };
      await store.putOutboundAttempt({ ...input, status: "accepted", recovery_hash: HASH_B, receipt });
      const event = await store.append({
        org_id: orgId, source: "regenic", external_id: "outbound-event",
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: input.now, expected_head_id: null,
      });
      const sent = await store.putOutboundAttempt({
        org_id: orgId, client_request_id: input.client_request_id, thread_id: input.thread_id,
        status: "sent", event_id: event.id, now: "2026-08-24T00:00:01.000Z",
      });
      assert.equal(sent.recovery_hash, HASH_B);
      assert.deepEqual(sent.receipt, receipt);
      assert.equal(sent.created_at, input.now);
      assert.deepEqual(await store.getOutboundAttempt(orgId, input.client_request_id), sent);
      assert.equal(await store.claimOutboundAttempt(input), false);
    });

    it("reclaims only confirmed outbound rejections atomically for the original thread", async () => {
      const { store, orgId } = await openBoundStore();
      const input = {
        org_id: orgId, client_request_id: "retry-rejected", thread_id: "feishu:oc_1",
        recovery_hash: HASH_A, now: "2026-08-24T00:00:00.000Z",
      };
      await store.putOutboundAttempt({ ...input, status: "rejected" });
      assert.equal(await store.claimOutboundAttempt({ ...input, thread_id: "feishu:other" }), false);
      const next = { ...input, recovery_hash: HASH_B, now: "2026-08-25T00:00:00.000Z" };
      const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimOutboundAttempt(next)));
      assert.equal(claims.filter(Boolean).length, 1);
      const pending = await store.getOutboundAttempt(orgId, input.client_request_id);
      assert.equal(pending.status, "pending");
      assert.equal(pending.created_at, input.now);
      assert.equal(pending.updated_at, next.now);
      assert.equal(pending.recovery_hash, HASH_B);
      assert.equal(await store.claimOutboundAttempt(next), false);
      for (const status of ["failed", "accepted", "sent"]) {
        await store.putOutboundAttempt({ ...input, status });
        assert.equal(await store.claimOutboundAttempt(next), false, status);
      }
      for (const [index, evidence] of [{ receipt: { accepted: true } }, { channel_message_ids: [] }].entries()) {
        const conflicting = { ...input, client_request_id: `rejected-with-evidence-${index}` };
        await store.putOutboundAttempt({ ...conflicting, status: "rejected", ...evidence });
        assert.equal(await store.claimOutboundAttempt(conflicting), false);
      }
    });

    it("rejects executor reservations prepared from a stale recipe snapshot", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const recipe = {
        id: `recipe-${randomUUID()}`, org_id: orgId, name: "Snapshot start",
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: "session", executor_config: {}, include_context: false,
        can_write_back: false, enabled: true, created_at: now, updated_at: now,
      };
      const item = {
        id: `work-${randomUUID()}`, org_id: orgId, recipe_id: recipe.id,
        thread_id: `feishu:chat-${randomUUID()}`, unit_key: "task-1",
        record_class: "task", thread_facet: "ticket", status: "open",
        created_at: now, updated_at: now,
      };
      const run = {
        id: `run-${randomUUID()}`, org_id: orgId, work_item_id: item.id,
        recipe_id: recipe.id, executor_type: "session", status: "running",
        start_state: "pending", created_at: now, updated_at: now,
      };
      await store.putRecipe(recipe);
      const created = await createTestWorkItem(store, item);
      await store.putRecipeIfUnchanged({
        recipe: { ...recipe, name: "Updated snapshot", updated_at: "2026-08-25T00:00:00.000Z" },
        expected_recipe: recipe,
      });

      assert.equal(await store.claimWorkRunStart({
        run, expected_item: created.item, expected_recipe: recipe,
      }), false);
      assert.equal((await store.getWorkItem(orgId, item.id)).status, "open");
      assert.ok(!(await store.getActiveWorkRun(orgId, item.id)));
      const currentRecipe = await store.getRecipe(orgId, recipe.id);
      assert.equal(await store.claimWorkRunStart({
        run: { ...run, id: `run-${randomUUID()}` },
        expected_item: created.item,
        expected_recipe: currentRecipe,
      }), true);
    });

    it("atomically reserves executor runs and recipe slots before external start", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const recipeId = `recipe-${randomUUID()}`;
      await store.putRecipe({
        id: recipeId, org_id: orgId, name: "Atomic starts", match: { record_class: "task" },
        trigger: { kind: "push" }, executor_type: "session", executor_config: {},
        include_context: false, can_write_back: false, enabled: true, max_concurrent: 1,
        created_at: now, updated_at: now,
      });
      const claims = [];
      for (let index = 0; index < 4; index += 1) {
        const itemId = `work-${randomUUID()}`;
        const { item } = await createTestWorkItem(store, {
          id: itemId, org_id: orgId, recipe_id: recipeId, thread_id: `feishu:chat-${index}`,
          unit_key: `task-${index}`, record_class: "task", thread_facet: "ticket", status: "open",
          created_at: now, updated_at: now,
        });
        claims.push({
          run: {
            id: `run-${randomUUID()}`, org_id: orgId, work_item_id: itemId, recipe_id: recipeId,
            executor_type: "session", status: "running", start_state: "pending",
            created_at: now, updated_at: now,
          },
          expected_item: item,
          max_concurrent: 1,
        });
      }
      const results = await Promise.all(claims.map((claim) => store.claimWorkRunStart(claim)));
      assert.equal(results.filter(Boolean).length, 1);
      const winner = claims[results.indexOf(true)];
      const saved = await store.getActiveWorkRun(orgId, winner.run.work_item_id);
      assert.equal(saved.id, winner.run.id);
      assert.equal(saved.start_state, "pending");
      assert.equal((await store.getWorkItem(orgId, saved.work_item_id)).status, "running");
      assert.equal(await store.claimWorkRunStart({ run: { ...winner.run, id: `run-${randomUUID()}` } }), false);
      const manual = claims[results.indexOf(false)].run;
      assert.equal(await store.claimWorkRunStart({ run: manual }), true);
      const submitted = await store.checkpointWorkRunStart({
        expected_item: await store.getWorkItem(orgId, saved.work_item_id),
        expected_run: saved,
        kind: "submitted",
        external_run_id: "remote-1",
        now,
      });
      assert.equal(submitted.outcome, "applied");
      assert.equal(submitted.run.start_state, "submitted");
      assert.deepEqual(await store.getWorkRun(orgId, saved.id), submitted.run);
      assert.equal((await store.getWorkRun(orgId, saved.id)).external_run_id, "remote-1");
      assert.equal((await store.listWorkRuns(orgId)).length, 2);
    });

    it("persists search-answer metadata beside its work ledger", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const itemId = `search-answer-${randomUUID()}`;
      const recipe = {
        id: `recipe-${randomUUID()}`,
        org_id: orgId,
        name: "Search answer",
        match: { record_class: "utterance" },
        trigger: { kind: "manual" },
        executor_type: "session",
        executor_config: {},
        can_write_back: false,
        include_context: false,
        enabled: true,
        created_at: now,
        updated_at: now,
      };
      await store.putRecipe(recipe);
      const record = {
        id: `answer-${randomUUID()}`,
        org_id: orgId,
        work_item_id: itemId,
        query: "Who was selected?",
        event_ids: ["event-1", "event-2"],
        scope: {
          intent: "aggregate",
          complete: true,
          total_count: 2,
          included_count: 2,
          omitted_count: 0,
          occurred_after: "2026-08-01T00:00:00.000Z",
          occurred_before: "2026-08-24T00:00:00.000Z",
        },
        created_at: now,
        updated_at: now,
      };
      const created = await createTestWorkItem(store, {
        id: itemId,
        org_id: orgId,
        recipe_id: recipe.id,
        thread_id: `system:search-answer:${itemId}`,
        unit_key: itemId,
        record_class: "utterance",
        thread_facet: "agent",
        status: "open",
        created_at: now,
        updated_at: now,
      }, record);
      assert.deepEqual(created.search_answer, record);
      assert.deepEqual(await store.getSearchAnswer(orgId, record.id), record);
      const timedOut = {
        ...record,
        outcome: "timed_out",
        updated_at: "2026-08-24T00:05:00.000Z",
      };
      await assert.rejects(store.putSearchAnswer(timedOut),
        /identity and outcome cannot be changed/);
      assert.deepEqual(await store.getSearchAnswer(orgId, record.id), record);
      assert.equal(await store.deleteSearchAnswer("other-org", record.id), false);
      assert.equal(await store.deleteSearchAnswer(orgId, record.id), true);
      assert.equal(await store.deleteSearchAnswer(orgId, record.id), false);
      assert.equal(await store.getSearchAnswer(orgId, record.id), null);
      assert.deepEqual(await store.putSearchAnswer(timedOut), timedOut);
      const updated = await store.putSearchAnswer({
        ...timedOut, query: "Updated question", created_at: "2026-08-25T00:00:00.000Z",
      });
      assert.equal(updated.created_at, record.created_at);
      assert.equal(updated.query, "Updated question");
      assert.deepEqual(await store.getSearchAnswer(orgId, record.id), updated);
    });

    it("rolls back a conflicting ingest page", async () => {
      const { store, orgId } = await openBoundStore();
      const first = await store.append({
        org_id: orgId,
        source: "regenic",
        external_id: "conflict-1",
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-24T00:00:00.000Z",
        expected_head_id: null,
      });
      await assert.rejects(
        () =>
          store.commitIngest({
            appends: [
              {
                org_id: orgId,
                source: "regenic",
                external_id: "conflict-2",
                content_hash: HASH_B,
                content_media_type: "text/plain",
                content_byte_size: 1,
                occurred_at: "2026-08-24T00:00:01.000Z",
                expected_head_id: null,
              },
              {
                org_id: orgId,
                source: "regenic",
                external_id: "conflict-1",
                content_hash: HASH_C,
                content_media_type: "text/plain",
                content_byte_size: 1,
                occurred_at: "2026-08-24T00:00:02.000Z",
                expected_head_id: null,
              },
            ],
            dispositions: [],
          }),
        (error) => error instanceof AuthorityConflictError,
      );
      assert.equal(
        await store.findBySourceIdentity({
          org_id: orgId,
          source: "regenic",
          external_id: "conflict-2",
        }),
        null,
      );
      assert.equal(
        (
          await store.findBySourceIdentity({
            org_id: orgId,
            source: "regenic",
            external_id: "conflict-1",
          })
        ).id,
        first.id,
      );
    });

    it("fences stale same-owner connector polls after lease takeover", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({ id: installationId, org_id: orgId, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: "2026-08-12T00:00:00.000Z" });
      for (const action of ["settle", "release"]) {
        const now = new Date().toISOString();
        const firstStarted = Promise.withResolvers();
        const secondStarted = Promise.withResolvers();
        const firstPage = Promise.withResolvers();
        const secondPage = Promise.withResolvers();
        const renewalFailed = Promise.withResolvers();
        const renewalTimeout = setTimeout(
          () => renewalFailed.reject(new Error("lease renewal was not attempted")),
          1000,
        );
        const renewLease = store.renewLease.bind(store);
        let rejectFirstRenewal = true;
        store.renewLease = async (lease) => {
          if (lease.stream_key === action && rejectFirstRenewal) {
            rejectFirstRenewal = false;
            renewalFailed.resolve();
            clearTimeout(renewalTimeout);
            return null;
          }
          return renewLease(lease);
        };
        let count = 0;
        const connector = {
          poll() {
            if (++count === 1) {
              firstStarted.resolve();
              return firstPage.promise;
            }
            secondStarted.resolve();
            return secondPage.promise;
          },
        };
        const runner = new ConnectorRunner(connector, { async ingest() { throw new Error("unexpected ingest"); } },
          store, () => now);
        const request = { installation_id: installationId, stream_key: action, lease_owner: "same-worker",
          lease_duration_ms: 20 };
        const batch = { schema_version: INGEST_SCHEMA_VERSION, connector_id: "fake-poll", org_id: orgId,
          delivery_id: "page", received_at: now, records: [] };
        const oldRun = runner.poll(request).then((value) => ({ value }), (error) => ({ error }));
        await firstStarted.promise;
        await renewalFailed.promise;
        const old = await oldRun;
        assert.equal(old.value.status, "lease_unavailable");
        request.lease_duration_ms = 30_000;
        const newRun = runner.poll(request);
        await secondStarted.promise;
        if (action === "settle") firstPage.resolve({ batch, next_cursor: "old" });
        else firstPage.reject(new Error("old poll failed"));
        assert.equal((await store.getCursor(installationId, action)).cursor, undefined);
        assert.equal(await store.acquireLease({ ...request, lease_owner: "third-worker", now }), null);
        secondPage.resolve({ batch, next_cursor: "new" });
        assert.equal((await newRun).status, "completed");
        assert.equal((await store.getCursor(installationId, action)).cursor, "new");
      }
    });

    it("renews only the current unexpired connector lease claim", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      const now = new Date().toISOString();
      const leaseInput = {
        installation_id: installationId,
        stream_key: "renewal",
        lease_owner: "same-worker",
        now,
        lease_duration_ms: 30,
      };
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now,
      });
      const first = await store.acquireLease(leaseInput);
      assert.ok(first);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const current = await store.acquireLease({
        ...leaseInput, now: new Date().toISOString(), lease_duration_ms: 1000,
      });
      assert.ok(current);
      assert.notEqual(current.claim_token, first.claim_token);
      assert.equal(await store.renewLease({
        ...leaseInput, claim_token: first.claim_token, now: new Date().toISOString(),
      }), null);

      const renewed = await store.renewLease({
        ...leaseInput,
        claim_token: current.claim_token,
        now: new Date().toISOString(),
        lease_duration_ms: 2000,
      });
      assert.ok(renewed);
      assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(current.lease_expires_at));
      assert.equal(await store.releaseLease({
        ...leaseInput, claim_token: current.claim_token, now: new Date().toISOString(),
      }), true);
      assert.equal(await store.renewLease({
        ...leaseInput,
        claim_token: current.claim_token,
        now: new Date().toISOString(),
        lease_duration_ms: 1000,
      }), null);
      const expiring = await store.acquireLease({
        ...leaseInput, stream_key: "expired", now: new Date().toISOString(),
      });
      assert.ok(expiring);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(await store.renewLease({
        ...leaseInput,
        stream_key: "expired",
        claim_token: expiring.claim_token,
        now: new Date().toISOString(),
      }), null);
    });

    it("commits a revision page atomically and rolls it back on lease takeover", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      const externalId = `message-${randomUUID()}`;
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(blobs, store);
      const created = await service.ingest(createBatch(orgId, externalId));
      const request = {
        installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      };
      const revision = createBatch(orgId, externalId);
      revision.records[0].operation = "revise";
      revision.records[0].content[0].text = "Revised.";
      const runner = new ConnectorRunner({
        async poll() { return { batch: revision, next_cursor: "first" }; },
      }, service, store, () => now);
      const appendRevision = store.appendRevision;
      store.appendRevision = async () => { throw new Error("unexpected separate revision"); };
      const first = await runner.poll(request);
      store.appendRevision = appendRevision;
      assert.equal(first.status, "completed");
      const identity = { org_id: orgId, source: "regenic", external_id: externalId };
      const before = await store.findBySourceIdentity(identity);
      assert.equal(before.parent_event_id, created.records[0].event_id);
      assert.equal(before.id, first.result.records[0].event_id);
      assert.equal((await store.latestAttempt(installationId)).status, "succeeded");
      assert.equal((await store.getCursor(installationId, "personal")).cursor, "first");

      const commitPage = store.commitSyncPage.bind(store);
      store.commitSyncPage = async (page) => {
        await store.acquireLease({
          ...request, lease_owner: "other-worker", now, preempt: true,
        });
        return commitPage(page);
      };
      const later = createBatch(orgId, externalId);
      later.records[0].operation = "revise";
      later.records[0].content[0].text = "Later.";
      const laterRunner = new ConnectorRunner({
        async poll() { return { batch: later, next_cursor: "stale" }; },
      }, service, store, () => now);
      assert.equal((await laterRunner.poll(request)).status, "lease_unavailable");
      assert.equal((await store.findBySourceIdentity(identity)).id, before.id);
      assert.equal((await store.listAttempts(installationId)).length, 1);
      assert.equal((await store.getCursor(installationId, "personal")).cursor, "first");
    });

    it("fences existing-event disposition repairs in the sync-page transaction", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      for (const mode of ["success", "alias", "mixed", "lease", "head", "disposition", "identity", "foreign"]) {
        const externalId = `repair-${mode}-${randomUUID()}`;
        const identity = { org_id: orgId, source: "synthetic", external_id: externalId };
        const repairIdentity = mode === "alias"
          ? { ...identity, source: "remote-alias" }
          : identity;
        const thread = `thread-${externalId}`;
        const base = {
          ...identity, thread_id: thread, content_hash: HASH_A, content_media_type: "text/plain",
          content_byte_size: 1, occurred_at: now,
        };
        const event = await store.append({ ...base, expected_head_id: null });
        if (mode === "alias") {
          await store.bindSourceIdentityAliases({
            org_id: orgId, event_id: event.id,
            aliases: [{ source: repairIdentity.source, external_id: externalId }],
          });
        }
        await store.setConversationPolicyVisibility({
          org_id: orgId, thread_id: thread, hidden: true, expected_visibility_version: 0, updated_at: now,
        });
        const decision = {
          event_id: event.id, org_id: orgId, disposition: "current_work",
          layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
        };
        if (mode === "head") {
          await store.appendRevision({
            ...base, content_hash: HASH_B, parent_event_id: event.id, expected_head_id: event.id,
          });
        }
        if (mode === "disposition") {
          await store.putDispositionIfAbsent({ ...decision, disposition: "outside_current_work" });
        }
        const lease = await store.acquireLease({
          installation_id: installationId, stream_key: externalId,
          lease_owner: mode === "lease" ? "other" : "worker", now, lease_duration_ms: 30000,
        });
        const attempt = {
          id: `attempt-${externalId}`, org_id: orgId, connector_installation_id: installationId,
          stream_key: externalId, delivery_id: externalId, started_at: now,
        };
        const page = {
          attempt,
          ...(mode === "mixed" ? {
            ingest: {
              appends: [{
                id: `${event.id}-new`, org_id: orgId, source: "synthetic",
                external_id: `${externalId}-new`, content_hash: HASH_B,
                content_media_type: "text/plain", content_byte_size: 1, occurred_at: now,
                expected_head_id: null,
              }],
              dispositions: [{
                event_id: `${event.id}-new`, org_id: orgId, disposition: "outside_current_work",
                layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
              }],
            },
          } : {}),
          disposition_repairs: [{
            identities: [mode === "identity" ? { ...repairIdentity, external_id: "wrong" } :
              mode === "foreign" ? { ...repairIdentity, org_id: `${orgId}-other` } : repairIdentity],
            decision,
          }],
          settle: {
            attempt_id: attempt.id, installation_id: installationId, stream_key: externalId,
            lease_owner: "worker", claim_token: lease.claim_token,
            finished_at: now, duplicate_count: 1,
            accepted_count: 0, quarantined_count: 0, retryable_failure_count: 0,
            next_cursor: "next", quarantines: [],
          },
        };
        if (mode === "success" || mode === "alias" || mode === "mixed") {
          await store.commitSyncPage(page);
          assert.equal((await store.getDisposition(event.id)).disposition, "current_work");
          assert.equal((await store.getConversationPref(orgId, thread)).hidden, false);
          assert.equal((await store.getCursor(installationId, externalId)).cursor, "next");
          if (mode === "mixed") {
            assert.equal((await store.getEvent(orgId, `${event.id}-new`)).id, `${event.id}-new`);
            assert.equal((await store.getDisposition(`${event.id}-new`)).disposition,
              "outside_current_work");
          }
        } else {
          await assert.rejects(store.commitSyncPage(page));
          assert.equal((await store.getDisposition(event.id))?.disposition,
            mode === "disposition" ? "outside_current_work" : undefined);
          assert.equal((await store.getConversationPref(orgId, thread)).hidden, true);
          assert.equal((await store.getCursor(installationId, externalId)).cursor, undefined);
          assert.equal((await store.listAttempts(installationId)).some((row) => row.id === attempt.id), false);
        }
      }
    });

    it("commits a tombstone page and rolls it back on lease takeover", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(blobs, store);
      for (const hasHead of [true, false]) {
        const externalId = `message-${randomUUID()}`;
        const identity = { org_id: orgId, source: "regenic", external_id: externalId };
        if (hasHead) await service.ingest(createBatch(orgId, externalId));
        const previous = await store.findBySourceIdentity(identity);
        const batch = createBatch(orgId, externalId);
        batch.records[0].operation = "tombstone";
        delete batch.records[0].content;
        const runner = new ConnectorRunner({
          async poll() { return { batch, next_cursor: "next" }; },
        }, service, store, () => now);
        const markTombstone = store.markTombstone;
        store.markTombstone = async () => { throw new Error("unexpected separate tombstone"); };
        const result = await runner.poll({
          installation_id: installationId, stream_key: externalId,
          lease_owner: "worker", lease_duration_ms: 30000,
        });
        store.markTombstone = markTombstone;
        assert.equal(result.status, "completed");
        const head = await store.findBySourceIdentity(identity);
        assert.equal(head.operation, "tombstone");
        assert.equal(head.id, result.result.records[0].event_id);
        assert.equal(head.parent_event_id, previous?.id);
        assert.equal(head.content_hash, previous?.content_hash);
        assert.ok(await store.getDisposition(head.id));
        assert.equal((await store.getCursor(installationId, externalId)).cursor, "next");
      }

      const externalId = `message-${randomUUID()}`;
      const identity = { org_id: orgId, source: "regenic", external_id: externalId };
      await service.ingest(createBatch(orgId, externalId));
      const previous = await store.findBySourceIdentity(identity);
      const batch = createBatch(orgId, externalId);
      batch.records[0].operation = "tombstone";
      delete batch.records[0].content;
      const request = {
        installation_id: installationId, stream_key: externalId,
        lease_owner: "worker", lease_duration_ms: 30000,
      };
      const commitPage = store.commitSyncPage.bind(store);
      let attemptedId;
      store.commitSyncPage = async (page) => {
        attemptedId = page.ingest.appends[0].id;
        await store.acquireLease({ ...request, lease_owner: "other-worker", now, preempt: true });
        return commitPage(page);
      };
      const runner = new ConnectorRunner({
        async poll() { return { batch, next_cursor: "stale" }; },
      }, service, store, () => now);
      assert.equal((await runner.poll(request)).status, "lease_unavailable");
      assert.ok(attemptedId);
      assert.equal(await store.getEvent(orgId, attemptedId), null);
      assert.equal(await store.getDisposition(attemptedId), null);
      assert.equal((await store.findBySourceIdentity(identity)).id, previous.id);
      assert.equal((await store.getCursor(installationId, externalId)).cursor, undefined);
      assert.equal((await store.listAttempts(installationId)).length, 2);
    });

    it("rejects a foreign-organization revision before non-atomic ingestion", async () => {
      const { store, blobs, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      const foreignOrg = `foreign-${randomUUID()}`;
      const externalId = `message-${randomUUID()}`;
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const service = new IngestionService(blobs, store);
      assert.equal((await service.ingest(createBatch(foreignOrg, externalId))).valid, true);
      const identity = { org_id: foreignOrg, source: "regenic", external_id: externalId };
      const before = await store.findBySourceIdentity(identity);
      assert.ok(before);
      const revision = createBatch(foreignOrg, externalId);
      revision.records[0].operation = "revise";
      revision.records[0].content[0].text = "Changed.";
      const runner = new ConnectorRunner({
        async poll() { return { batch: revision, next_cursor: "foreign" }; },
      }, service, store, () => now);
      await assert.rejects(runner.poll({
        installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", lease_duration_ms: 30000,
      }), /installation.*organization/i);
      assert.equal((await store.findBySourceIdentity(identity)).id, before.id);
      assert.deepEqual(await store.listAttempts(installationId), []);
      assert.equal((await store.getCursor(installationId, "personal")).cursor, undefined);
    });

    it("rejects cross-organization attempts and sync-page writes", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-12T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({ id: installationId, org_id: orgId, connector_type: "fake-poll",
        status: "enabled", config: {}, created_at: now });
      const lease = await store.acquireLease({ installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30000 });
      const attempt = { id: `attempt-${randomUUID()}`, org_id: orgId,
        connector_installation_id: installationId, stream_key: "personal", delivery_id: "page", started_at: now };
      const settle = { attempt_id: attempt.id, installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", claim_token: lease.claim_token, finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "next", quarantines: [] };
      const eventId = `event-${randomUUID()}`;
      const append = { id: eventId, org_id: orgId, source: "synthetic", external_id: eventId,
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        occurred_at: now, expected_head_id: null };
      const pref = { org_id: orgId, thread_id: "thread", hidden: true,
        expected_visibility_version: 0, updated_at: now };
      await assert.rejects(store.beginAttempt({ ...attempt, org_id: "other-org" }), /installation.*organization/i);
      for (const page of [
        { attempt: { ...attempt, org_id: "other-org" }, settle },
        { attempt, settle, ingest: { appends: [{ ...append, org_id: "other-org" }], dispositions: [] } },
        { attempt, settle, prefs: [{ ...pref, org_id: "other-org" }] },
      ]) {
        await assert.rejects(store.commitSyncPage(page), /organization/i);
        assert.deepEqual(await store.listAttempts(installationId), []);
        assert.equal(await store.getEvent("other-org", eventId), null);
        assert.equal(await store.getConversationPref("other-org", "thread"), null);
        assert.equal((await store.getCursor(installationId, "personal")).cursor, undefined);
      }
      assert.equal((await store.commitSyncPage({ attempt, settle,
        ingest: { appends: [append], dispositions: [] }, prefs: [pref] })).attempt.status, "succeeded");
      assert.equal((await store.getEvent(orgId, eventId)).id, eventId);
    });

    it("fences sync-page and settlement attempt identities", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-12T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      const otherInstallationId = `install-${randomUUID()}`;
      for (const id of [installationId, otherInstallationId]) {
        await store.createInstallation({ id, org_id: orgId, connector_type: "fake-poll",
          status: "enabled", config: {}, created_at: now });
      }
      const lease = { installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", now, lease_duration_ms: 30000 };
      const personalLease = await store.acquireLease(lease);
      await store.acquireLease({ ...lease, stream_key: "other" });
      await store.acquireLease({ ...lease, installation_id: otherInstallationId });
      const attempt = { id: `attempt-${randomUUID()}`, org_id: orgId,
        connector_installation_id: installationId, stream_key: "personal", delivery_id: "page", started_at: now };
      const settle = { attempt_id: attempt.id, installation_id: installationId, stream_key: "personal",
        lease_owner: "worker", claim_token: personalLease.claim_token,
        finished_at: now, accepted_count: 1, duplicate_count: 0,
        quarantined_count: 0, retryable_failure_count: 0, next_cursor: "next", quarantines: [] };
      const eventId = `event-${randomUUID()}`;
      const page = { attempt, settle, ingest: { appends: [{ id: eventId, org_id: orgId,
        source: "synthetic", external_id: eventId, content_hash: HASH_A, content_media_type: "text/plain",
        content_byte_size: 1, occurred_at: now, expected_head_id: null }], dispositions: [] } };
      for (const change of [{ attempt_id: "other" }, { installation_id: otherInstallationId }, { stream_key: "other" }]) {
        await assert.rejects(store.commitSyncPage({ ...page, settle: { ...settle, ...change } }), /Sync page attempt identity/);
        assert.equal(await store.getEvent(orgId, eventId), null);
        assert.deepEqual(await store.listAttempts(installationId), []);
        assert.equal((await store.getCursor(installationId, "personal")).cursor, undefined);
      }
      await store.beginAttempt(attempt);
      await assert.rejects(store.beginAttempt(attempt));
      await assert.rejects(store.commitSyncPage({
        ...page, attempt: { ...attempt, id: `other-${randomUUID()}` },
      }), /Sync page attempt identity/);
      assert.equal((await store.latestAttempt(installationId)).status, "running");
      assert.equal(await store.getEvent(orgId, eventId), null);
      await assert.rejects(store.settleAttempt({ ...settle, attempt_id: "missing" }), /attempt not found/i);
      for (const change of [{ installation_id: otherInstallationId }, { stream_key: "other" }]) {
        await assert.rejects(store.settleAttempt({ ...settle, ...change }), /attempt.*installation.*stream/i);
        assert.equal((await store.latestAttempt(installationId)).status, "running");
      }
      await store.settleAttempt(settle);
      await store.acquireLease(lease);
      await assert.rejects(store.settleAttempt(settle), /attempt.*running/i);
      assert.equal((await store.getCursor(installationId, "personal")).cursor, "next");
    });

    it("commits a sequential same-identity event chain with the sync page", async () => {
      const { store, orgId } = await openBoundStore();
      const now = "2026-08-24T00:00:00.000Z";
      const installationId = `install-${randomUUID()}`;
      const externalId = `message-${randomUUID()}`;
      const threadId = `thread-${externalId}`;
      await store.createInstallation({
        id: installationId, org_id: orgId, connector_type: "native-local",
        status: "enabled", config: {}, created_at: now,
      });
      const lease = await store.acquireLease({
        installation_id: installationId, stream_key: "personal", lease_owner: "worker",
        now, lease_duration_ms: 30000,
      });
      const attempt = {
        id: `attempt-${randomUUID()}`, org_id: orgId,
        connector_installation_id: installationId, stream_key: "personal",
        delivery_id: "same-identity-chain", started_at: now,
      };
      const eventIds = ["create", "revision", "tombstone", "recreate", "recreated-tombstone"].map((kind) =>
        `${kind}-${randomUUID()}`);
      const appends = [
        {
          id: eventIds[0], org_id: orgId, source: "synthetic", external_id: externalId,
          thread_id: threadId, content_hash: HASH_A, content_media_type: "text/plain",
          content_byte_size: 1, occurred_at: now, expected_head_id: null,
        },
        {
          id: eventIds[1], org_id: orgId, source: "synthetic", external_id: externalId,
          thread_id: threadId, operation: "revise", parent_event_id: eventIds[0],
          revision_id: "revision-1", content_hash: HASH_B, content_media_type: "text/plain",
          content_byte_size: 1, occurred_at: now, expected_head_id: eventIds[0],
        },
        {
          id: eventIds[2], org_id: orgId, source: "synthetic", external_id: externalId,
          thread_id: threadId, operation: "tombstone", parent_event_id: eventIds[1],
          occurred_at: now, expected_head_id: eventIds[1],
        },
        {
          id: eventIds[3], org_id: orgId, source: "synthetic", external_id: externalId,
          thread_id: threadId, content_hash: HASH_C, content_media_type: "text/plain",
          content_byte_size: 1, occurred_at: now, expected_head_id: eventIds[2],
        },
        {
          id: eventIds[4], org_id: orgId, source: "synthetic", external_id: externalId,
          thread_id: threadId, operation: "tombstone", parent_event_id: eventIds[3],
          occurred_at: now, expected_head_id: eventIds[3],
        },
      ];
      const dispositions = [0, 1, 2, 4].map((index) => ({
        event_id: eventIds[index],
        org_id: orgId,
        disposition: index === 2 || index === 4 ? "outside_current_work" : "current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      }));
      const committed = await store.commitSyncPage({
        attempt,
        ingest: { appends, dispositions },
        settle: {
          attempt_id: attempt.id, installation_id: installationId, stream_key: "personal",
          lease_owner: "worker", claim_token: lease.claim_token,
          finished_at: now, accepted_count: 5, duplicate_count: 0,
          quarantined_count: 0, retryable_failure_count: 0, next_cursor: "next", quarantines: [],
        },
      });
      assert.deepEqual(committed.events.map((event) => event.id), eventIds);
      assert.equal((await store.findBySourceIdentity({
        org_id: orgId, source: "synthetic", external_id: externalId,
      })).id, eventIds[4]);
      assert.equal((await store.getEvent(orgId, eventIds[2])).parent_event_id, eventIds[1]);
      assert.equal((await store.getEvent(orgId, eventIds[4])).parent_event_id, eventIds[3]);
      assert.equal((await store.getDisposition(eventIds[4])).disposition, "outside_current_work");
      assert.equal(committed.attempt.status, "succeeded");
      assert.equal((await store.getCursor(installationId, "personal")).cursor, "next");
    });

    it("acquires and releases a connector lease atomically", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId,
        org_id: orgId,
        connector_type: "fake-poll",
        status: "enabled",
        config: { scope: "personal" },
        created_at: "2026-08-12T00:00:00.000Z",
      });
      const first = await store.acquireLease({
        installation_id: installationId,
        stream_key: "personal",
        lease_owner: "worker-a",
        now: "2026-08-12T00:00:00.000Z",
        lease_duration_ms: 30_000,
      });
      assert.equal(first.lease_owner, "worker-a");
      assert.equal(
        await store.acquireLease({
          installation_id: installationId,
          stream_key: "personal",
          lease_owner: "worker-b",
          now: "2026-08-12T00:00:01.000Z",
          lease_duration_ms: 30_000,
        }),
        null,
      );
      assert.equal(
        await store.releaseLease({
          installation_id: installationId,
          stream_key: "personal",
          lease_owner: "worker-a",
          claim_token: first.claim_token,
          now: "2026-08-12T00:00:02.000Z",
        }),
        true,
      );
      const second = await store.acquireLease({
        installation_id: installationId,
        stream_key: "personal",
        lease_owner: "worker-b",
        now: "2026-08-12T00:00:03.000Z",
        lease_duration_ms: 30_000,
      });
      assert.equal(second.lease_owner, "worker-b");
    });

    it("claims, fails, retries, and completes a projection job", async () => {
      const { store, orgId } = await openBoundStore();
      await store.append({
        org_id: orgId,
        source: "synthetic",
        external_id: `outbox-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      const [claimed] = (
        await store.claimContextProjectionJobs({
          owner: "worker-1",
          now: "2026-08-30T00:01:00.000Z",
          lease_ms: 60_000,
          limit: 100,
        })
      ).filter((job) => job.org_id === orgId);
      assert.equal(claimed.org_id, orgId);
      assert.equal(claimed.attempts, 1);
      assert.equal(
        (
          await store.claimContextProjectionJobs({
            owner: "worker-2",
            now: "2026-08-30T00:01:30.000Z",
            lease_ms: 60_000,
            limit: 100,
          })
        ).some((job) => job.id === claimed.id),
        false,
      );
      assert.equal(
        await store.completeContextProjectionJob({
          id: claimed.id,
          owner: "worker-2",
          completed_at: "2026-08-30T00:01:30.000Z",
        }),
        false,
      );
      assert.equal(
        await store.failContextProjectionJob({
          id: claimed.id,
          owner: "worker-1",
          failed_at: "2026-08-30T00:01:40.000Z",
          next_retry_at: "2026-08-30T00:02:00.000Z",
          error_code: "projection_failed",
        }),
        true,
      );
      const [retried] = (
        await store.claimContextProjectionJobs({
          owner: "worker-2",
          now: "2026-08-30T00:02:00.000Z",
          lease_ms: 60_000,
          limit: 100,
        })
      ).filter((job) => job.id === claimed.id);
      assert.equal(retried.attempts, 2);
      assert.equal(
        await store.completeContextProjectionJob({
          id: retried.id,
          owner: "worker-2",
          completed_at: "2026-08-30T00:02:01.000Z",
        }),
        true,
      );
      assert.equal(
        (await store.listContextProjectionJobs(orgId)).find(
          (job) => job.id === claimed.id,
        ).status,
        "succeeded",
      );
    });

    it("pushes context filters into complete lifecycles, including moved revisions and tombstones", async () => {
      const { store, orgId } = await openBoundStore();
      const base = {
        org_id: orgId, source: "synthetic", external_id: "message",
        content_hash: HASH_A, content_media_type: "text/plain", content_byte_size: 1,
        thread_id: "old-thread", actor_id: "old-actor", required_scope_ids: ["visible"],
        attrs: { entity_id: "entity-1" }, occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      };
      const first = await store.append(base);
      const revised = await store.appendRevision({
        ...base, thread_id: "new-thread", actor_id: "new-actor",
        content_hash: HASH_B, occurred_at: "2026-08-31T00:00:00.000Z",
        parent_event_id: first.id, expected_head_id: first.id,
      });
      const deleted = await store.markTombstone({
        org_id: orgId, source: base.source, external_id: base.external_id,
        thread_id: "new-thread", actor_id: "new-actor", required_scope_ids: ["hidden"],
        occurred_at: "2026-09-01T00:00:00.000Z", expected_head_id: revised.id,
      });
      await store.append({ ...base, org_id: `${orgId}-other`, external_id: "other-org" });
      const query = {
        filters: {
          sources: ["synthetic"], thread_ids: ["old-thread"], actor_ids: ["old-actor"],
          occurred_after: "2026-08-29T20:00:00-04:00",
          occurred_before: "2026-08-30T08:00:00+08:00",
        },
        anchors: [{ kind: "entity", id: "entity-1" }],
      };
      const read = await store.openContextRead(orgId, query);
      assert.deepEqual(read.events.map((event) => event.id), [first.id, revised.id, deleted.id]);
      assert.deepEqual(read.lifecycle_heads, [{
        source: base.source, external_id: base.external_id, head_event_id: deleted.id,
      }]);
      for (const anchors of [
        [{ kind: "event", id: first.id }],
        [{ kind: "conversation", id: "old-thread" }],
        [{ kind: "event", id: "missing" }, { kind: "entity", id: "entity-1" }],
      ]) {
        assert.equal((await store.openContextRead(orgId, { anchors })).events.length, 3);
      }
      assert.equal((await store.openContextReadForThread(orgId, "old-thread")).events.length, 3);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.append({ ...base, external_id: "unrelated", thread_id: "unrelated", actor_id: "other" });
      assert.equal((await store.openContextRead(orgId, query)).read_epoch, read.read_epoch);
      for (const filters of [{ sources: [] }, { actor_ids: [] }, { thread_ids: [] }, { sources: ["absent"] }]) {
        const empty = await store.openContextRead(orgId, { filters });
        assert.deepEqual(empty.events, []);
        assert.deepEqual(empty.lifecycle_heads, []);
      }
      await store.append({ ...base, external_id: "numeric-anchor", attrs: { entity_id: 42 } });
      assert.deepEqual((await store.openContextRead(orgId, {
        anchors: [{ kind: "entity", id: "42" }],
      })).events, []);
    });

    it("opens a repeatable context read and stores an immutable snapshot", async () => {
      const { store, orgId } = await openBoundStore();
      const event = await store.append({
        org_id: orgId,
        source: "synthetic",
        external_id: `read-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-30T00:00:00.000Z",
        expected_head_id: null,
      });
      const read = await store.openContextRead(orgId);
      assert.equal(read.events.some((item) => item.id === event.id), true);
      assert.ok(read.read_epoch.startsWith("authority:"));
      const snapshot = snapshotFor(orgId);
      await store.putSnapshot(snapshot);
      assert.deepEqual(await store.getSnapshot(orgId, snapshot.id), snapshot);
    });

    it("prunes extra ingest attempts per installation", async () => {
      const { store, orgId } = await openBoundStore();
      const installationId = `install-${randomUUID()}`;
      await store.createInstallation({
        id: installationId,
        org_id: orgId,
        connector_type: "fake-poll",
        status: "enabled",
        config: {},
        created_at: "2026-08-12T00:00:00.000Z",
      });
      for (let index = 0; index < KEEP + 6; index += 1) {
        const started = new Date(Date.parse("2026-08-12T00:00:00.000Z") + index * 1000)
          .toISOString();
        await store.beginAttempt({
          id: `${installationId}-attempt-${index}`,
          org_id: orgId,
          connector_installation_id: installationId,
          stream_key: "personal",
          delivery_id: `page-${index}`,
          started_at: started,
        });
      }
      const pruned = await store.maintainStore();
      assert.ok(pruned.deleted >= 6);
      const remaining = await store.listAttempts(installationId, KEEP + 10);
      assert.equal(remaining.length, KEEP);
    });
  });
}

const describePg = process.env.TEST_DATABASE_URL?.trim() ? describe : describe.skip;

describePg("postgres concurrent claim", () => {
  it("does not let two claimers take the same projection job", async () => {
    const postgres = await isolatedPostgresUrl(
      process.env.TEST_DATABASE_URL.trim(),
    );
    const connectionString = postgres.connectionString;
    const hostA = await createHost();
    const hostB = await createHost();
    const hostWriter = await createHost();
    try {
      await (await hostWriter.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      await (await hostA.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      await (await hostB.plugin(postgresAuthorityPlugin, { connectionString })).ready();
      const writer = hostWriter.get("authority");
      const orgId = `org-${randomUUID()}`;
      await writer.append({
        org_id: orgId,
        source: "regenic",
        external_id: `job-${randomUUID()}`,
        content_hash: HASH_A,
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-24T00:00:00.000Z",
        expected_head_id: null,
      });
      const now = new Date().toISOString();
      const [first, second] = await Promise.all([
        hostA.get("authority").claimContextProjectionJobs({
          owner: "worker-a",
          now,
          lease_ms: 60_000,
          limit: 100,
        }),
        hostB.get("authority").claimContextProjectionJobs({
          owner: "worker-b",
          now,
          lease_ms: 60_000,
          limit: 100,
        }),
      ]);
      const ids = [...first, ...second]
        .filter((job) => job.org_id === orgId)
        .map((job) => job.id);
      assert.equal(ids.length, 1);
      assert.equal(new Set(ids).size, 1);
    } finally {
      try {
        await Promise.all([hostA.dispose(), hostB.dispose(), hostWriter.dispose()]);
      } finally {
        await postgres.cleanup();
      }
    }
  });
});
