const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { after, describe, it } = require("node:test");
const {
  AuthorityConflictError,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  hashStandardVersionBody,
} = require("@regenic/domain");
const { FsBlobStore } = require("@regenic/blob-store");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHost } = require("@regenic/plugin-host");
const { Client } = require("pg");
const {
  PostgresAuthorityStore,
  postgresAuthorityPlugin,
} = require("../dist/postgres");

const baseConnectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = baseConnectionString ? describe : describe.skip;

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

describePg("postgres authority store", () => {
  const stores = [];
  const roots = [];
  let connectionStringPromise;

  function isolatedUrl() {
    connectionStringPromise ??= isolatedPostgresUrl(baseConnectionString);
    return connectionStringPromise;
  }

  after(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  async function openStore() {
    const store = await PostgresAuthorityStore.open(await isolatedUrl());
    stores.push(store);
    return store;
  }

  async function ingestHarness() {
    const root = await mkdtemp(join(tmpdir(), "regenic-pg-blobs-"));
    roots.push(root);
    const authority = await openStore();
    const blobs = new FsBlobStore(join(root, "blobs"));
    return {
      authority,
      blobs,
      service: new IngestionService(blobs, authority),
      orgId: `org-${randomUUID()}`,
    };
  }

  function createBatch(orgId, externalId = "source-event-1") {
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
            { role: "body", media_type: "text/plain", text: "Postgres body." },
          ],
        },
      ],
    };
  }

  it("migrates, ingests, and lists inbox", async () => {
    const { authority, service, orgId } = await ingestHarness();
    const result = await service.ingest(createBatch(orgId));
    assert.equal(result.valid, true);
    assert.equal(
      result.records.filter((record) => record.status === "accepted").length,
      1,
    );
    const inbox = await authority.listInbox(orgId);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.org_id, orgId);
    const blobs = await authority.findBlobs([inbox[0].event.content_hash]);
    assert.equal(blobs.size, 1);
    await authority.ping();
  });

  it("rolls back a conflicting ingest page", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const first = await store.append({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-1",
      content_hash: "a".repeat(64),
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
              content_hash: "b".repeat(64),
              content_media_type: "text/plain",
              content_byte_size: 1,
              occurred_at: "2026-08-24T00:00:01.000Z",
              expected_head_id: null,
            },
            {
              org_id: orgId,
              source: "regenic",
              external_id: "conflict-1",
              content_hash: "c".repeat(64),
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
    assert.equal(await store.findBySourceIdentity({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-2",
    }), null);
    const head = await store.findBySourceIdentity({
      org_id: orgId,
      source: "regenic",
      external_id: "conflict-1",
    });
    assert.equal(head.id, first.id);
  });

  it("does not let two claimers take the same projection job", async () => {
    const writer = await openStore();
    const orgId = `org-${randomUUID()}`;
    await writer.append({
      org_id: orgId,
      source: "regenic",
      external_id: `job-${randomUUID()}`,
      content_hash: "d".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    });
    const now = new Date().toISOString();
    const claimerA = await openStore();
    const claimerB = await openStore();
    const [first, second] = await Promise.all([
      claimerA.claimContextProjectionJobs({
        owner: "worker-a",
        now,
        lease_ms: 60_000,
        limit: 100,
      }),
      claimerB.claimContextProjectionJobs({
        owner: "worker-b",
        now,
        lease_ms: 60_000,
        limit: 100,
      }),
    ]);
    const ids = [...first, ...second].filter((job) => job.org_id === orgId).map((job) => job.id);
    assert.equal(ids.length, 1);
    assert.equal(new Set(ids).size, 1);
  });

  it("persists idempotent Handoffs and transitions them under row lock", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const handoff = {
      schema_version: "1.0", id: `handoff-${randomUUID()}`, org_id: orgId,
      direction: "human_to_agent",
      from: { actor_type: "human", actor_id: "person-1" },
      to: { actor_type: "agent", actor_id: "agent-1" },
      reason: "set_boundary", context_snapshot_id: "snapshot-1",
      standard_bindings: [], payload: { boundary: "Release only" },
      status: "open", created_at: "2026-09-17T00:00:00.000Z",
    };
    const [first, repeated] = await Promise.all([
      writerA.putHandoff(handoff),
      writerB.putHandoff({ ...handoff, created_at: "2026-09-17T00:00:01.000Z" }),
    ]);
    assert.equal(first.id, repeated.id);
    assert.equal(first.created_at, repeated.created_at);
    await assert.rejects(
      writerB.putHandoff({ ...handoff, payload: { boundary: "Changed" } }),
      /Cannot replace immutable Handoff/,
    );
    assert.equal((await writerA.transitionHandoff({
      org_id: orgId, handoff_id: handoff.id, status: "acked",
      transitioned_at: "2026-09-17T01:00:00.000Z",
    })).status, "acked");
    const resolved = await writerB.transitionHandoff({
      org_id: orgId, handoff_id: handoff.id, status: "resolved",
      transitioned_at: "2026-09-17T02:00:00.000Z",
    });
    assert.equal(resolved.resolved_at, "2026-09-17T02:00:00.000Z");
    assert.equal((await writerA.listHandoffs({
      org_id: orgId, status: "resolved", direction: "human_to_agent",
    })).length, 1);
  });

  it("atomically commits and promotes a Standard Proposal", async () => {
    const store = await openStore();
    const orgId = `org-${randomUUID()}`;
    const proposal = {
      schema_version: "1.0", id: `proposal-${randomUUID()}`, org_id: orgId,
      kind: "new_standard", title: "Create release safety standard",
      summary: "Create a bounded release safety standard.", status: "draft",
      author: { actor_type: "human", actor_id: "person-1" }, rights_level: "coach",
      boundary: "Release governance only", context_snapshot_id: "snapshot-1",
      standard_bindings: [], single_uncertainty: "Can this prevent regressions?",
      evidence: [{ kind: "document", uri_or_ref: "event:event-1" }],
      created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z",
    };
    const standard = {
      schema_version: "1.0", id: `standard-${randomUUID()}`, org_id: orgId,
      slug: `release-safety-${randomUUID()}`, title: "Release safety", layer: "adjacent",
      scope: { org_id: orgId, team_ids: [], roles: [], decision_kinds: ["release"] },
      created_at: "2026-09-18T03:00:00.000Z", created_by: proposal.author,
      citation_count: 0,
    };
    const body = {
      condition: "A release changes production behavior.",
      action: "Run the bounded release check.",
      acceptance: "No severe regression escapes.",
      boundary: "Escalate when rollback is unavailable.",
      revision_trigger: "A severe regression escapes.",
    };
    const version = {
      schema_version: "1.0", id: `standard-version-${randomUUID()}`, org_id: orgId,
      standard_id: standard.id, proposal_id: proposal.id, version: "1.0.0", status: "draft",
      ...body,
      gate: {
        single_uncertainty: proposal.single_uncertainty, target_user_tier: "early_adopter",
        consensus_hypothesis: "Teams need a bounded release check.",
        value_metric: "Escaped regressions", cost_budget: "Two engineer-days",
        validation_window: "14 days", stop_condition: "Stop after one severe regression.",
        stable_core_preserved: true, compat_and_rollback: "Keep the previous path.",
        learning_output: "new_standard",
      },
      body_hash: hashStandardVersionBody(body), created_at: "2026-09-18T03:00:00.000Z",
    };
    await store.putProposal(proposal);
    await store.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "submitted", updated_at: "2026-09-18T01:00:00.000Z" });
    await store.transitionProposal({ org_id: orgId, proposal_id: proposal.id, status: "in_review", updated_at: "2026-09-18T02:00:00.000Z" });
    const committed = await store.commitProposalStandardVersion({ org_id: orgId, proposal_id: proposal.id, standard, version });
    assert.equal(committed.proposal.status, "accepted");
    assert.deepEqual(committed.proposal.outcome_ref, { outcome_kind: "standard_version", ref_id: version.id });
    const active = await store.transitionStandardVersion({
      org_id: orgId, version_id: version.id, status: "active", actor: proposal.author,
      transitioned_at: "2026-09-19T00:00:00.000Z",
      upgrade_evidence: {
        core_value_revalidated: true, delivery_standardized: true,
        unit_economics_or_roi_ok: true, next_tier_behavioral_evidence: true,
        rollback_safe: true,
      },
    });
    assert.equal(active.status, "active");
    assert.equal((await store.getStandard(orgId, standard.id)).current_version_id, version.id);
    assert.equal((await store.listStandardVersions({ org_id: orgId, standard_id: standard.id })).length, 1);
  });

  it("converges concurrent StandardGap intake and Proposal conversion", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const baseGap = {
      schema_version: "1.0", org_id: orgId,
      summary: "Release safety is not covered.", source_kind: "manual", source_ref: "manual-gap-1",
      proposed_uncertainty: "Can a release gate prevent regressions?", status: "open",
      created_by: { actor_type: "human", actor_id: "person-1" },
    };
    const [gapA, gapB] = await Promise.all([
      writerA.putStandardGap({
        ...baseGap, id: `gap-${randomUUID()}`,
        created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
      }),
      writerB.putStandardGap({
        ...baseGap, id: `gap-${randomUUID()}`,
        created_at: "2026-09-20T00:00:01.000Z", updated_at: "2026-09-20T00:00:01.000Z",
      }),
    ]);
    assert.equal(gapA.id, gapB.id);
    const proposal = {
      schema_version: "1.0", id: `proposal-${randomUUID()}`, org_id: orgId,
      kind: "new_standard", title: "Create release safety standard",
      summary: "Create a bounded release safety standard.", status: "draft",
      author: baseGap.created_by, rights_level: "coach", boundary: "Release governance only",
      context_snapshot_id: "snapshot-1", standard_bindings: [],
      single_uncertainty: baseGap.proposed_uncertainty,
      evidence: [{ kind: "document", uri_or_ref: `standard-gap:${gapA.id}` }], gap_id: gapA.id,
      created_at: "2026-09-20T01:00:00.000Z", updated_at: "2026-09-20T01:00:00.000Z",
    };
    const [convertedA, convertedB] = await Promise.all([
      writerA.convertStandardGap({ org_id: orgId, gap_id: gapA.id, proposal }),
      writerB.convertStandardGap({
        org_id: orgId, gap_id: gapA.id,
        proposal: { ...proposal, created_at: "2026-09-20T01:00:01.000Z", updated_at: "2026-09-20T01:00:01.000Z" },
      }),
    ]);
    assert.equal(convertedA.gap.converted_proposal_id, proposal.id);
    assert.equal(convertedB.proposal.id, proposal.id);
    assert.equal((await writerA.listStandardGaps({ org_id: orgId, status: "converted" })).length, 1);
  });

  it("serializes AgentRun transitions and commits Handoff atomically", async () => {
    const writerA = await openStore();
    const writerB = await openStore();
    const orgId = `org-${randomUUID()}`;
    const run = {
      schema_version: "1.0", id: `run-${randomUUID()}`, org_id: orgId,
      agent: { actor_type: "agent", actor_id: "agent-1" },
      on_behalf_of: { actor_type: "human", actor_id: "person-1" },
      intent: "Apply the release standard.", status: "queued",
      context_snapshot_id: "snapshot-1",
      standard_bindings: [{ standard_id: "standard-1", version_id: "version-1" }],
      input: { release_id: "release-1" }, created_at: "2026-09-21T00:00:00.000Z",
    };
    await writerA.putAgentRun(run);
    const [startedA, startedB] = await Promise.all([
      writerA.startAgentRun({ org_id: orgId, run_id: run.id, started_at: "2026-09-21T01:00:00.000Z" }),
      writerB.startAgentRun({ org_id: orgId, run_id: run.id, started_at: "2026-09-21T01:01:00.000Z" }),
    ]);
    assert.equal(startedA.status, "running");
    assert.equal(startedB.started_at, startedA.started_at);
    const output = {
      summary: "The release check passed.", artifacts: [],
      applied_standard_version_ids: ["version-1"], context_snapshot_id: "snapshot-1",
      acceptance_check: "pass", exceptions: [],
    };
    assert.equal((await writerA.settleAgentRun({
      org_id: orgId, run_id: run.id, status: "succeeded", output,
      finished_at: "2026-09-21T02:00:00.000Z",
    })).status, "succeeded");
    assert.equal((await writerB.settleAgentRun({
      org_id: orgId, run_id: run.id, status: "succeeded", output,
      finished_at: "2026-09-21T02:01:00.000Z",
    })).finished_at, "2026-09-21T02:00:00.000Z");

    const handoffRun = { ...run, id: `run-${randomUUID()}`, input: { release_id: "release-2" } };
    await writerA.putAgentRun(handoffRun);
    await writerA.startAgentRun({ org_id: orgId, run_id: handoffRun.id, started_at: "2026-09-21T01:00:00.000Z" });
    const handoff = {
      schema_version: "1.0", id: `handoff-${randomUUID()}`, org_id: orgId,
      direction: "agent_to_human", from: handoffRun.agent,
      to: { actor_type: "human", actor_id: "person-1" }, reason: "evidence_conflict",
      agent_run_id: handoffRun.id, context_snapshot_id: handoffRun.context_snapshot_id,
      standard_bindings: handoffRun.standard_bindings,
      payload: { summary: "Two claims disagree." }, status: "open",
      created_at: "2026-09-21T02:00:00.000Z",
    };
    const handedOff = await writerB.handoffAgentRun({
      org_id: orgId, run_id: handoffRun.id, handoff, handed_off_at: handoff.created_at,
    });
    assert.equal(handedOff.run.status, "handed_off");
    assert.equal((await writerA.getHandoff(orgId, handoff.id)).agent_run_id, handoffRun.id);
  });

  it("serves the store through the postgres plugin", async () => {
    const host = await createHost();
    try {
      const handle = await host.plugin(postgresAuthorityPlugin, {
        connectionString: await isolatedUrl(),
      });
      await handle.ready();
      const store = host.get("authority");
      const orgId = `org-${randomUUID()}`;
      const event = await store.append({
        org_id: orgId,
        source: "regenic",
        external_id: "plugin-1",
        content_hash: "e".repeat(64),
        content_media_type: "text/plain",
        content_byte_size: 1,
        occurred_at: "2026-08-24T00:00:00.000Z",
        expected_head_id: null,
      });
      assert.equal((await store.getEvent(orgId, event.id))?.id, event.id);
    } finally {
      await host.dispose();
    }
  });

  it("upgrades v23 outbox indexes to partial claim indexes", async () => {
    const connectionString = await isolatedPostgresUrl(baseConnectionString);
    const setup = new Client({ connectionString });
    await setup.connect();
    try {
      await setup.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO schema_migrations (version, applied_at) VALUES (23, now());
        CREATE TABLE context_projection_outbox (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          next_retry_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX context_projection_outbox_due_idx
          ON context_projection_outbox (status, next_retry_at, lease_expires_at, created_at);
      `);
    } finally {
      await setup.end();
    }

    const store = await PostgresAuthorityStore.open(connectionString);
    stores.push(store);

    const check = new Client({ connectionString });
    await check.connect();
    try {
      const versions = await check.query(
        `SELECT version FROM schema_migrations ORDER BY version`,
      );
      assert.deepEqual(
        versions.rows.map((row) => Number(row.version)),
        [23, 24],
      );
      const indexes = await check.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'context_projection_outbox'
         ORDER BY indexname`,
      );
      const names = indexes.rows.map((row) => row.indexname);
      assert.equal(names.includes("context_projection_outbox_due_idx"), false);
      assert.equal(names.includes("context_projection_outbox_pending_idx"), true);
      assert.equal(names.includes("context_projection_outbox_failed_due_idx"), true);
      assert.equal(
        names.includes("context_projection_outbox_running_expired_idx"),
        true,
      );
    } finally {
      await check.end();
    }
  });
});
