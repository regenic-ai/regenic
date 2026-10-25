const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
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
  return url.toString();
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
      return {
        plugin: postgresAuthorityPlugin,
        config: {
          connectionString: await isolatedPostgresUrl(
            process.env.TEST_DATABASE_URL.trim(),
          ),
        },
        blobRoot: join(root, "blobs"),
        async teardown() {
          await rm(root, { recursive: true, force: true });
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
        await store.putDisposition({
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
      await store.putConversationPref({
        org_id: orgId, thread_id: input.thread_id, hidden: true, hidden_reason: "human",
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
        await store.putWorkItem({
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
      await store.putWorkRun({ ...saved, start_state: "submitted", external_run_id: "remote-1" });
      assert.equal((await store.getWorkRun(orgId, saved.id)).start_state, "submitted");
      await store.putWorkRun({ ...saved, start_state: undefined });
      assert.equal((await store.getWorkRun(orgId, saved.id)).start_state, undefined);
      assert.equal((await store.listWorkRuns(orgId)).length, 2);
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
    const connectionString = await isolatedPostgresUrl(
      process.env.TEST_DATABASE_URL.trim(),
    );
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
      await Promise.all([hostA.dispose(), hostB.dispose(), hostWriter.dispose()]);
    }
  });
});
