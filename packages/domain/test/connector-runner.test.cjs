const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  InProcessConnectorInvoker,
  InstallationQuotaBook,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  SyncMetricsRegistry,
} = require("../dist");

function batch(records) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "fake-poll",
    org_id: "local-owner",
    delivery_id: "page-1",
    received_at: "2026-08-12T00:00:00.000Z",
    records: records ?? [
      {
        operation: "create",
        source: "fake",
        external_id: "message-1",
        occurred_at: "2026-08-12T00:00:00.000Z",
        actor: { id: "user" },
        scope: { id: "personal" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "hi" }],
      },
    ],
  };
}

function validResult(records) {
  return {
    valid: true,
    connector_id: "fake-poll",
    delivery_id: "page-1",
    records,
  };
}

async function createRuntime() {
  const runtime = new MemoryConnectorRuntimeStore();
  await runtime.createInstallation({
    id: "installation-1",
    org_id: "local-owner",
    connector_type: "fake-poll",
    status: "enabled",
    config: {},
    created_at: "2026-08-12T00:00:00.000Z",
  });
  return runtime;
}

function createRunner(runtime, records) {
  const seenCursors = [];
  const connector = {
    async poll(cursor) {
      seenCursors.push(cursor?.value ?? null);
      return { batch: batch(), next_cursor: "cursor-2" };
    },
  };
  const processor = { async ingest() { return validResult(records); } };
  const runner = new ConnectorRunner(
    new InProcessConnectorInvoker(connector),
    processor,
    runtime,
    () => "2026-08-12T00:00:00.000Z",
  );
  return { runner, seenCursors };
}

const input = {
  installation_id: "installation-1",
  stream_key: "personal",
  lease_owner: "worker-a",
  lease_duration_ms: 30_000,
};

function runtimePage(now, claim_token) {
  return {
    attempt: { id: "attempt", org_id: "local-owner", connector_installation_id: "installation-1",
      stream_key: "personal", delivery_id: "page", started_at: now },
    settle: { attempt_id: "attempt", installation_id: "installation-1", stream_key: "personal",
      lease_owner: "worker-a", claim_token, finished_at: now, accepted_count: 1, duplicate_count: 0,
      quarantined_count: 1, retryable_failure_count: 0, next_cursor: "next",
      quarantines: [{ id: "quarantine", record_external_id: "bad", reason_code: "invalid_record",
        safe_metadata: {}, created_at: now }] },
  };
}

describe("MemoryConnectorRuntimeStore settlement", () => {
  it("renews only a matching unexpired lease claim", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now, lease_duration_ms: 10_000 });
    const renewed = await runtime.renewLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: lease.lease_owner,
      claim_token: lease.claim_token,
      now: "2026-08-12T00:00:01.000Z",
      lease_duration_ms: 10_000,
    });

    assert.ok(renewed);
    assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(lease.lease_expires_at));
    assert.equal(await runtime.renewLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: lease.lease_owner,
      claim_token: "stale-token",
      now: "2026-08-12T00:00:02.000Z",
      lease_duration_ms: 10_000,
    }), null);
    assert.equal(await runtime.renewLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: lease.lease_owner,
      claim_token: lease.claim_token,
      now: renewed.lease_expires_at,
      lease_duration_ms: 10_000,
    }), null);
  });

  it("rejects attempts for an unknown installation or another organization", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    await assert.rejects(runtime.createInstallation({ id: "installation-1", org_id: "other-org",
      connector_type: "fake-poll", status: "enabled", config: {}, created_at: now }), /already exists/);
    for (const attempt of [
      { ...page.attempt, org_id: "other-org" },
      { ...page.attempt, connector_installation_id: "missing" },
    ]) {
      await assert.rejects(runtime.beginAttempt(attempt), /installation.*organization/i);
    }
    await assert.rejects(runtime.commitSyncPage({ ...page,
      attempt: { ...page.attempt, org_id: "other-org" } }), /installation.*organization/i);
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.equal((await runtime.commitSyncPage(page)).attempt.status, "succeeded");
  });

  it("does not settle an existing attempt whose organization disagrees with its installation", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    const attempt = await runtime.beginAttempt(page.attempt);
    runtime.attempts.set(attempt.id, { ...attempt, org_id: "other-org" });
    await assert.rejects(runtime.settleAttempt(page.settle), /installation.*organization/i);
    assert.equal((await runtime.latestAttempt("installation-1")).status, "running");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.deepEqual(await runtime.listQuarantines("installation-1"), []);
  });

  it("does not silently discard authority data sent to the standalone runtime", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    for (const payload of [
      { ingest: { appends: [], dispositions: [] } },
      { prefs: [{ org_id: "local-owner", thread_id: "thread", hidden: true,
        expected_visibility_version: 0, updated_at: now }] },
      { disposition_repairs: [{
          identities: [{ org_id: "local-owner", source: "fake", external_id: "event" }],
          decision: { event_id: "event", org_id: "local-owner", disposition: "current_work",
            layer: "L1_event", reason_codes: [], score: 1, decided_at: now },
        }] },
    ]) {
      await assert.rejects(runtime.commitSyncPage({ ...page, ...payload }), /cannot commit authority data/i);
      assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    }
    assert.equal((await runtime.commitSyncPage(page)).attempt.status, "succeeded");
  });

  it("rejects mismatched page identities without creating an attempt or consuming a lease", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    for (const change of [
      { attempt_id: "other" },
      { installation_id: "other" },
      { stream_key: "other" },
    ]) {
      const page = runtimePage(now, lease.claim_token);
      Object.assign(page.settle, change);
      await assert.rejects(runtime.commitSyncPage(page), /Sync page attempt identity/);
      assert.deepEqual(await runtime.listAttempts("installation-1"), []);
      assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    }
    assert.equal((await runtime.commitSyncPage(runtimePage(now, lease.claim_token))).attempt.status, "succeeded");
  });

  it("rejects duplicate attempts and settlement for a different stream or installation", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    await runtime.acquireLease({ ...input, stream_key: "other", now });
    await runtime.acquireLease({ ...input, installation_id: "other", now });
    const running = await runtime.beginAttempt(page.attempt);
    await assert.rejects(runtime.beginAttempt({ ...page.attempt, delivery_id: "different" }), /already exists/);
    for (const change of [{ stream_key: "other" }, { installation_id: "other" }]) {
      await assert.rejects(runtime.settleAttempt({ ...page.settle, ...change }), /attempt.*installation.*stream/i);
      assert.deepEqual(await runtime.latestAttempt("installation-1"), running);
    }
    await runtime.settleAttempt(page.settle);
    await runtime.acquireLease({ ...input, now });
    await assert.rejects(runtime.settleAttempt(page.settle), /attempt.*running/i);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "next");
  });

  it("leaves no attempt when a sync-page lease is not held", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, lease_owner: "other-worker", now });
    await assert.rejects(runtime.commitSyncPage(runtimePage(now, lease.claim_token)), /lease is not held/);
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.deepEqual(await runtime.listQuarantines("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.equal(await runtime.acquireLease({ ...input, now }), null);
  });

  it("preserves an existing attempt and lease when preparing a page fails", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    const previous = await runtime.beginAttempt({ ...page.attempt, id: "previous", delivery_id: "existing" });
    page.settle.quarantines.push(null);
    await assert.rejects(runtime.commitSyncPage(page), TypeError);
    assert.deepEqual(await runtime.latestAttempt("installation-1"), previous);
    assert.deepEqual(await runtime.listQuarantines("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.equal(await runtime.acquireLease({ ...input, lease_owner: "other-worker", now }), null);
  });

  it("rolls back a partially written settlement and permits retry", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    page.settle.quarantines.push({ ...page.settle.quarantines[0], id: "quarantine-2" });
    const push = runtime.quarantines.push;
    let writes = 0;
    runtime.quarantines.push = function (row) {
      if (++writes === 2) throw new Error("quarantine write failed");
      return push.call(this, row);
    };
    try {
      await assert.rejects(runtime.commitSyncPage(page), /quarantine write failed/);
    } finally {
      runtime.quarantines.push = push;
    }
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.deepEqual(await runtime.listQuarantines("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.equal(await runtime.acquireLease({ ...input, lease_owner: "other-worker", now }), null);
    assert.equal((await runtime.commitSyncPage(page)).attempt.status, "succeeded");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "next");
    assert.equal((await runtime.listQuarantines("installation-1")).length, 2);
  });

  it("restores a running attempt when standalone settlement fails after updating its cursor", async () => {
    const runtime = await createRuntime();
    const now = "2026-08-12T00:00:00.000Z";
    const lease = await runtime.acquireLease({ ...input, now });
    const page = runtimePage(now, lease.claim_token);
    const running = await runtime.beginAttempt(page.attempt);
    const set = runtime.cursors.set;
    let fail = true;
    runtime.cursors.set = function (key, value) {
      set.call(this, key, value);
      if (fail) {
        fail = false;
        throw new Error("cursor write failed");
      }
      return this;
    };
    try {
      await assert.rejects(runtime.settleAttempt(page.settle), /cursor write failed/);
    } finally {
      runtime.cursors.set = set;
    }
    assert.deepEqual(await runtime.latestAttempt("installation-1"), running);
    assert.deepEqual(await runtime.listQuarantines("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.equal(await runtime.acquireLease({ ...input, lease_owner: "other-worker", now }), null);
    assert.equal((await runtime.settleAttempt(page.settle)).status, "succeeded");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "next");
  });
});

describe("ConnectorRunner", () => {
  it("does not partially ingest a page into a separate memory Authority store", async () => {
    const runtime = await createRuntime();
    const authority = new MemoryAuthorityStore();
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "next" }; },
    }, new IngestionService(new MemoryBlobStore(), authority), runtime,
    () => "2026-08-12T00:00:00.000Z");
    await assert.rejects(runner.poll(input), /same atomic Authority and runtime store/);
    assert.equal(authority.allEvents().length, 0);
    const attempts = await runtime.listAttempts("installation-1");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "failed");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
  });

  for (const records of [[], undefined]) {
    it(`rejects a ${records ? "empty" : "nonempty"} page from another organization before ingestion`, async () => {
      const runtime = await createRuntime();
      let ingestCalls = 0;
      const runner = new ConnectorRunner({
        async poll() { return { batch: { ...batch(records), org_id: "other-org" }, next_cursor: "next" }; },
      }, {
        async ingest() { ingestCalls += 1; return validResult([]); },
      }, runtime, () => "2026-08-12T00:00:00.000Z");
      await assert.rejects(runner.poll(input), /installation.*organization/i);
      assert.equal(ingestCalls, 0);
      assert.deepEqual(await runtime.listAttempts("installation-1"), []);
      assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
      assert.notEqual(await runtime.acquireLease({ ...input, lease_owner: "next-worker", now: "2026-08-12T00:00:00.000Z" }), null);
    });
  }

  it("releases the lease and propagates an installation lookup failure", async () => {
    const runtime = await createRuntime();
    const failure = new Error("installation lookup failed");
    runtime.findInstallation = async () => { throw failure; };
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "next" }; },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime,
    () => "2026-08-12T00:00:00.000Z");
    await assert.rejects(runner.poll(input), (error) => error === failure);
    assert.notEqual(await runtime.acquireLease({ ...input, lease_owner: "next-worker", now: "2026-08-12T00:00:00.000Z" }), null);
  });

  it("returns lease unavailable when renewal fails during installation lookup", async () => {
    const runtime = await createRuntime();
    let beginLookup;
    let failRenewal;
    let finishLookup;
    const lookupStarted = new Promise((resolve) => { beginLookup = resolve; });
    const renewalFailed = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("lease renewal was not attempted")),
        1000,
      );
      failRenewal = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    const lookupGate = new Promise((resolve) => { finishLookup = resolve; });
    runtime.renewLease = async () => {
      failRenewal();
      return null;
    };
    runtime.findInstallation = async () => {
      beginLookup();
      await lookupGate;
      throw new Error("installation lookup failed");
    };
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "next" }; },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime);

    const resultPromise = runner.poll({ ...input, lease_duration_ms: 90 });
    await lookupStarted;
    await renewalFailed;
    finishLookup();
    const result = await resultPromise;

    assert.equal(result.status, "lease_unavailable");
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
  });

  it("does not ingest a page if its installation was removed during polling", async () => {
    const runtime = await createRuntime();
    const runner = new ConnectorRunner({
      async poll() {
        await runtime.deleteInstallation("installation-1", "local-owner");
        return { batch: batch(), next_cursor: "next" };
      },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime,
    () => "2026-08-12T00:00:00.000Z");
    await assert.rejects(runner.poll(input), /installation.*organization/i);
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal(await runtime.getCursor("installation-1", "personal"), null);
  });

  it("does not start ingest if the lease expires during installation lookup", async () => {
    const runtime = await createRuntime();
    let now = "2026-08-12T00:00:00.000Z";
    const findInstallation = runtime.findInstallation.bind(runtime);
    runtime.findInstallation = async (id) => {
      const installation = await findInstallation(id);
      now = "2026-08-12T00:00:30.000Z";
      return installation;
    };
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "next" }; },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime, () => now);
    assert.equal((await runner.poll(input)).status, "lease_unavailable");
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.notEqual(await runtime.acquireLease({ ...input, lease_owner: "next-worker", now }), null);
  });

  for (const records of [[], [{ external_id: "message-1", status: "accepted", event_id: "event-1" }]]) {
    it(`does not ${records.length ? "ingest" : "settle"} a page whose poll already outlived its lease`, async () => {
      const runtime = await createRuntime();
      let now = "2026-08-12T00:00:00.000Z";
      let ingestCalls = 0;
      const runner = new ConnectorRunner({
        async poll() {
          now = "2026-08-12T00:00:30.000Z";
          return { batch: batch(records.length ? undefined : []), next_cursor: "expired" };
        },
      }, { async ingest() { ingestCalls += 1; return validResult(records); } }, runtime, () => now);
      assert.equal((await runner.poll(input)).status, "lease_unavailable");
      assert.equal(ingestCalls, 0);
      assert.deepEqual(await runtime.listAttempts("installation-1"), []);
      assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
      assert.notEqual(await runtime.acquireLease({ ...input, lease_owner: "next-worker", now }), null);
    });
  }

  it("renews a live lease while a long connector poll is in progress", async () => {
    const runtime = await createRuntime();
    const runner = new ConnectorRunner({
      async poll(_cursor, options) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 180);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("poll aborted"));
          }, { once: true });
        });
        return { batch: batch([]), next_cursor: "renewed" };
      },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime);

    const result = await runner.poll({ ...input, lease_duration_ms: 90 });

    assert.equal(result.status, "completed");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "renewed");
  });

  it("aborts polling and refuses to ingest when lease renewal fails", async () => {
    const runtime = await createRuntime();
    runtime.renewLease = async () => null;
    let aborted = false;
    let ingestCalls = 0;
    const runner = new ConnectorRunner({
      poll(_cursor, options) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({
            batch: batch([]), next_cursor: "stale",
          }), 500);
          options.signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            resolve({ batch: batch([]), next_cursor: "stale" });
          }, { once: true });
        });
      },
    }, { async ingest() { ingestCalls += 1; return validResult([]); } }, runtime);

    const result = await runner.poll({ ...input, lease_duration_ms: 90 });

    assert.equal(result.status, "lease_unavailable");
    assert.equal(aborted, true);
    assert.equal(ingestCalls, 0);
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
  });

  it("records renewal storage errors separately from lease conflicts", async () => {
    const runtime = await createRuntime();
    runtime.renewLease = async () => { throw new Error("storage unavailable"); };
    const metrics = new SyncMetricsRegistry();
    const runner = new ConnectorRunner({
      poll(_cursor, options) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({
            batch: batch([]), next_cursor: "stale",
          }), 500);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ batch: batch([]), next_cursor: "stale" });
          }, { once: true });
        });
      },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime,
    undefined, undefined, metrics);

    const result = await runner.poll({ ...input, lease_duration_ms: 90 });
    const renewalErrors = metrics.snapshot().filter(
      (metric) => metric.name === "lease_renewal_errors",
    );

    assert.equal(result.status, "lease_unavailable");
    assert.equal(renewalErrors.length, 1);
    assert.equal(renewalErrors[0].labels.status, "storage_error");
  });

  it("does not settle a fallback page when ingest outlives the lease", async () => {
    const runtime = await createRuntime();
    let now = "2026-08-12T00:00:00.000Z";
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "expired" }; },
    }, {
      async ingest() {
        now = "2026-08-12T00:00:30.000Z";
        return validResult([{ external_id: "message-1", status: "accepted", event_id: "event-1" }]);
      },
    }, runtime, () => now);
    assert.equal((await runner.poll(input)).status, "lease_unavailable");
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    assert.notEqual(await runtime.acquireLease({ ...input, lease_owner: "next-worker", now }), null);
  });

  it("returns lease unavailable when ingest fails after the lease expires", async () => {
    const runtime = await createRuntime();
    let now = "2026-08-12T00:00:00.000Z";
    const failure = new Error("ingest failed");
    const runner = new ConnectorRunner({
      async poll() { return { batch: batch(), next_cursor: "expired" }; },
    }, {
      async ingest() {
        now = "2026-08-12T00:00:30.000Z";
        throw failure;
      },
    }, runtime, () => now);
    assert.equal((await runner.poll(input)).status, "lease_unavailable");
    assert.deepEqual(await runtime.listAttempts("installation-1"), []);
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
  });

  it("still settles a page just before its lease expires", async () => {
    const runtime = await createRuntime();
    let now = "2026-08-12T00:00:00.000Z";
    const runner = new ConnectorRunner({
      async poll() {
        now = "2026-08-12T00:00:29.999Z";
        return { batch: batch([]), next_cursor: "next" };
      },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime, () => now);
    assert.equal((await runner.poll(input)).status, "completed");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "next");
  });

  it("does not start two concurrent polls with the same requested owner", async () => {
    const runtime = await createRuntime();
    const started = Promise.withResolvers();
    const page = Promise.withResolvers();
    let calls = 0;
    const runner = new ConnectorRunner({
      poll() { calls += 1; started.resolve(); return page.promise; },
    }, { async ingest() { throw new Error("unexpected ingest"); } }, runtime,
    () => "2026-08-12T00:00:00.000Z");
    const first = runner.poll(input);
    await started.promise;
    assert.equal((await runner.poll(input)).status, "lease_unavailable");
    assert.equal(calls, 1);
    page.resolve({ batch: batch([]), next_cursor: "cursor" });
    assert.equal((await first).status, "completed");
  });

  for (const firstOutcome of ["settle", "release"]) {
    it(`does not let an old poll ${firstOutcome} a newer lease with the same requested owner`, async () => {
      const runtime = await createRuntime();
      let now = "2026-08-12T00:00:00.000Z";
      const firstStarted = Promise.withResolvers();
      const secondStarted = Promise.withResolvers();
      const firstPage = Promise.withResolvers();
      const secondPage = Promise.withResolvers();
      let calls = 0;
      const connector = {
        poll() {
          calls += 1;
          if (calls === 1) {
            firstStarted.resolve();
            return firstPage.promise;
          }
          secondStarted.resolve();
          return secondPage.promise;
        },
      };
      const runner = new ConnectorRunner(connector, { async ingest() { throw new Error("unexpected ingest"); } },
        runtime, () => now);
      const oldRun = runner.poll(input).then((value) => ({ value }), (error) => ({ error }));
      await firstStarted.promise;
      now = "2026-08-12T00:00:31.000Z";
      const newRun = runner.poll(input);
      await secondStarted.promise;
      if (firstOutcome === "settle") firstPage.resolve({ batch: batch([]), next_cursor: "old-cursor" });
      else firstPage.reject(new Error("old poll failed"));
      const old = await oldRun;
      if (firstOutcome === "settle") assert.equal(old.value.status, "lease_unavailable");
      else assert.match(old.error.message, /old poll failed/);
      assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
      assert.equal(await runtime.acquireLease({ ...input, lease_owner: "third-worker", now }), null);
      secondPage.resolve({ batch: batch([]), next_cursor: "new-cursor" });
      assert.equal((await newRun).status, "completed");
      assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "new-cursor");
    });
  }

  it("passes the poll-specific lease identity into a delayed ingest commit", async () => {
    const runtime = await createRuntime();
    let now = "2026-08-12T00:00:00.000Z";
    const ingestStarted = Promise.withResolvers();
    const continueIngest = Promise.withResolvers();
    const secondStarted = Promise.withResolvers();
    const secondPage = Promise.withResolvers();
    let polls = 0;
    const runner = new ConnectorRunner({
      poll() {
        if (++polls === 1) return Promise.resolve({ batch: batch(), next_cursor: "old" });
        secondStarted.resolve();
        return secondPage.promise;
      },
    }, {
      async ingest(_batch, page) {
        ingestStarted.resolve();
        await continueIngest.promise;
        await runtime.commitSyncPage({ attempt: page.attempt, settle: {
          ...page.settle, accepted_count: 1, duplicate_count: 0, quarantined_count: 0,
          retryable_failure_count: 0, quarantines: [],
        } });
        return { ...validResult([]), page_committed: true };
      },
    }, runtime, () => now);
    const oldRun = runner.poll(input);
    await ingestStarted.promise;
    now = "2026-08-12T00:00:31.000Z";
    const newRun = runner.poll(input);
    await secondStarted.promise;
    continueIngest.resolve();
    assert.equal((await oldRun).status, "lease_unavailable");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, undefined);
    secondPage.resolve({ batch: batch([]), next_cursor: "new" });
    assert.equal((await newRun).status, "completed");
    assert.equal((await runtime.getCursor("installation-1", "personal")).cursor, "new");
  });

  it("settles an accepted page and advances its cursor", async () => {
    const runtime = await createRuntime();
    const { runner, seenCursors } = createRunner(runtime, [
      { external_id: "message-1", status: "accepted", event_id: "event-1" },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "completed");
    assert.deepEqual(seenCursors, [null]);
    assert.equal(cursor.cursor, "cursor-2");
    assert.equal(cursor.cursor_version, 2);
  });

  it("advances past a record only after it is durably quarantined", async () => {
    const runtime = await createRuntime();
    const { runner } = createRunner(runtime, [
      {
        external_id: "bad-message",
        status: "quarantined",
        error_code: "content_unavailable",
      },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "completed");
    assert.equal(cursor.cursor, "cursor-2");
  });

  it("does not advance a cursor after a retryable record failure", async () => {
    const runtime = await createRuntime();
    const { runner } = createRunner(runtime, [
      {
        external_id: "message-1",
        status: "retryable_failure",
        error_code: "concurrent_source_update",
      },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "retryable_failure");
    assert.equal(cursor.cursor, undefined);
    assert.equal(cursor.cursor_version, 1);
  });

  it("rejects a concurrent lease owner before polling", async () => {
    const runtime = await createRuntime();
    await runtime.acquireLease({
      ...input,
      now: "2026-08-12T00:00:00.000Z",
    });
    const { runner, seenCursors } = createRunner(runtime, []);

    const run = await runner.poll({ ...input, lease_owner: "worker-b" });

    assert.equal(run.status, "lease_unavailable");
    assert.deepEqual(seenCursors, []);
  });

  it("settles and releases the lease when the processor throws", async () => {
    const runtime = await createRuntime();
    const connector = {
      async poll() {
        return { batch: batch(), next_cursor: "cursor-2" };
      },
    };
    const processor = {
      async ingest() {
        throw new Error("store unavailable");
      },
    };
    const runner = new ConnectorRunner(
      connector,
      processor,
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    await assert.rejects(() => runner.poll(input), /store unavailable/);
    const nextLease = await runtime.acquireLease({
      ...input,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(nextLease.lease_owner, "worker-b");
    assert.equal(cursor.cursor, undefined);
  });

  it("releases the lease when polling throws before an attempt begins", async () => {
    const runtime = await createRuntime();
    const runner = new ConnectorRunner(
      { async poll() { throw new Error("Slack unavailable"); } },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    await assert.rejects(() => runner.poll(input), /Slack unavailable/);
    const nextLease = await runtime.acquireLease({
      ...input,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });

    assert.equal(nextLease.lease_owner, "worker-b");
  });

  it("releases the lease when polling exceeds the deadline", async () => {
    const runtime = await createRuntime();
    const runner = new ConnectorRunner(
      {
        async poll() {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    await assert.rejects(
      () => runner.poll({ ...input, timeout_ms: 30 }),
      /timed out after 30ms/,
    );
    const nextLease = await runtime.acquireLease({
      ...input,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });

    assert.equal(nextLease.lease_owner, "worker-b");
  });

  it("completes a caught-up poll without calling ingest", async () => {
    const runtime = await createRuntime();
    const ingested = [];
    const runner = new ConnectorRunner(
      {
        async poll() {
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      {
        async ingest(input) {
          ingested.push(input);
          return validResult([]);
        },
      },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    const run = await runner.poll(input);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.result.records, []);
    assert.deepEqual(ingested, []);
  });

  it("does not poll a webhook-only connector", async () => {
    const runtime = await createRuntime();
    let polled = 0;
    const runner = new ConnectorRunner(
      {
        source: "push",
        source_mode: "webhook",
        async poll() {
          polled += 1;
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    const run = await runner.poll(input);
    assert.equal(run.status, "unsupported_mode");
    assert.equal(polled, 0);
    const cursor = await runtime.getCursor("installation-1", "personal");
    assert.equal(cursor?.cursor, undefined);
  });

  it("releases the lease when quota is exhausted after it is acquired", async () => {
    const runtime = await createRuntime();
    let polled = 0;
    const quota = new InstallationQuotaBook({ tokens: 1, window_ms: 60_000 }, () => 1_000);
    quota.tryConsume("installation-1");
    const runner = new ConnectorRunner(
      {
        source: "fake",
        async poll() {
          polled += 1;
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
      quota,
    );
    const run = await runner.poll(input);
    assert.equal(run.status, "throttled");
    assert.equal(polled, 0);
    const nextLease = await runtime.acquireLease({
      ...input,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });
    assert.equal(nextLease.lease_owner, "worker-b");
  });

  it("does not spend quota when another worker already holds the lease", async () => {
    const runtime = await createRuntime();
    const lease = await runtime.acquireLease({
      ...input,
      now: "2026-08-12T00:00:00.000Z",
    });
    let now = 1_000;
    const quota = new InstallationQuotaBook({ tokens: 1, window_ms: 60_000 }, () => now);
    const runner = new ConnectorRunner(
      {
        source: "fake",
        async poll() {
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
      quota,
    );
    const blocked = await runner.poll({ ...input, lease_owner: "worker-b" });
    assert.equal(blocked.status, "lease_unavailable");
    now += 1;
    await runtime.releaseLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: input.lease_owner,
      claim_token: lease.claim_token,
      now: "2026-08-12T00:00:01.000Z",
    });
    const run = await runner.poll({ ...input, lease_owner: "worker-b" });
    assert.equal(run.status, "completed");
  });

  it("honors declared max_concurrency and forwards page_size", async () => {
    const runtime = await createRuntime();
    const quota = new InstallationQuotaBook({ tokens: 0, window_ms: 60_000 });
    const seenOptions = [];
    let releasePoll;
    const blocked = new Promise((resolve) => { releasePoll = resolve; });
    const runner = new ConnectorRunner(
      {
        source: "fake",
        limits: { max_concurrency: 1, page_size: 25 },
        async poll(_cursor, options) {
          seenOptions.push(options);
          await blocked;
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
      quota,
    );
    const first = runner.poll(input);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await runner.poll({ ...input, stream_key: "other" });
    assert.equal(second.status, "throttled");
    assert.equal(quota.limits("installation-1").inflight, 1);
    releasePoll();
    assert.equal((await first).status, "completed");
    assert.equal(quota.limits("installation-1").inflight, 0);
    assert.equal(seenOptions.length, 1);
    assert.equal(seenOptions[0].page_size, 25);

    quota.adjust("installation-1", { max_concurrency: 2, page_size: 10 });
    const again = await runner.poll({ ...input, stream_key: "other" });
    assert.equal(again.status, "completed");
    assert.equal(seenOptions[1].page_size, 10);
  });

  it("forwards an opaque push watermark on a history poll", async () => {
    const runtime = await createRuntime();
    const seen = [];
    const runner = new ConnectorRunner(
      {
        source: "fake",
        async poll(_cursor, options) {
          seen.push(options);
          return { batch: batch([]), next_cursor: undefined };
        },
      },
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    const run = await runner.poll({
      ...input,
      older: true,
      push_watermark: "  cursor-9  ",
    });
    assert.equal(run.status, "completed");
    assert.equal(seen[0].older, true);
    assert.equal(seen[0].push_watermark, "cursor-9");
  });

  it("does not reuse a live lease cursor when history starts from a push watermark", async () => {
    const runtime = await createRuntime();
    const seen = [];
    const connector = {
      async poll(cursor) {
        seen.push(cursor?.value ?? null);
        return { batch: batch([]), next_cursor: "cursor-2" };
      },
    };
    const runner = new ConnectorRunner(
      new InProcessConnectorInvoker(connector),
      { async ingest() { return validResult([]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    await runner.poll(input);
    const history = await runner.poll({
      ...input,
      older: true,
      push_watermark: "wm-1",
      cursor: "",
    });
    assert.equal(history.status, "completed");
    assert.deepEqual(seen, [null, null]);
  });

  it("verifies a webhook then ingests through the kernel", async () => {
    const runtime = await createRuntime();
    const seen = [];
    const runner = new ConnectorRunner(
      {
        source: "push",
        source_mode: "webhook",
        async verifyWebhook(request) {
          seen.push(Buffer.from(request.body).toString());
          return { body: request.body, verified_at: request.received_at };
        },
        async handleWebhook() {
          return batch();
        },
      },
      {
        async ingest(input) {
          return validResult([
            { external_id: "message-1", status: "accepted", event_id: "event-1" },
          ]);
        },
      },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    const run = await runner.webhook({
      installation_id: "installation-1",
      request: {
        headers: { "x-test": "1" },
        body: new Uint8Array(Buffer.from('{"ok":true}')),
        received_at: "2026-08-12T00:00:00.000Z",
      },
    });
    assert.equal(run.status, "completed");
    assert.deepEqual(seen, ['{"ok":true}']);
    assert.equal(run.result.records[0].status, "accepted");
    const cursor = await runtime.getCursor("installation-1", "personal");
    assert.equal(cursor?.cursor, undefined);
  });

  it("keeps class-method this when polling", async () => {
    const runtime = await createRuntime();
    class ClassConnector {
      source = "fake";
      async poll() {
        return { batch: batch(this.records()), next_cursor: "cursor-2" };
      }
      records() {
        return batch().records;
      }
    }
    const runner = new ConnectorRunner(
      new ClassConnector(),
      {
        async ingest() {
          return validResult([
            { external_id: "message-1", status: "accepted", event_id: "event-1" },
          ]);
        },
      },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    const run = await runner.poll(input);
    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
  });

  it("lets ingest commit the page without a second settle", async () => {
    const runtime = await createRuntime();
    let pages = 0;
    const original = runtime.commitSyncPage.bind(runtime);
    runtime.commitSyncPage = async (input) => {
      pages += 1;
      return original(input);
    };
    const runner = new ConnectorRunner(
      {
        async poll() {
          return { batch: batch(), next_cursor: "cursor-2" };
        },
      },
      {
        async ingest(_input, page) {
          await runtime.commitSyncPage({
            attempt: page.attempt,
            settle: {
              ...page.settle,
              accepted_count: 1,
              duplicate_count: 0,
              quarantined_count: 0,
              retryable_failure_count: 0,
              quarantines: [],
            },
          });
          return {
            valid: true,
            connector_id: "fake-poll",
            delivery_id: "page-1",
            records: [
              {
                external_id: "message-1",
                status: "accepted",
                event_id: "event-1",
              },
            ],
            page_committed: true,
          };
        },
      },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    const run = await runner.poll(input);
    assert.equal(run.status, "completed");
    assert.equal(pages, 1);
    const cursor = await runtime.getCursor("installation-1", "personal");
    assert.equal(cursor.cursor, "cursor-2");
  });

  it("does not ingest a webhook when the mode is poll-only", async () => {
    const runtime = await createRuntime();
    const runner = new ConnectorRunner(
      {
        source: "fake",
        async poll() {
          return { batch: batch([]), next_cursor: undefined };
        },
        async verifyWebhook() {
          throw new Error("must not verify");
        },
        async handleWebhook() {
          throw new Error("must not handle");
        },
      },
      { async ingest() { throw new Error("must not ingest"); } },
      runtime,
    );
    const run = await runner.webhook({
      installation_id: "installation-1",
      request: {
        headers: {},
        body: new Uint8Array(),
        received_at: "2026-08-12T00:00:00.000Z",
      },
    });
    assert.equal(run.status, "unsupported_mode");
  });

  it("ingests a scroll without moving the lease cursor", async () => {
    const runtime = await createRuntime();
    const seen = [];
    const connector = {
      async poll(cursor) {
        seen.push(cursor?.value ?? null);
        return {
          batch: batch(),
          next_cursor: seen.length === 1 ? "cursor-2" : "scroll-blob",
        };
      },
    };
    const runner = new ConnectorRunner(
      new InProcessConnectorInvoker(connector),
      { async ingest() { return validResult([{ external_id: "message-1", status: "accepted", event_id: "event-1" }]); } },
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );
    await runner.poll(input);
    const scrolled = await runner.poll({
      ...input,
      cursor: "live-blob",
      commit_cursor: false,
      before: "2026-10-01T00:00:00.000Z",
    });
    const cursor = await runtime.getCursor("installation-1", "personal");
    assert.equal(scrolled.status, "completed");
    assert.equal(scrolled.next_cursor, "scroll-blob");
    assert.deepEqual(seen, [null, "live-blob"]);
    assert.equal(cursor.cursor, "cursor-2");
  });
});
