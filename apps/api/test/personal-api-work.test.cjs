const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { existsSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { PostgresAuthorityStore } = require("@regenic/authority-store/postgres");
const SqliteDatabase = require(require.resolve("better-sqlite3", {
  paths: [require.resolve("@regenic/authority-store/sqlite")],
}));
const { Client } = require("pg");
const { FsBlobStore } = require("@regenic/blob-store");
const { ChannelDriverRegistry, INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");

function flowJson(body) {
  if (
    !body || typeof body !== "object" || body.config || body.connector_type || body.kind ||
    body.inbox_sort ||
    (!body.match && !body.executor_type && !body.executor_config && !body.trigger &&
      body.can_write_back === undefined && body.write_back_thread_id === undefined)
  ) {
    return JSON.stringify(body);
  }
  const params = body.executor_config ?? {};
  const task = typeof params.prompt === "string" ? params.prompt
    : typeof params.instruction === "string" ? params.instruction : undefined;
  const thread = typeof body.write_back_thread_id === "string" && body.write_back_thread_id
    ? body.write_back_thread_id : undefined;
  const send = body.can_write_back === undefined
    ? body.trigger?.kind === "pull"
    : body.can_write_back === true;
  return JSON.stringify({
    ...(body.name ? { name: body.name } : {}),
    config: {
      source: { installations: "all" },
      scope: { kind: "new_messages", match: body.match ?? {} },
      handler: {
        kind: "agent",
        executor_type: body.executor_type ?? "",
        ...(task !== undefined ? { task } : {}),
        ...(Object.keys(params).length ? { params } : {}),
      },
      ...((send || thread) ? {
        destination: { kind: "reply", thread: thread || "origin", confirm: false, send },
      } : {}),
      trigger: body.trigger ?? { kind: "push", coalesce: true },
      hide_on_success: body.hide_on_success === true,
      include_context: body.include_context === true || body.trigger?.kind === "pull",
      ...(body.max_concurrent ? { max_concurrent: body.max_concurrent } : {}),
      enabled: body.enabled !== false,
    },
  });
}
const { PersonalRuntimeService } = require("../dist/personal-runtime.service");
const { PersonalWorkService } = require("../dist/personal-work.service");
const {
  PERSONAL_API_KEY,
  createRoot,
  ingestActionable,
  seedHostedWork,
  seedLegacyWorkIdentity,
  startDshWebStub,
  startPersonalApi,
  waitUntil,
} = require("./personal-api-harness.cjs");

async function startPersonalApiProcess(t, database, blobRoot, {
  holdWork = false,
  holdAcknowledgmentResponse = false,
  holdAcknowledgmentCommit = false,
  acknowledgmentCommitBarrierPath,
  acknowledgmentCommitCommandId,
  postgresUrl,
} = {}) {
  const { isolatedEnvironment } = await import("../../../scripts/testing/lib.mjs");
  const sqliteModulePath = require.resolve("better-sqlite3", {
    paths: [require.resolve("@regenic/authority-store/sqlite")],
  });
  let preloaderPath;
  if (holdAcknowledgmentCommit) {
    if (!acknowledgmentCommitBarrierPath) {
      throw new Error("An acknowledgment commit barrier path is required");
    }
    if (!acknowledgmentCommitCommandId) {
      throw new Error("An acknowledgment command ID is required for the commit barrier");
    }
    preloaderPath = `${acknowledgmentCommitBarrierPath}.cjs`;
    writeFileSync(preloaderPath, `
      const { isMainThread, workerData } = require("node:worker_threads");
      if (!isMainThread && workerData?.path && workerData.readonly !== true) {
        const { writeFileSync } = require("node:fs");
        const Database = require(${JSON.stringify(sqliteModulePath)});
        const prepare = Database.prototype.prepare;
        let held = false;
        Database.prototype.prepare = function (sql, ...options) {
          const statement = prepare.call(this, sql, ...options);
          if (!sql.includes("'work_acknowledged'")) return statement;
          return new Proxy(statement, {
            get(target, property) {
              if (property === "run") {
                return (...args) => {
                  const result = target.run(...args);
                  if (!held && args.includes(${JSON.stringify(acknowledgmentCommitCommandId)})) {
                    held = true;
                    writeFileSync(${JSON.stringify(acknowledgmentCommitBarrierPath)}, "pending");
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      }
    `);
  }
  const child = spawn(process.execPath, [
    ...(preloaderPath ? ["--require", preloaderPath] : []),
    "--experimental-sqlite", "-e", `
    const { createHttpApp, listenHttpApp } = require(process.argv[1]);
    const { PersonalWorkService } = require(process.argv[2]);
    if (process.argv[4] === "true") {
      const { ServerResponse } = require("node:http");
      const end = ServerResponse.prototype.end;
      let held = false;
      ServerResponse.prototype.end = function (...args) {
        if (!held && this.req?.method === "POST"
          && /^\\/v1\\/me\\/work-items\\/[^/]+\\/acknowledge(?:\\?|$)/.test(this.req.url ?? "")) {
          held = true;
          process.send({ acknowledgmentResponsePending: true, status: this.statusCode });
          return this;
        }
        return end.apply(this, args);
      };
    }
    async function main() {
      const app = await createHttpApp({ logger: false });
      const work = app.get(PersonalWorkService);
      if (process.argv[3] === "true") await work.pauseForMaintenance();
      await listenHttpApp(app, 0, "127.0.0.1");
      process.on("message", async (message) => {
        if (message !== "tick") return;
        try {
          await work.afterConnectorTick();
          process.send({ ticked: true });
        } catch (error) {
          console.error(error);
          process.exit(1);
        }
      });
      process.send({ origin: await app.getUrl() });
    }
    main().catch((error) => { console.error(error); process.exit(1); });
  `, require.resolve("../dist/http-app"), require.resolve("../dist/personal-work.service"), String(holdWork), String(holdAcknowledgmentResponse)], {
    env: {
      ...isolatedEnvironment(join(database, "..")),
      ...(postgresUrl
        ? { REGENIC_AUTHORITY_DRIVER: "postgres", DATABASE_URL: postgresUrl }
        : { REGENIC_AUTHORITY_DRIVER: "sqlite", REGENIC_DATABASE: database }),
      REGENIC_BLOB_ROOT: blobRoot,
      REGENIC_ORG: "local-owner", REGENIC_PERSONAL_API_KEY: PERSONAL_API_KEY,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
  const exited = once(child, "exit");
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      const [code, signal] = await exited;
      assert.equal(code, null, "API exited before the expected SIGKILL");
      assert.equal(signal, "SIGKILL");
      return;
    }
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  };
  t.after(kill);
  const receive = () => Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(([code, signal]) => {
      const diagnostic = postgresUrl ? stderr.replaceAll(postgresUrl, "[redacted]") : stderr;
      throw new Error(`Personal API process exited (${code}, ${signal}): ${diagnostic}`);
    }),
  ]);
  const watchdog = setTimeout(() => child.kill("SIGKILL"), postgresUrl ? 60_000 : 30_000);
  let ready;
  try {
    ready = await receive();
    assert.equal(typeof ready.origin, "string");
    const response = await fetch(`${ready.origin}/v1/me/inbox`);
    assert.equal(response.status, 200);
  } catch (error) {
    await kill();
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
  return {
    origin: ready.origin,
    kill,
    nextMessage: receive,
    async tick() {
      const reply = receive();
      child.send("tick");
      assert.deepEqual(await reply, { ticked: true });
    },
  };
}

describe("personal /v1/me", { concurrency: 1 }, () => {
  for (const [autoComplete, resolution, hideOnSuccess] of [[false, true], [true, true], [true, false]].flatMap(([policy, hide]) =>
    ["retry", "sent", "not_sent"].map((resolution) => [policy, resolution, hide]))) {
    it(`keeps required write-back visible until delivery succeeds (${resolution}, ${autoComplete ? "automatic-v1" : "legacy acknowledgment"}${hideOnSuccess ? "" : ", keep-visible"})`, async (t) => {
      const root = await createRoot();
      const database = join(root, "authority.db");
      const blobRoot = join(root, "blobs");
      const sends = [];
      const delivered = [];
      let accept = false;
      const sender = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw);
        sends.push(input);
        if (accept || resolution === "sent") delivered.push(input);
        if (!accept && resolution !== "retry") {
          response.destroy();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted: accept, rpc_id: "required-result-receipt" }));
      });
      sender.listen(0, "127.0.0.1");
      await once(sender, "listening");
      t.after(() => new Promise((resolve, reject) => {
        sender.close((error) => error ? reject(error) : resolve());
        sender.closeAllConnections();
      }));
      const { app, origin } = await startPersonalApi(database, blobRoot);
      t.after(() => app.close());
      const work = app.get(PersonalWorkService);
      await work.pauseForMaintenance();
      const host = app.get(PersonalRuntimeService).requireHost();
      const authority = host.get("authority");
      const now = new Date().toISOString();
      const source = "required-result-test";
      const threadId = `${source}:source`;
      const destinationId = `${source}:results`;
      app.get(ChannelDriverRegistry).register({
        connector_type: source, source,
        matchesThread: (installation, thread) =>
          installation.connector_type === source && thread.source === source,
        ownsThread: (_installation, thread) => thread.source === source,
        capabilities: () => ({ sync: false, reply: true, create: false }),
        bindEgress: async () => ({
          send: async (input) => {
            const response = await fetch(`http://127.0.0.1:${sender.address().port}/send`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            assert.equal(response.status, 200);
            return response.json();
          },
        }),
        outboundId: (thread, receipt) => `${thread.target}:${receipt.rpc_id}`,
      });
      await authority.createInstallation({
        id: "required-result-sender", org_id: "local-owner",
        connector_type: source, status: "enabled", config: {}, created_at: now,
      });
      const ingest = async (externalId, text) => host.get("ingest").ingest({
        schema_version: INGEST_SCHEMA_VERSION, connector_id: "required-result-sender",
        org_id: "local-owner", delivery_id: externalId, received_at: new Date().toISOString(),
        records: [channelRecord({
          channel: source, kind: "user", direction: "inbound",
          external_id: `source:${externalId}`, occurred_at: new Date().toISOString(),
          actor_id: "requester", scope_id: "source", type: "task", text,
        })],
      });
      const ingested = await ingest("task-1", "Handle the request and send the result.");
      const eventId = ingested.records[0].event_id;
      const recipe = {
        id: "required-result-rule", org_id: "local-owner", name: "Required result",
        match: { thread_id: threadId }, trigger: { kind: "manual" },
        executor_type: "test", executor_config: {}, include_context: false,
        can_write_back: true, write_back_thread_id: destinationId,
        hide_on_success: hideOnSuccess,
        enabled: false, created_at: now, updated_at: now,
      };
      await authority.putRecipe(recipe);
      const observed = await authority.getWorkItemByThread("local-owner", threadId);
      assert.equal(observed.head_event_id, eventId);
      const created = await authority.observeWorkItem({
        expected_item: observed,
        item: { ...observed, recipe_id: recipe.id, updated_at: now },
      });
      assert.equal(created.outcome, "applied");
      const run = {
        id: "required-result-run", org_id: "local-owner", work_item_id: created.item.id,
        recipe_id: recipe.id, executor_type: "test", status: "running", start_state: "pending",
        write_back_required: true, write_back_target: {
          installation_id: "required-result-sender", source, target: "results",
        },
        trigger_kind: "manual", created_at: now, updated_at: now,
        hide_on_success: hideOnSuccess,
        ...(autoComplete ? { completion_policy_version: 1 } : {}),
      };
      assert.equal(await authority.claimWorkRunStart({
        expected_item: created.item, expected_recipe: recipe, run,
      }), true);
      const submitted = await authority.checkpointWorkRunStart({
        expected_item: await authority.getWorkItem("local-owner", created.item.id),
        expected_run: await authority.getWorkRun("local-owner", run.id),
        kind: "submitted", external_run_id: "required-result-execution", now,
      });
      assert.equal(submitted.outcome, "applied");
      const completed = await authority.commitWorkObservation({
        expected_item: submitted.item, expected_run: submitted.run,
        handle: {
          status: "completed", external_run_id: "required-result-execution",
          result: { summary: "Request handled" },
        },
        can_write_back: true, trigger_kind: "manual", now,
      });
      assert.equal(completed.outcome, "applied");
      const post = (path, body) => fetch(`${origin}/v1/me/${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const inbox = async (list = "shown") => {
        const response = await fetch(`${origin}/v1/me/inbox?list=${list}`);
        assert.equal(response.status, 200);
        return response.json();
      };
      const assertVisible = async (status, writeBack) => {
        const row = (await inbox()).find((entry) => entry.thread_id === threadId);
        assert.ok(row, "Required delivery must remain discoverable");
        assert.equal(row.work.status, "done");
        assert.equal(row.work.delivery.status, status);
        assert.equal(row.work.delivery.write_back, writeBack);
        assert.equal((await authority.getConversationPref("local-owner", threadId))?.hidden ?? false, false);
        assert.equal((await authority.getDisposition(eventId)).disposition, "current_work");
        return row;
      };
      const acknowledge = (row, commandId) => post(`work-items/${created.item.id}/acknowledge`, {
        run_id: run.id, expected_version: row.work.version,
        expected_run_version: row.work.run_version,
        command_id: commandId, issued_at: now,
      });
      let row = await assertVisible("queued", "pending");
      assert.equal((await acknowledge(row, "ack-before-required-send")).status, 409);
      assert.equal((await post(`inbox/${eventId}/ack`, {})).status, 201);
      assert.equal((await authority.getWorkItem("local-owner", created.item.id)).acknowledged_run_id, undefined);
      await assertVisible("queued", "pending");
      const delivery = await authority.getWorkDeliveryByItem("local-owner", created.item.id);
      const errors = [];
      const errorLog = t.mock.method(console, "error", (...args) => errors.push(args));
      try {
        await work.flush.flushDeliveries();
      } finally {
        errorLog.mock.restore();
      }
      assert.equal(errors.length, 1);
      assert.equal(sends.length, 1);
      row = resolution === "retry"
        ? await assertVisible("write_back", "failed")
        : await assertVisible("uncertain", "pending");
      assert.equal(row.attention, "waiting_you");
      assert.equal((await acknowledge(row, "ack-after-rejected-send")).status, 409);
      assert.equal((await authority.getWorkItem("local-owner", created.item.id)).acknowledged_run_id, undefined);
      accept = true;
      const retryCommand = {
        expected_version: row.work.version, delivery: row.work.delivery,
        command_id: "retry-required-result", issued_at: now,
      };
      const retryPath = `work-items/${created.item.id}/retry-delivery`;
      const recoveryPath = resolution === "retry" ? retryPath
        : `work-items/${created.item.id}/reconcile-delivery`;
      const recoveryCommand = resolution === "retry" ? retryCommand
        : { ...retryCommand, command_id: "reconcile-required-result", resolution };
      if (resolution !== "retry") {
        await work.flush.flushDeliveries();
        assert.equal((await post(retryPath, retryCommand)).status, 409);
        await assertVisible("uncertain", "pending");
        assert.equal(sends.length, 1, "Unknown acceptance must not be blindly resent");
      }
      const recovered = await post(recoveryPath, recoveryCommand);
      assert.equal(recovered.status, 201, await recovered.clone().text());
      row = autoComplete
        ? (await inbox(hideOnSuccess ? "hidden" : "shown")).find((entry) => entry.thread_id === threadId)
        : await assertVisible("acked", "sent");
      assert.ok(row);
      if (autoComplete) {
        assert.equal(row.work.auto_completed, true);
        assert.equal(row.work.acknowledged_run_id, undefined);
        assert.equal((await authority.getDisposition(eventId)).disposition, "outside_current_work");
        assert.equal((await authority.getConversationPref("local-owner", threadId))?.hidden ?? false, hideOnSuccess);
        assert.equal((await inbox()).some((entry) => entry.thread_id === threadId), !hideOnSuccess);
        const headsResponse = await fetch(`${origin}/v1/me/inbox?heads=true&split=true&list=${hideOnSuccess ? "hidden" : "shown"}`);
        assert.equal(headsResponse.status, 200);
        const heads = await headsResponse.json();
        assert.ok([...heads.pinned, ...heads.live, ...heads.active_work]
          .some((entry) => entry.thread_id === threadId));
      }
      const sent = await authority.getWorkDelivery("local-owner", delivery.id);
      assert.equal(sent.run_id, run.id);
      const expectedSends = resolution === "sent" ? 1 : 2;
      if (resolution === "sent") {
        assert.equal(sent.channel_receipt, undefined, "Human verification must not fabricate a channel receipt");
      } else {
        assert.equal(sent.channel_receipt.accepted, true);
      }
      assert.equal(sends.length, expectedSends);
      assert.equal(delivered.length, 1, "Recovery must produce exactly one destination delivery");
      assert.deepEqual(sends.map((input) => input.idempotency_key),
        Array(expectedSends).fill(delivery.idempotency_key));
      assert.deepEqual(sends.map((input) => input.target.scope_id), Array(expectedSends).fill("results"));
      assert.equal(sends.at(-1).content[0].text, "Request handled");
      const response = await acknowledge(row, "ack-required-result");
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal((await response.json()).work_item.acknowledged_run_id, run.id);
      assert.equal((await inbox()).some((entry) => entry.thread_id === threadId), !hideOnSuccess);
      assert.equal((await inbox("hidden")).some((entry) => entry.thread_id === threadId), hideOnSuccess);
      const pref = await authority.getConversationPref("local-owner", threadId);
      assert.equal(pref?.hidden ?? false, hideOnSuccess);
      if (hideOnSuccess) assert.equal(pref.hidden_reason, "policy");
      assert.equal((await authority.getDisposition(eventId)).disposition, "outside_current_work");
      assert.equal((await authority.getConversationPref("local-owner", destinationId))?.hidden ?? false, false);
      assert.equal((await acknowledge(row, "ack-required-result")).status, 201);
      assert.equal((await post(recoveryPath, recoveryCommand)).status, 201);
      assert.equal(sends.length, expectedSends, "Command replay must not resend the result");
      assert.equal(delivered.length, 1);
      assert.equal((await authority.listWorkRuns("local-owner", created.item.id)).length, 1);
      assert.deepEqual(await authority.getWorkRun("local-owner", run.id), completed.transition.run);
      assert.equal((await authority.listWorkDeliveries("local-owner")).length, 1);
      await ingest("task-2", "A new request after the previous result.");
      assert.equal((await inbox()).some((entry) => entry.thread_id === threadId), true);
      assert.equal((await authority.getConversationPref("local-owner", threadId)).hidden, false);
      assert.equal((await acknowledge(row, "ack-required-result")).status, 201);
      assert.equal((await authority.getConversationPref("local-owner", threadId)).hidden, false);
    });
  }

  it("opens a task work item even when a later utterance is the list head", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "buried-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_travel:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_travel",
          type: "task",
          text: "Approve travel",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_travel:comment-2",
          occurred_at: "2026-08-25T00:05:00.000Z",
          actor_id: "u1",
          scope_id: "oc_travel",
          text: "Please confirm the release.",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      await waitUntil("buried task opens a work item", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
        const row = inbox.find((item) => item.thread_id === "feishu:oc_travel");
        return row?.work?.status === "open" && row?.event?.external_id === "oc_travel:comment-2";
      });
      const inbox = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const row = inbox.find((item) => item.thread_id === "feishu:oc_travel");
      assert.equal(row.event.external_id, "oc_travel:comment-2");
      assert.equal(row.work.status, "open");
      assert.equal(row.record_class, "task");
      assert.equal(row.thread_facet, "ticket");
    } finally {
      await app.close();
    }
  });

  it("lists cancellation failures and retries only dead jobs through the management API", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const authority = new SqliteAuthorityStore(database);
    await seedHostedWork(authority, {
      workId: "work-cancel-retry",
      runId: "run-cancel-retry",
      recipeId: "recipe-cancel-retry",
      threadId: "regenic:personal",
      eventId,
      status: "running",
    });
    const item = await authority.getWorkItem("local-owner", "work-cancel-retry");
    const dismissed = await authority.dismissWorkItem({
      expected_item: item,
      now: new Date().toISOString(),
    });
    assert.equal(dismissed.outcome, "applied");
    let now = Date.now();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [job] = await authority.claimCancellationJobs({
        org_id: "local-owner",
        owner: `management-test-${attempt}`,
        now: new Date(now).toISOString(),
        lease_ms: 30_000,
        limit: 1,
      });
      assert.ok(job);
      const settledAt = now + 1_000;
      assert.equal(await authority.settleCancellationJob({
        kind: "failed",
        org_id: "local-owner",
        id: job.id,
        owner: job.lease_owner,
        claim_token: job.claim_token,
        now: new Date(settledAt).toISOString(),
        next_retry_at: new Date(settledAt + 5_000).toISOString(),
        error_code: "cancel_unconfirmed",
        error: "cancel_unconfirmed",
      }), true);
      now = settledAt + 6_000;
    }
    authority.close();

    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const listed = await fetch(`${origin}/v1/me/cancellation-jobs`);
      assert.equal(listed.status, 200);
      const jobs = await listed.json();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "dead");
      assert.equal(jobs[0].run_id, "run-cancel-retry");
      assert.equal(jobs[0].attempts, 5);
      assert.equal("claim_token" in jobs[0], false);

      const command = {
        expected_attempts: 5,
        command_id: "api-cancel-retry-1",
        issued_at: new Date().toISOString(),
      };
      const response = await fetch(
        `${origin}/v1/me/cancellation-jobs/${encodeURIComponent(jobs[0].id)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      assert.equal(response.status, 201);
      const retried = await response.json();
      assert.equal(retried.id, jobs[0].id);
      assert.equal(retried.status, "pending");
      assert.equal(retried.attempts, 0);

      const conflict = await fetch(
        `${origin}/v1/me/cancellation-jobs/${encodeURIComponent(jobs[0].id)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...command, expected_attempts: 4, command_id: "api-cancel-retry-2" }),
        },
      );
      assert.equal(conflict.status, 409);
    } finally {
      await app.close();
    }
  });

  it("reports active work items whose current run identity cannot be verified", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const now = new Date().toISOString();
    await authority.putRecipe({
      id: "recipe-identity-check",
      org_id: "local-owner",
      name: "Identity check",
      match: { record_class: "task" },
      trigger: { kind: "push" },
      executor_type: "dsh",
      executor_config: {},
      include_context: false,
      can_write_back: false,
      enabled: true,
      created_at: now,
      updated_at: now,
    });
    const item = {
      id: "work-identity-check",
      org_id: "local-owner",
      recipe_id: "recipe-identity-check",
      thread_id: "source:identity-check",
      unit_key: "unit-identity-check",
      record_class: "task",
      thread_facet: "ticket",
      status: "running",
      created_at: now,
      updated_at: now,
    };
    const run = {
      id: "run-identity-check",
      org_id: "local-owner",
      work_item_id: "work-identity-check",
      recipe_id: "recipe-identity-check",
      executor_type: "dsh",
      status: "running",
      start_state: "uncertain",
      created_at: now,
      updated_at: now,
    };
    authority.close();
    seedLegacyWorkIdentity(database, { item, run });

    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/work-identity-diagnostics`);
      assert.equal(response.status, 200);
      const diagnostics = await response.json();
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(diagnostics[0], {
        work_item_id: "work-identity-check",
        thread_id: "source:identity-check",
        unit_key: "unit-identity-check",
        item_status: "running",
        reason: "missing_current_run",
        candidate_run_ids: ["run-identity-check"],
      });
    } finally {
      await app.close();
    }
  });

  it("dismisses a work item without writing back or faking exit", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "dismiss-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_dismiss:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_dismiss",
          type: "text",
          text: "Approve travel",
        }),
      ],
    });
    await seedHostedWork(authority, {
      workId: "work-dismiss-1",
      runId: "run-dismiss-1",
      recipeId: "recipe-dismiss",
      threadId: "feishu:oc_dismiss",
      eventId: ingested.records[0].event_id,
      status: "running",
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const workId = "work-dismiss-1";
      const inboxBeforeDismiss = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const threadBeforeDismiss = inboxBeforeDismiss.find((item) => item.thread_id === "feishu:oc_dismiss");
      assert.equal(typeof threadBeforeDismiss.work.version, "number");
      const expectedVersion = threadBeforeDismiss.work.version;
      const dismissalCommand = {
        expected_version: expectedVersion,
        command_id: "dismiss-command-1",
        issued_at: new Date().toISOString(),
      };
      const dismissed = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dismissalCommand),
      });
      assert.ok(dismissed.ok, `dismiss ${dismissed.status}`);
      const body = await dismissed.json();
      assert.equal(body.work_item.status, "skipped");
      assert.equal(body.work_item.id, workId);
      assert.equal(body.work_item.version, expectedVersion + 1);
      assert.equal(body.run.status, "running");
      assert.notEqual(body.run.status, "failed");
      const replayed = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dismissalCommand),
      });
      assert.equal(replayed.status, 201);
      const replayedBody = await replayed.json();
      assert.equal(replayedBody.work_item.version, expectedVersion + 1);
      assert.equal(replayedBody.run.status, "running");
      const dismissalCommandConflict = await fetch(
        `${origin}/v1/me/work-items/${workId}/dismiss`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...dismissalCommand,
            expected_version: expectedVersion + 1,
          }),
        },
      );
      assert.equal(dismissalCommandConflict.status, 409);
      const aliased = await (
        await fetch(`${origin}/v1/me/work-items/${workId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_version: body.work_item.version,
            command_id: "dismiss-command-2",
            issued_at: new Date().toISOString(),
          }),
        })
      ).json();
      assert.equal(aliased.work_item.status, "skipped");
      assert.equal(aliased.run.status, "running");
      const staleDismiss = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: expectedVersion,
          command_id: "dismiss-stale-1",
          issued_at: new Date().toISOString(),
        }),
      });
      assert.equal(staleDismiss.status, 409);
      const missingVersion = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(missingVersion.status, 400);
      const missingCommandId = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: body.work_item.version }),
      });
      assert.equal(missingCommandId.status, 400);
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const texts = inbox
        .filter((item) => item.thread_id === "feishu:oc_dismiss")
        .map((item) => item.body_text ?? "");
      assert.equal(
        texts.some((text) => text === "Done" || /work-back/.test(text)),
        false,
      );
    } finally {
      await app.close();
    }
  });

  for (const [driver, claimed] of [
    ["sqlite", false], ["sqlite", true], ["postgres", false], ["postgres", true],
  ]) {
    it(`recovers ${claimed ? "an in-flight" : "a pending"} cancellation after the full API process is killed and restarted (${driver})`, {
      skip: driver === "postgres" && !process.env.TEST_DATABASE_URL?.trim(),
      timeout: driver === "postgres" ? 180_000 : 90_000,
    }, async (t) => {
      const root = await createRoot();
      const database = join(root, "authority.db");
      const blobRoot = join(root, "blobs");
      const orgId = "local-owner";
      const externalRunId = "crash-recovery-execution";
      const processes = [];
      let admin;
      let ownedDatabase;
      let postgresUrl;
      t.after(async () => {
        try {
          for (const api of processes) await api.kill();
        } finally {
          try {
            if (ownedDatabase) {
              await waitUntil("owned API database connections close", async () => {
                const { rows } = await admin.query(
                  "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1",
                  [ownedDatabase],
                );
                return rows[0].connections === 0;
              }, 15_000);
              await admin.query(`DROP DATABASE ${ownedDatabase}`);
            }
          } finally {
            await admin?.end();
          }
        }
      });
      if (driver === "postgres") {
        const url = new URL(process.env.TEST_DATABASE_URL);
        admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
        await admin.connect();
        const name = `api_crash_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE ${name}`);
        ownedDatabase = name;
        url.pathname = `/${name}`;
        url.searchParams.set("options", "-csearch_path=public");
        postgresUrl = url.toString();
      }
      const openAuthority = (readOnly = false) => postgresUrl
        ? PostgresAuthorityStore.open(postgresUrl, { migrate: false, readOnly })
        : new SqliteAuthorityStore(database, { readonly: readOnly });
      const startApi = async (holdWork = false) => {
        const api = await startPersonalApiProcess(t, database, blobRoot, { holdWork, postgresUrl });
        processes.push(api);
        return api;
      };
      const calls = { cancel: [], start: 0, resume: 0, unexpected: [] };
      const releaseFirstCancel = Promise.withResolvers();
      let remoteStatus = "running";
      const executorServer = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (request.method === "POST" && request.url === `/v1/runs/${externalRunId}/cancel`) {
          calls.cancel.push({ body: JSON.parse(raw), at: Date.now() });
          if (claimed && calls.cancel.length === 1) {
            await releaseFirstCancel.promise;
          } else {
            remoteStatus = "cancelled";
          }
        } else if (request.method === "POST" && request.url === "/v1/runs") {
          calls.start++;
        } else if (request.method === "POST" && request.url === `/v1/runs/${externalRunId}/resume`) {
          calls.resume++;
        } else if (request.method !== "GET" || request.url !== `/v1/runs/${externalRunId}`) {
          calls.unexpected.push(`${request.method} ${request.url}`);
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ external_run_id: externalRunId, status: remoteStatus }));
      });
      t.after(async () => {
        releaseFirstCancel.resolve();
        executorServer.closeAllConnections();
        await new Promise((resolve, reject) => executorServer.close((error) => error ? reject(error) : resolve()));
      });
      const listening = once(executorServer, "listening");
      executorServer.listen(0, "127.0.0.1");
      await listening;
      const seed = postgresUrl
        ? await PostgresAuthorityStore.open(postgresUrl)
        : new SqliteAuthorityStore(database);
      let event;
      try {
        const ingestion = new IngestionService(new FsBlobStore(blobRoot), seed);
        const now = "2026-08-25T00:00:00.000Z";
        const ingested = await ingestion.ingest({
          schema_version: INGEST_SCHEMA_VERSION, connector_id: "lifecycle-test", org_id: orgId,
          delivery_id: "api-crash-recovery", received_at: now,
          records: [channelRecord({
            channel: "lifecycle-test", kind: "user", direction: "inbound",
            external_id: "crash-recovery:task", scope_id: "crash-recovery", actor_id: "test-user",
            occurred_at: now, type: "task", text: "Review before cancelling",
          })],
        });
        event = await seed.getEvent(orgId, ingested.records[0].event_id);
      } finally {
        await seed.close();
      }

      const first = await startApi(!claimed);
      const installedResponse = await fetch(`${first.origin}/v1/me/executors`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "http", name: "Crash recovery acceptance",
          config: { base_url: `http://127.0.0.1:${executorServer.address().port}` },
        }),
      });
      const installed = await installedResponse.json();
      assert.equal(installedResponse.status, 201, JSON.stringify(installed));
      const authority = await openAuthority();
      let item;
      let run;
      try {
        const now = new Date().toISOString();
        await authority.putRecipe({
          id: "recipe-api-crash", org_id: orgId, name: "Crash recovery",
          match: { record_class: "task" }, trigger: { kind: "push" },
          executor_type: installed.id, executor_config: {}, include_context: false,
          can_write_back: false, enabled: false, created_at: now, updated_at: now,
        });
        const observed = await authority.getWorkItemByThread(orgId, event.thread_id);
        const bound = await authority.observeWorkItem({
          expected_item: observed,
          item: { ...observed, recipe_id: "recipe-api-crash", updated_at: now },
        });
        assert.equal(bound.outcome, "applied");
        run = {
          id: "run-api-crash", org_id: orgId, work_item_id: observed.id,
          recipe_id: "recipe-api-crash", executor_type: installed.id, status: "running",
          start_state: "pending", write_back_required: false, trigger_kind: "push",
          created_at: now, updated_at: now,
        };
        assert.equal(await authority.claimWorkRunStart({ expected_item: bound.item, run }), true);
        const submitted = await authority.checkpointWorkRunStart({
          expected_item: await authority.getWorkItem(orgId, observed.id),
          expected_run: await authority.getWorkRun(orgId, run.id),
          kind: "submitted", external_run_id: externalRunId, now,
        });
        assert.equal(submitted.outcome, "applied");
        const running = await authority.commitWorkObservation({
          expected_item: submitted.item, expected_run: submitted.run,
          handle: { external_run_id: externalRunId, status: "running" },
          can_write_back: false, trigger_kind: "push", now,
        });
        assert.equal(running.outcome, "applied");
        item = running.transition.item;
        run = running.transition.run;
        const recipe = await authority.getRecipe(orgId, item.recipe_id);
        await authority.putRecipe({ ...recipe, enabled: true, updated_at: now });
      } finally {
        await authority.close();
      }
      const snapshot = async () => {
        const store = await openAuthority(true);
        try {
          return {
            item: await store.getWorkItem(orgId, item.id),
            run: await store.getWorkRun(orgId, run.id),
            runs: await store.listWorkRuns(orgId, item.id),
            deliveries: await store.listWorkDeliveries(orgId),
            recipe: await store.getRecipe(orgId, item.recipe_id),
            pref: await store.getConversationPref(orgId, event.thread_id),
            jobs: await store.listCancellationJobs(orgId),
          };
        } finally {
          await store.close();
        }
      };
      const command = {
        expected_version: item.version, command_id: "dismiss-api-before-crash",
        issued_at: new Date().toISOString(),
      };
      const dismiss = (origin) => fetch(`${origin}/v1/me/work-items/${item.id}/dismiss`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
      });
      const dismissedResponse = await dismiss(first.origin);
      const dismissed = await dismissedResponse.json();
      assert.equal(dismissedResponse.status, 201, JSON.stringify(dismissed));
      assert.equal(dismissed.work_item.status, "skipped");
      assert.equal(dismissed.run.status, "running");
      if (claimed) {
        await waitUntil("first API cancellation reaches the HTTP executor", () => calls.cancel.length === 1,
          postgresUrl ? 15_000 : 4_000);
      }
      await first.kill();
      releaseFirstCancel.resolve();
      const committed = await snapshot();
      assert.equal(committed.item.status, "skipped");
      assert.equal(committed.item.version, item.version + 1);
      assert.equal(committed.item.current_run_id, run.id);
      assert.equal(committed.run.status, "running");
      assert.equal(committed.run.external_run_id, externalRunId);
      assert.equal(committed.pref.hidden, true);
      assert.equal(committed.pref.hidden_reason, "policy");
      assert.equal(committed.pref.visibility_version, committed.item.visibility_intent_version);
      assert.equal(committed.jobs.length, 1);
      const [job] = committed.jobs;
      assert.equal(job.run_id, run.id);
      assert.equal(job.status, claimed ? "running" : "pending");
      assert.equal(job.attempts, claimed ? 1 : 0);

      const checkInbox = async (origin) => {
        const visibleResponse = await fetch(`${origin}/v1/me/inbox?heads=1`);
        assert.equal(visibleResponse.status, 200);
        const visible = await visibleResponse.json();
        assert.equal(visible.some((row) => row.thread_id === event.thread_id), false);
        const hiddenResponse = await fetch(`${origin}/v1/me/inbox?heads=1&list=hidden`);
        assert.equal(hiddenResponse.status, 200);
        const hidden = (await hiddenResponse.json()).filter((row) => row.thread_id === event.thread_id);
        assert.equal(hidden.length, 1);
        assert.equal(hidden[0].hidden, true);
        assert.equal(hidden[0].work.status, "skipped");
        assert.equal(hidden[0].work.run_id, run.id);
      };
      const second = await startApi();
      await checkInbox(second.origin);
      await waitUntil("restarted API settles the durable cancellation", async () =>
        (await snapshot()).jobs[0]?.status === "succeeded", postgresUrl ? 75_000 : 45_000);
      const recovered = await snapshot();
      assert.deepEqual(recovered.item, committed.item);
      assert.deepEqual(recovered.pref, committed.pref);
      assert.equal(recovered.run.status, "cancelled");
      assert.equal(recovered.run.external_run_id, externalRunId);
      assert.equal(recovered.recipe.enabled, true);
      assert.equal(recovered.jobs.length, 1);
      assert.equal(recovered.jobs[0].id, job.id);
      assert.equal(recovered.jobs[0].outcome_code, "observed_cancelled");
      assert.equal(recovered.jobs[0].attempts, claimed ? 2 : 1);
      assert.equal(calls.cancel.length, claimed ? 2 : 1);
      for (const call of calls.cancel) assert.deepEqual(call.body, { work_item_id: item.id });
      if (claimed) assert.ok(calls.cancel[1].at >= Date.parse(job.lease_expires_at));
      await checkInbox(second.origin);
      await second.kill();

      const third = await startApi();
      const replayResponse = await dismiss(third.origin);
      const replayed = await replayResponse.json();
      assert.equal(replayResponse.status, 201, JSON.stringify(replayed));
      assert.deepEqual(replayed.work_item, dismissed.work_item);
      assert.equal(replayed.run.status, "cancelled");
      await third.tick();
      await checkInbox(third.origin);
      assert.deepEqual(await snapshot(), recovered);
      assert.equal(calls.cancel.length, claimed ? 2 : 1);
      assert.equal(calls.start, 0);
      assert.equal(calls.resume, 0);
      assert.deepEqual(calls.unexpected, []);
      assert.equal(recovered.runs.length, 1);
      assert.deepEqual(recovered.deliveries, []);
    });
  }

  for (const driver of ["sqlite", "postgres"]) {
    it(`replays a result acknowledgment after the API commits but dies before replying (${driver})`, {
      skip: driver === "postgres" && !process.env.TEST_DATABASE_URL?.trim(),
      timeout: driver === "postgres" ? 120_000 : 60_000,
    }, async (t) => {
      const root = await createRoot();
      const database = join(root, "authority.db");
      const blobRoot = join(root, "blobs");
      const processes = [];
      let admin;
      let ownedDatabase;
      let postgresUrl;
      t.after(async () => {
        try {
          for (const api of processes) await api.kill();
        } finally {
          try {
            if (ownedDatabase) {
              await waitUntil("owned acknowledgment database connections close", async () => {
                const { rows } = await admin.query(
                  "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1",
                  [ownedDatabase],
                );
                return rows[0].connections === 0;
              }, 15_000);
              await admin.query(`DROP DATABASE ${ownedDatabase}`);
            }
          } finally {
            await admin?.end();
          }
        }
      });
      if (driver === "postgres") {
        const url = new URL(process.env.TEST_DATABASE_URL);
        admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
        await admin.connect();
        const name = `api_ack_crash_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE ${name}`);
        ownedDatabase = name;
        url.pathname = `/${name}`;
        url.searchParams.set("options", "-csearch_path=public");
        postgresUrl = url.toString();
      }
      const openAuthority = (readOnly = false) => postgresUrl
        ? PostgresAuthorityStore.open(postgresUrl, { migrate: false, readOnly })
        : new SqliteAuthorityStore(database, { readonly: readOnly });
      const seed = postgresUrl
        ? await PostgresAuthorityStore.open(postgresUrl)
        : new SqliteAuthorityStore(database);
      const now = new Date().toISOString();
      const ingested = await new IngestionService(new FsBlobStore(blobRoot), seed).ingest({
        schema_version: INGEST_SCHEMA_VERSION, connector_id: "ack-crash-test",
        org_id: "local-owner", delivery_id: `ack-crash-${driver}`, received_at: now,
        records: [channelRecord({
          channel: "ack-crash-test", kind: "user", direction: "inbound",
          external_id: `ack-crash:${driver}`, scope_id: "ack-crash", actor_id: "test-user",
          occurred_at: now, type: "text", text: "Review this committed result",
        })],
      });
      const event = await seed.getEvent("local-owner", ingested.records[0].event_id);
      await seedHostedWork(seed, {
        workId: `work-ack-crash-${driver}`, runId: `run-ack-crash-${driver}`,
        recipeId: `recipe-ack-crash-${driver}`, threadId: event.thread_id,
        eventId: event.id, status: "done", writeBackRequired: false,
        resultSummary: "Result committed before the response was lost",
      });
      await seed.close();
      const itemId = `work-ack-crash-${driver}`;
      const runId = `run-ack-crash-${driver}`;
      const before = await openAuthority(true);
      let itemBefore;
      let runBefore;
      try {
        itemBefore = await before.getWorkItem("local-owner", itemId);
        runBefore = await before.getWorkRun("local-owner", runId);
      } finally {
        await before.close();
      }
      const command = {
        run_id: runId,
        expected_version: itemBefore.version,
        expected_run_version: runBefore.version,
        command_id: `ack-crash-command-${driver}`,
        issued_at: new Date().toISOString(),
      };
      const first = await startPersonalApiProcess(t, database, blobRoot, {
        holdAcknowledgmentResponse: true, postgresUrl,
      });
      processes.push(first);
      const request = (origin) => fetch(`${origin}/v1/me/work-items/${itemId}/acknowledge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
      });
      const responseOutcome = request(first.origin).then(
        async (response) => ({ kind: "response", status: response.status, body: await response.text() }),
        (error) => ({ kind: "error", error }),
      );
      assert.deepEqual(await first.nextMessage(), { acknowledgmentResponsePending: true, status: 201 });
      await waitUntil("acknowledgment transaction commits before the response is released", async () => {
        const store = await openAuthority(true);
        try {
          const item = await store.getWorkItem("local-owner", itemId);
          return item.acknowledged_run_id === runId ? item : null;
        } finally { await store.close(); }
      });
      const snapshot = async () => {
        const store = await openAuthority(true);
        try {
          return {
            item: await store.getWorkItem("local-owner", itemId),
            run: await store.getWorkRun("local-owner", runId),
            runs: await store.listWorkRuns("local-owner", itemId),
            deliveries: await store.listWorkDeliveries("local-owner"),
            pref: await store.getConversationPref("local-owner", event.thread_id),
            disposition: await store.getDisposition(event.id),
            jobs: await store.listCancellationJobs("local-owner"),
          };
        } finally { await store.close(); }
      };
      const afterCommit = await snapshot();
      assert.equal(afterCommit.item.version, command.expected_version + 1);
      assert.equal(afterCommit.item.current_run_id, runId);
      assert.equal(afterCommit.item.acknowledged_run_id, runId);
      assert.equal(afterCommit.run.status, "completed");
      assert.equal(afterCommit.runs.length, 1);
      assert.deepEqual(afterCommit.deliveries, []);
      assert.equal(afterCommit.pref.hidden, true);
      assert.equal(afterCommit.pref.hidden_reason, "policy");
      assert.equal(afterCommit.disposition.disposition, "outside_current_work");
      assert.deepEqual(afterCommit.jobs, []);
      await first.kill();
      const lostResponse = await Promise.race([
        responseOutcome,
        new Promise((resolve) => setTimeout(() => resolve({ kind: "still-pending" }), 5_000)),
      ]);
      assert.equal(lostResponse.kind, "error", "Killing the API must fail the still-held client response");

      const restarted = await startPersonalApiProcess(t, database, blobRoot, { postgresUrl });
      processes.push(restarted);
      const replayResponse = await request(restarted.origin);
      const replay = await replayResponse.json();
      assert.equal(replayResponse.status, 201, JSON.stringify(replay));
      assert.equal(replay.work_item.acknowledged_run_id, runId);
      assert.equal(replay.work_item.version, command.expected_version + 1);
      assert.deepEqual(await snapshot(), afterCommit);
      const inboxResponse = await fetch(`${restarted.origin}/v1/me/inbox/${event.id}`);
      assert.equal(inboxResponse.status, 200);
      const inbox = await inboxResponse.json();
      assert.equal(inbox.work.acknowledged_run_id, runId);
      assert.equal(inbox.hidden, true);
      await restarted.kill();
    });
  }

  it("does not retry an acknowledged failure after the API response is lost and the process restarts", async (t) => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const seed = new SqliteAuthorityStore(database);
    const now = "2026-08-25T00:00:00.000Z";
    const ingested = await new IngestionService(new FsBlobStore(blobRoot), seed).ingest({
      schema_version: INGEST_SCHEMA_VERSION, connector_id: "ack-failed-restart",
      org_id: "local-owner", delivery_id: "ack-failed-restart", received_at: now,
      records: [channelRecord({
        channel: "ack-failed-restart", kind: "user", direction: "inbound",
        external_id: "ack-failed-restart:event", scope_id: "ack-failed-restart",
        actor_id: "test-user", occurred_at: now, type: "text", text: "Review this failed result",
      })],
    });
    const event = await seed.getEvent("local-owner", ingested.records[0].event_id);
    const itemId = "work-ack-failed-restart";
    const runId = "run-ack-failed-restart";
    await seedHostedWork(seed, {
      workId: itemId, runId, recipeId: "recipe-ack-failed-restart",
      threadId: event.thread_id, eventId: event.id, status: "failed",
      writeBackRequired: false, resultSummary: "The failed run was reviewed",
    });
    await seed.close();
    const openAuthority = (readOnly = false) =>
      new SqliteAuthorityStore(database, { readonly: readOnly });
    const snapshot = async () => {
      const store = await openAuthority(true);
      try {
        return {
          item: await store.getWorkItem("local-owner", itemId),
          run: await store.getWorkRun("local-owner", runId),
          runs: await store.listWorkRuns("local-owner", itemId),
          deliveries: await store.listWorkDeliveries("local-owner"),
          pref: await store.getConversationPref("local-owner", event.thread_id),
          disposition: await store.getDisposition(event.id),
          jobs: await store.listCancellationJobs("local-owner"),
          recipe: await store.getRecipe("local-owner", "recipe-ack-failed-restart"),
        };
      } finally { store.close(); }
    };
    const before = await snapshot();
    assert.equal(before.item.status, "failed");
    assert.equal(before.recipe.enabled, true);
    assert.ok(Date.now() - Date.parse(before.item.updated_at) >= 8 * 60_000,
      "The failed run must be past the automatic retry backoff");
    const command = {
      run_id: runId,
      expected_version: before.item.version,
      expected_run_version: before.run.version,
      command_id: "ack-failed-restart-command",
      issued_at: new Date().toISOString(),
    };
    const request = (origin) => fetch(`${origin}/v1/me/work-items/${itemId}/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
    const first = await startPersonalApiProcess(t, database, blobRoot, {
      holdWork: true, holdAcknowledgmentResponse: true,
    });
    const responseOutcome = request(first.origin).then(
      async (response) => ({ kind: "response", status: response.status, body: await response.text() }),
      (error) => ({ kind: "error", error }),
    );
    assert.deepEqual(await first.nextMessage(), { acknowledgmentResponsePending: true, status: 201 });
    await waitUntil("failed result acknowledgment commits before the HTTP response is held", async () =>
      (await snapshot()).item.acknowledged_run_id === runId);
    const afterCommit = await snapshot();
    assert.equal(afterCommit.item.status, "failed");
    assert.equal(afterCommit.item.acknowledged_run_id, runId);
    assert.equal(afterCommit.item.version, command.expected_version + 1);
    assert.equal(afterCommit.run.status, "failed");
    assert.equal(afterCommit.runs.length, 1);
    assert.equal(afterCommit.disposition.disposition, "outside_current_work");
    assert.deepEqual(afterCommit.deliveries, []);
    assert.deepEqual(afterCommit.jobs, []);
    await first.kill();
    const lostResponse = await Promise.race([
      responseOutcome,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "still-pending" }), 5_000)),
    ]);
    assert.equal(lostResponse.kind, "error", "Killing the API must lose the held response");

    const restarted = await startPersonalApiProcess(t, database, blobRoot);
    const replayResponse = await request(restarted.origin);
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 201, JSON.stringify(replay));
    assert.equal(replay.work_item.status, "failed");
    assert.equal(replay.work_item.acknowledged_run_id, runId);
    await restarted.tick();
    assert.deepEqual(await snapshot(), afterCommit,
      "The unpaused restart scan must not retry the acknowledged failed Run");
    const inboxResponse = await fetch(`${restarted.origin}/v1/me/inbox/${event.id}`);
    assert.equal(inboxResponse.status, 200);
    const inbox = await inboxResponse.json();
    assert.equal(inbox.work.status, "failed");
    assert.equal(inbox.work.acknowledged_run_id, runId);
    await restarted.kill();
  });

  it("rolls back a result acknowledgment when the API dies before the transaction commits", async (t) => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const commitBarrierPath = join(root, "ack-before-commit");
    const seed = new SqliteAuthorityStore(database);
    const now = new Date().toISOString();
    const ingested = await new IngestionService(new FsBlobStore(blobRoot), seed).ingest({
      schema_version: INGEST_SCHEMA_VERSION, connector_id: "ack-precommit-test",
      org_id: "local-owner", delivery_id: "ack-precommit", received_at: now,
      records: [channelRecord({
        channel: "ack-precommit-test", kind: "user", direction: "inbound",
        external_id: "ack-precommit:event", scope_id: "ack-precommit", actor_id: "test-user",
        occurred_at: now, type: "text", text: "Review this uncommitted result",
      })],
    });
    const event = await seed.getEvent("local-owner", ingested.records[0].event_id);
    await seedHostedWork(seed, {
      workId: "work-ack-precommit", runId: "run-ack-precommit",
      recipeId: "recipe-ack-precommit", threadId: event.thread_id,
      eventId: event.id, status: "done", writeBackRequired: false,
      resultSummary: "Result acknowledgment must roll back before commit",
    });
    await seed.close();
    const itemId = "work-ack-precommit";
    const runId = "run-ack-precommit";
    const openAuthority = (readOnly = false) =>
      new SqliteAuthorityStore(database, { readonly: readOnly });
    const snapshot = async () => {
      const store = await openAuthority(true);
      try {
        return {
          item: await store.getWorkItem("local-owner", itemId),
          run: await store.getWorkRun("local-owner", runId),
          runs: await store.listWorkRuns("local-owner", itemId),
          deliveries: await store.listWorkDeliveries("local-owner"),
          pref: await store.getConversationPref("local-owner", event.thread_id),
          disposition: await store.getDisposition(event.id),
          jobs: await store.listCancellationJobs("local-owner"),
        };
      } finally { await store.close(); }
    };
    const before = await snapshot();
    const command = {
      run_id: runId,
      expected_version: before.item.version,
      expected_run_version: before.run.version,
      command_id: "ack-precommit-command",
      issued_at: new Date().toISOString(),
    };
    const request = (origin) => fetch(`${origin}/v1/me/work-items/${itemId}/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
    const api = await startPersonalApiProcess(t, database, blobRoot, {
      holdAcknowledgmentCommit: true, acknowledgmentCommitBarrierPath: commitBarrierPath,
      acknowledgmentCommitCommandId: "ack-precommit-command",
    });
    const responseOutcome = request(api.origin).then(
      async (response) => ({ kind: "response", status: response.status, body: await response.text() }),
      (error) => ({ kind: "error", error }),
    );
    await waitUntil("API reaches acknowledgment after its writes but before SQLite commit", () =>
      existsSync(commitBarrierPath));
    assert.deepEqual(
      await snapshot(),
      before,
      "Independent readers must not observe a partially applied acknowledgment before commit",
    );
    await api.kill();
    const lostResponse = await Promise.race([
      responseOutcome,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "still-pending" }), 5_000)),
    ]);
    assert.equal(lostResponse.kind, "error", `Killing the API must fail the uncommitted request: ${JSON.stringify(lostResponse)}`);
    assert.deepEqual(await snapshot(), before, "The killed transaction must leave no partial acknowledgment state");

    const restarted = await startPersonalApiProcess(t, database, blobRoot);
    const response = await request(restarted.origin);
    const replay = await response.json();
    assert.equal(response.status, 201, JSON.stringify(replay));
    assert.equal(replay.work_item.acknowledged_run_id, runId);
    assert.equal(replay.work_item.version, command.expected_version + 1);
    const afterRetry = await snapshot();
    assert.equal(afterRetry.item.version, command.expected_version + 1);
    assert.equal(afterRetry.run.status, "completed");
    assert.equal(afterRetry.runs.length, 1);
    assert.deepEqual(afterRetry.deliveries, []);
    assert.equal(afterRetry.pref.hidden, true);
    assert.equal(afterRetry.pref.hidden_reason, "policy");
    assert.equal(afterRetry.disposition.disposition, "outside_current_work");
    assert.deepEqual(afterRetry.jobs, []);
    await restarted.kill();
  });

  it("rolls back a result acknowledgment when the final audit write fails", async (t) => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const seed = new SqliteAuthorityStore(database);
    const now = new Date().toISOString();
    const ingested = await new IngestionService(new FsBlobStore(blobRoot), seed).ingest({
      schema_version: INGEST_SCHEMA_VERSION, connector_id: "ack-write-failure-test",
      org_id: "local-owner", delivery_id: "ack-write-failure", received_at: now,
      records: [channelRecord({
        channel: "ack-write-failure-test", kind: "user", direction: "inbound",
        external_id: "ack-write-failure:event", scope_id: "ack-write-failure",
        actor_id: "test-user", occurred_at: now, type: "text", text: "Review this result",
      })],
    });
    const event = await seed.getEvent("local-owner", ingested.records[0].event_id);
    await seedHostedWork(seed, {
      workId: "work-ack-write-failure", runId: "run-ack-write-failure",
      recipeId: "recipe-ack-write-failure", threadId: event.thread_id,
      eventId: event.id, status: "done", writeBackRequired: false,
      resultSummary: "Acknowledgment must remain atomic after a storage error",
    });
    await seed.close();
    const itemId = "work-ack-write-failure";
    const runId = "run-ack-write-failure";
    const commandId = "ack-write-failure-command";
    const storeSnapshot = async () => {
      const store = new SqliteAuthorityStore(database, { readonly: true });
      try {
        return {
          item: await store.getWorkItem("local-owner", itemId),
          run: await store.getWorkRun("local-owner", runId),
          runs: await store.listWorkRuns("local-owner", itemId),
          deliveries: await store.listWorkDeliveries("local-owner"),
          pref: await store.getConversationPref("local-owner", event.thread_id),
          disposition: await store.getDisposition(event.id),
          jobs: await store.listCancellationJobs("local-owner"),
        };
      } finally { store.close(); }
    };
    const before = await storeSnapshot();
    const command = {
      run_id: runId,
      expected_version: before.item.version,
      expected_run_version: before.run.version,
      command_id: commandId,
      issued_at: new Date().toISOString(),
    };
    const request = (origin) => fetch(`${origin}/v1/me/work-items/${itemId}/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
    const databaseAdmin = new SqliteDatabase(database);
    databaseAdmin.exec(`
      CREATE TRIGGER reject_acknowledgment_audit
      BEFORE INSERT ON conversation_lifecycle_events
      WHEN NEW.event_type = 'work_acknowledged' AND NEW.command_id = '${commandId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected acknowledgment audit failure');
      END;
    `);
    databaseAdmin.close();
    const api = await startPersonalApiProcess(t, database, blobRoot);
    const failedResponse = await request(api.origin);
    assert.equal(failedResponse.status, 500, await failedResponse.text());
    assert.deepEqual(await storeSnapshot(), before,
      "A failure on the final audit write must roll back all earlier acknowledgment writes");
    const auditReader = new SqliteDatabase(database, { readonly: true, fileMustExist: true });
    try {
      assert.equal(auditReader.prepare(
        "SELECT count(*) AS count FROM conversation_lifecycle_events WHERE command_id = ?",
      ).get(commandId).count, 0);
    } finally { auditReader.close(); }
    const triggerAdmin = new SqliteDatabase(database);
    triggerAdmin.exec("DROP TRIGGER reject_acknowledgment_audit");
    triggerAdmin.close();

    const retryResponse = await request(api.origin);
    const retry = await retryResponse.json();
    assert.equal(retryResponse.status, 201, JSON.stringify(retry));
    assert.equal(retry.work_item.acknowledged_run_id, runId);
    assert.equal(retry.work_item.version, command.expected_version + 1);
    const afterRetry = await storeSnapshot();
    assert.equal(afterRetry.run.status, "completed");
    assert.equal(afterRetry.runs.length, 1);
    assert.deepEqual(afterRetry.deliveries, []);
    assert.equal(afterRetry.pref.hidden, true);
    assert.equal(afterRetry.pref.hidden_reason, "policy");
    assert.equal(afterRetry.disposition.disposition, "outside_current_work");
    assert.deepEqual(afterRetry.jobs, []);
    const finalAuditReader = new SqliteDatabase(database, { readonly: true, fileMustExist: true });
    try {
      assert.equal(finalAuditReader.prepare(
        "SELECT count(*) AS count FROM conversation_lifecycle_events WHERE command_id = ?",
      ).get(commandId).count, 1);
    } finally { finalAuditReader.close(); }
    await api.kill();
  });

  it("acknowledges the exact completed result with a replay-safe command", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "acknowledge-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [channelRecord({
        channel: "feishu", kind: "user", direction: "inbound",
        external_id: "oc_ack:task-1", occurred_at: "2026-08-25T00:00:00.000Z",
        actor_id: "u1", scope_id: "oc_ack", type: "text", text: "Review result",
      })],
    });
    await seedHostedWork(authority, {
      workId: "work-ack-1", runId: "run-ack-1", recipeId: "recipe-ack",
      threadId: "feishu:oc_ack", eventId: ingested.records[0].event_id,
      status: "done", writeBackRequired: false, resultSummary: "Reviewed",
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const row = inbox.find((item) => item.thread_id === "feishu:oc_ack");
      assert.equal(row.work.status, "done");
      assert.equal(row.work.run_id, "run-ack-1");
      const command = {
        run_id: "run-ack-1",
        expected_version: row.work.version,
        expected_run_version: row.work.run_version,
        command_id: "ack-command-1",
        issued_at: new Date().toISOString(),
      };
      const request = () => fetch(`${origin}/v1/me/work-items/work-ack-1/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      const response = await request();
      assert.equal(response.status, 201, await response.clone().text());
      const acknowledged = await response.json();
      assert.equal(acknowledged.work_item.acknowledged_run_id, "run-ack-1");
      assert.equal(acknowledged.work_item.version, row.work.version + 1);
      const replayed = await request();
      assert.equal(replayed.status, 201);
      assert.equal((await replayed.json()).work_item.acknowledged_run_id, "run-ack-1");
      const conflict = await fetch(`${origin}/v1/me/work-items/work-ack-1/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, run_id: "other-run" }),
      });
      assert.equal(conflict.status, 409);
    } finally {
      await app.close();
    }
    const verification = new SqliteAuthorityStore(database);
    try {
      assert.equal(
        (await verification.getDisposition(ingested.records[0].event_id)).disposition,
        "outside_current_work",
      );
      const pref = await verification.getConversationPref("local-owner", "feishu:oc_ack");
      assert.equal(pref.hidden, true);
      assert.equal(pref.hidden_reason, "policy");
    } finally {
      verification.close();
    }
  });

  it("acknowledges the exact failed result without changing its failure state", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "acknowledge-failed-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [channelRecord({
        channel: "feishu", kind: "user", direction: "inbound",
        external_id: "oc_ack_failed:task-1", occurred_at: "2026-08-25T00:00:00.000Z",
        actor_id: "u1", scope_id: "oc_ack_failed", type: "text", text: "Review failure",
      })],
    });
    await seedHostedWork(authority, {
      workId: "work-ack-failed-1", runId: "run-ack-failed-1", recipeId: "recipe-ack-failed",
      threadId: "feishu:oc_ack_failed", eventId: ingested.records[0].event_id,
      status: "failed", writeBackRequired: false, resultSummary: "Execution failed",
    });
    const recipe = await authority.getRecipe("local-owner", "recipe-ack-failed");
    await authority.putRecipe({ ...recipe, enabled: false, updated_at: new Date().toISOString() });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const row = inbox.find((item) => item.thread_id === "feishu:oc_ack_failed");
      assert.equal(row.work.status, "failed");
      assert.equal(row.work.run_id, "run-ack-failed-1");
      const command = {
        run_id: "run-ack-failed-1",
        expected_version: row.work.version,
        expected_run_version: row.work.run_version,
        command_id: "ack-failed-command-1",
        issued_at: new Date().toISOString(),
      };
      const request = () => fetch(`${origin}/v1/me/work-items/work-ack-failed-1/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      const response = await request();
      assert.equal(response.status, 201, await response.clone().text());
      const acknowledged = await response.json();
      assert.equal(acknowledged.work_item.status, "failed");
      assert.equal(acknowledged.work_item.acknowledged_run_id, "run-ack-failed-1");
      const replayed = await request();
      assert.equal(replayed.status, 201);
      assert.equal((await replayed.json()).work_item.acknowledged_run_id, "run-ack-failed-1");
    } finally {
      await app.close();
    }
    const verification = new SqliteAuthorityStore(database);
    try {
      assert.equal(
        (await verification.getDisposition(ingested.records[0].event_id)).disposition,
        "outside_current_work",
      );
      const item = await verification.getWorkItem("local-owner", "work-ack-failed-1");
      assert.equal(item.status, "failed");
      assert.equal(item.acknowledged_run_id, "run-ack-failed-1");
    } finally {
      verification.close();
    }
  });

  it("allows an explicit run after acknowledging a failure and clears the old acknowledgment", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const authority = new SqliteAuthorityStore(database);
    const event = await authority.getEvent("local-owner", eventId);
    const itemId = "work-ack-failed-manual-retry";
    const oldRunId = "run-ack-failed-manual-retry";
    await seedHostedWork(authority, {
      workId: itemId, runId: oldRunId, recipeId: "recipe-ack-failed-manual-retry",
      threadId: event.thread_id, eventId, status: "failed",
      writeBackRequired: false, resultSummary: "Reviewed failure",
    });
    const recipe = await authority.getRecipe("local-owner", "recipe-ack-failed-manual-retry");
    await authority.putRecipe({
      ...recipe,
      enabled: false,
      can_write_back: false,
      executor_config: { instruction: "Retry the reviewed failure." },
      updated_at: new Date().toISOString(),
    });
    const item = await authority.getWorkItem("local-owner", itemId);
    const oldRun = await authority.getWorkRun("local-owner", oldRunId);
    authority.close();

    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const connector = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      assert.equal(connector.status, 201, await connector.clone().text());

      const acknowledgmentCommand = {
        run_id: oldRunId,
        expected_version: item.version,
        expected_run_version: oldRun.version,
        command_id: "ack-failed-manual-retry",
        issued_at: new Date().toISOString(),
      };
      const acknowledge = () => fetch(`${origin}/v1/me/work-items/${itemId}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(acknowledgmentCommand),
      });
      const acknowledgment = await acknowledge();
      const acknowledged = await acknowledgment.json();
      assert.equal(acknowledgment.status, 201, JSON.stringify(acknowledged));
      assert.equal(acknowledged.work_item.acknowledged_run_id, oldRunId);

      const command = {
        expected_version: acknowledged.work_item.version,
        command_id: "start-after-ack-failed-run",
        issued_at: new Date().toISOString(),
      };
      const start = () => fetch(`${origin}/v1/me/work-items/${itemId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      const startedResponse = await start();
      const started = await startedResponse.json();
      assert.equal(startedResponse.status, 201, JSON.stringify(started));
      assert.notEqual(started.run.id, oldRunId);
      assert.equal(started.work_item.acknowledged_run_id, undefined);
      assert.equal(dsh.created.length, 1);

      const replayResponse = await start();
      const replay = await replayResponse.json();
      assert.equal(replayResponse.status, 201, JSON.stringify(replay));
      assert.equal(replay.run.id, started.run.id);
      assert.equal(dsh.created.length, 1, "Replaying the command must not start another DSH session");

      const acknowledgmentReplay = await acknowledge();
      const replayedAcknowledgment = await acknowledgmentReplay.json();
      assert.equal(acknowledgmentReplay.status, 201, JSON.stringify(replayedAcknowledgment));
      assert.equal(replayedAcknowledgment.work_item.acknowledged_run_id, oldRunId);

      const verification = new SqliteAuthorityStore(database);
      try {
        const current = await verification.getWorkItem("local-owner", itemId);
        assert.equal(current.status, "running");
        assert.equal(current.current_run_id, started.run.id);
        assert.equal(current.acknowledged_run_id, undefined);
        assert.equal((await verification.getDisposition(eventId)).disposition, "current_work");
        assert.deepEqual(await verification.getWorkRun("local-owner", oldRunId), oldRun);
        assert.equal((await verification.listWorkRuns("local-owner", itemId)).length, 2);
        assert.equal(await verification.getWorkDeliveryByItem("local-owner", itemId), null);
      } finally {
        verification.close();
      }
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  for (const first of ["acknowledgment", "retry"]) {
    it(`fences failed-result acknowledgment at the HTTP boundary when ${first} wins automatic retry`, {
      timeout: 45_000,
    }, async (t) => {
      const root = await createRoot();
      const database = join(root, "authority.db");
      const blobRoot = join(root, "blobs");
      const orgId = "local-owner";
      let workId;
      const executorType = "lifecycle-http-test";
      const seededAt = "2026-08-25T00:00:00.000Z";
      const seed = new SqliteAuthorityStore(database);
      let failedItem;
      let failedRun;
      try {
        const ingestion = new IngestionService(new FsBlobStore(blobRoot), seed);
        const ingested = await ingestion.ingest({
          schema_version: INGEST_SCHEMA_VERSION, connector_id: "lifecycle-test", org_id: orgId,
          delivery_id: "api-retry-race", received_at: seededAt,
          records: [channelRecord({
            channel: "lifecycle-test", kind: "user", direction: "inbound",
            external_id: "retry-race:task", scope_id: "retry-race", actor_id: "test-user",
            occurred_at: seededAt, type: "task", text: "Review the failed execution",
          })],
        });
        const event = await seed.getEvent(orgId, ingested.records[0].event_id);
        await seed.putRecipe({
          id: "recipe-api-retry-race", org_id: orgId, name: "Retry acceptance",
          match: { record_class: "task" }, trigger: { kind: "push" },
          executor_type: executorType, executor_config: {}, include_context: false,
          can_write_back: false, enabled: false, created_at: seededAt, updated_at: seededAt,
        });
        const recipe = await seed.getRecipe(orgId, "recipe-api-retry-race");
        const observed = await seed.getWorkItemByThread(orgId, event.thread_id);
        assert.equal(observed.head_event_id, event.id);
        workId = observed.id;
        const bound = await seed.observeWorkItem({
          expected_item: observed,
          item: { ...observed, recipe_id: recipe.id, updated_at: seededAt },
        });
        assert.equal(bound.outcome, "applied");
        const run = {
          id: "run-api-original-failure", org_id: orgId, work_item_id: workId,
          recipe_id: recipe.id, executor_type: executorType, status: "running",
          start_state: "pending", write_back_required: false, trigger_kind: "push",
          created_at: seededAt, updated_at: seededAt,
        };
        assert.equal(await seed.claimWorkRunStart({ run }), true);
        const submitted = await seed.checkpointWorkRunStart({
          expected_item: await seed.getWorkItem(orgId, workId),
          expected_run: await seed.getWorkRun(orgId, run.id),
          kind: "submitted", external_run_id: "original-failed-execution", now: seededAt,
        });
        assert.equal(submitted.outcome, "applied");
        const failed = await seed.commitWorkObservation({
          expected_item: submitted.item, expected_run: submitted.run,
          handle: {
            external_run_id: "original-failed-execution", status: "failed",
            result: { summary: "Execution failed" },
          },
          can_write_back: false, trigger_kind: "push", now: seededAt,
        });
        assert.equal(failed.outcome, "applied");
        failedItem = failed.transition.item;
        failedRun = failed.transition.run;
      } finally {
        seed.close();
      }

      const { app, origin } = await startPersonalApi(database, blobRoot);
      const reached = Promise.withResolvers();
      const released = Promise.withResolvers();
      const submissions = [];
      let scheduled;
      const executorServer = createServer(async (request, response) => {
        if (request.method === "POST" && request.url === "/v1/runs") {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          submissions.push({ body: JSON.parse(raw), key: request.headers["idempotency-key"] });
          if (first === "retry") {
            reached.resolve();
            await released.promise;
          }
        } else if (request.method !== "GET" || request.url !== "/v1/runs/retried-execution") {
          response.writeHead(404);
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ external_run_id: "retried-execution", status: "running" }));
      });
      t.after(async () => {
        await new Promise((resolve, reject) => executorServer.close((error) => error ? reject(error) : resolve()));
      });
      try {
        const listening = once(executorServer, "listening");
        executorServer.listen(0, "127.0.0.1");
        await listening;
        const work = app.get(PersonalWorkService);
        await work.pauseForMaintenance();
        work.stopBackground();
        const host = app.get(PersonalRuntimeService).requireHost();
        const authority = host.get("authority");
        const installedResponse = await fetch(`${origin}/v1/me/executors`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "http", name: "Lifecycle acceptance",
            config: { base_url: `http://127.0.0.1:${executorServer.address().port}` },
          }),
        });
        const installed = await installedResponse.json();
        assert.equal(installedResponse.status, 201, JSON.stringify(installed));
        const recipe = await authority.getRecipe(orgId, failedItem.recipe_id);
        await authority.putRecipe({
          ...recipe, executor_type: installed.id, enabled: true, updated_at: new Date().toISOString(),
        });
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        const row = inbox.find((entry) => entry.thread_id === failedItem.thread_id);
        assert.equal(row.work.run_id, failedRun.id);
        const command = {
          run_id: row.work.run_id, expected_version: row.work.version,
          expected_run_version: row.work.run_version,
          command_id: "ack-api-retry-race", issued_at: new Date().toISOString(),
        };
        const acknowledge = () => fetch(`${origin}/v1/me/work-items/${workId}/acknowledge`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
        });
        if (first === "acknowledgment") {
          const claim = authority.claimWorkRunStart.bind(authority);
          t.mock.method(authority, "claimWorkRunStart", async (input) => {
            assert.equal(input.retry, "automatic");
            reached.resolve();
            await released.promise;
            return claim(input);
          });
        }
        scheduled = work.dispatch.fillOpenSlots();
        await Promise.race([
          reached.promise,
          scheduled.then(() => { throw new Error("Automatic retry did not reach its acceptance barrier"); }),
        ]);
        const response = await acknowledge();
        const body = await response.json();
        assert.equal(response.status, first === "acknowledgment" ? 201 : 409, JSON.stringify(body));
        if (first === "acknowledgment") {
          assert.equal(body.work_item.acknowledged_run_id, failedRun.id);
          assert.equal(submissions.length, 0);
        } else {
          assert.equal(body.error.code, "work_acknowledgment_conflict");
          assert.match(body.error.message, /stale_result/);
          const pending = await authority.getActiveWorkRun(orgId, workId);
          assert.equal(pending.start_state, "pending");
          assert.notEqual(pending.id, failedRun.id);
        }
        released.resolve();
        await scheduled;
        const current = await authority.getWorkItem(orgId, workId);
        assert.equal(current.version, failedItem.version + 1);
        assert.equal(current.status, first === "acknowledgment" ? "failed" : "running");
        assert.equal(current.acknowledged_run_id, first === "acknowledgment" ? failedRun.id : undefined);
        assert.deepEqual(await authority.getWorkRun(orgId, failedRun.id), failedRun);
        const replay = await acknowledge();
        assert.equal(replay.status, response.status);
        await work.dispatch.fillOpenSlots();
        assert.equal(submissions.length, first === "acknowledgment" ? 0 : 1);
        assert.equal((await authority.listWorkRuns(orgId, workId)).length, first === "acknowledgment" ? 1 : 2);
        assert.equal(await authority.getWorkDeliveryByItem(orgId, workId), null);
        assert.equal((await authority.getDisposition(failedItem.head_event_id)).disposition,
          first === "acknowledgment" ? "outside_current_work" : "current_work");
        const refreshed = await (await fetch(`${origin}/v1/me/inbox`)).json();
        const pending = refreshed.find((entry) => entry.thread_id === failedItem.thread_id);
        if (first === "acknowledgment") {
          assert.equal(pending, undefined);
        } else {
          const active = await authority.getActiveWorkRun(orgId, workId);
          assert.equal(active.external_run_id, "retried-execution");
          assert.equal(submissions[0].body.run_id, active.id);
          assert.equal(submissions[0].body.work_item_id, workId);
          assert.equal(submissions[0].key, active.id);
          assert.equal(pending.work.run_id, active.id);
          assert.equal(pending.work.status, "running");
        }
      } finally {
        released.resolve();
        try {
          if (scheduled) await scheduled;
        } finally {
          await app.close();
        }
      }
    });
  }

  it("blocks retry of ignored work while its previous execution remains active", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "leftover-run",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_leftover:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_leftover",
          type: "text",
          text: "Approve leftover",
        }),
      ],
    });
    await seedHostedWork(authority, {
      workId: "work-leftover-1",
      runId: "run-leftover-1",
      recipeId: "recipe-leftover",
      threadId: "feishu:oc_leftover",
      eventId: ingested.records[0].event_id,
      status: "skipped",
    });
    const recipe = await authority.getRecipe("local-owner", "recipe-leftover");
    await authority.putRecipe({ ...recipe, enabled: false, can_write_back: false });
    const originalRun = await authority.getWorkRun("local-owner", "run-leftover-1");
    const originalItem = await authority.getWorkItem("local-owner", "work-leftover-1");
    authority.close();
    const dsh = await startDshWebStub({ dropCreateResponse: true });
    // Dismissal already queued a cancellation job. Leave that worker off so
    // this request still sees the previous execution as active.
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_START_BACKGROUND: "0",
    });
    try {
      const missingVersion = await fetch(`${origin}/v1/me/work-items/work-leftover-1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(missingVersion.status, 400);
      const missingCommand = await fetch(`${origin}/v1/me/work-items/work-leftover-1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: originalItem.version }),
      });
      assert.equal(missingCommand.status, 400);
      assert.match(await missingCommand.text(), /invalid_command/);
      const staleVersion = await fetch(`${origin}/v1/me/work-items/work-leftover-1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: originalItem.version - 1,
          command_id: `stale-start-${Date.now()}`,
          issued_at: new Date().toISOString(),
        }),
      });
      assert.equal(staleVersion.status, 409);
      assert.match(await staleVersion.text(), /work_start_conflict/);
      const connector = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      assert.equal(connector.status, 201);
      const started = await fetch(`${origin}/v1/me/work-items/work-leftover-1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: originalItem.version,
          command_id: `blocked-start-${Date.now()}`,
          issued_at: new Date().toISOString(),
        }),
      });
      assert.equal(started.status, 409);
      assert.match(await started.text(), /execution_start_conflict/);
      assert.equal(dsh.created.length, 0);
    } finally {
      delete process.env.REGENIC_START_BACKGROUND;
      await app.close();
      await dsh.close();
    }
    const store = new SqliteAuthorityStore(database);
    try {
      const leftover = await store.getWorkRun("local-owner", "run-leftover-1");
      assert.deepEqual(
        { ...leftover, updated_at: originalRun.updated_at, version: originalRun.version },
        originalRun,
      );
      assert.ok(leftover.version >= originalRun.version);
      assert.ok(Date.parse(leftover.updated_at) >= Date.parse(originalRun.updated_at));
      const item = await store.getWorkItem("local-owner", "work-leftover-1");
      assert.deepEqual(item, originalItem);
      const active = await store.getActiveWorkRun("local-owner", item.id);
      assert.equal(active.id, leftover.id);
      assert.equal((await store.listWorkRuns("local-owner", item.id)).length, 1);
    } finally {
      store.close();
    }
  });

  it("binds a recipe, remembers inbox sort, and exposes executor catalog", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const installed = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      assert.equal(installed.status, 201);
      const executors = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(executors.length, 1);
      assert.equal(executors[0].executor_type, "dsh");
      assert.equal(executors[0].source, "dsh");
      assert.equal(executors[0].attach, "absentee");
      assert.equal(executors[0].fields[0].key, "skill");
      assert.equal(executors[0].fields.some((field) => field.key === "prompt"), false);
      const missingInstruction = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "Missing instruction",
          match: { record_class: "task", source: "feishu" },
          executor_type: "dsh",
        }),
      });
      assert.equal(missingInstruction.status, 400);
      for (const executor_config of [
        { prompt: "   " },
        { instruction: "" },
      ]) {
        const blankInstruction = await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "Blank instruction",
            match: { record_class: "task", source: "feishu" },
            executor_type: "dsh",
            executor_config,
          }),
        });
        assert.equal(blankInstruction.status, 400);
      }
      const emptyMatch = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "Too broad",
          match: {},
          executor_type: "dsh",
        }),
      });
      assert.equal(emptyMatch.status, 400);
      const sourceOnly = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "All chat",
          match: { source: "feishu" },
          executor_type: "dsh",
        }),
      });
      assert.equal(sourceOnly.status, 400);
      for (const key of ["text_contains", "text_excludes"]) {
        for (const value of [42, null, "", "   "]) {
          const invalidFilter = await fetch(`${origin}/v1/me/flows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: flowJson({
              name: "Invalid filter",
              match: { record_class: "task", [key]: value },
              executor_type: "dsh",
            }),
          });
          assert.equal(invalidFilter.status, 400);
        }
      }
      const invalidWriteBackDestination = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "Invalid destination",
          match: { record_class: "task", source: "feishu" },
          executor_type: "dsh",
          write_back_thread_id: "not-a-conversation",
        }),
      });
      assert.equal(invalidWriteBackDestination.status, 400);
      for (const destination of ["unknown:results", "feishu:oc_results"]) {
        const unavailable = await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "Unavailable destination",
            match: { thread_id: "feishu:oc_chat" },
            executor_type: "dsh",
            executor_config: { prompt: "Handle the task." },
            can_write_back: true,
            write_back_thread_id: destination,
          }),
        });
        assert.equal(unavailable.status, 400);
        assert.match((await unavailable.json()).error.message, /Write-back destination is unavailable/);
      }
      const missingComplete = await fetch(
        `${origin}/v1/me/work-items/work-missing/complete`,
        { method: "POST" },
      );
      assert.equal(missingComplete.status, 404);
      const missingDismiss = await fetch(
        `${origin}/v1/me/work-items/work-missing/dismiss`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      assert.equal(missingDismiss.status, 404);
      const created = await (
        await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "Feishu tasks",
            match: { record_class: "task", source: "feishu", text_contains: "confirm", text_excludes: "draft" },
            executor_type: "dsh",
            executor_config: { skill: "review", prompt: "Reply with a decision." },
            can_write_back: true,
            write_back_thread_id: "dsh:results",
            include_context: true,
          }),
        })
      ).json();
      assert.equal(created.config.handler.executor_type, "dsh");
      assert.equal(created.config.destination.send, true);
      assert.equal(created.config.destination.thread, "dsh:results");
      assert.equal(created.config.include_context, true);
      assert.equal(created.config.trigger.kind, "push");
      assert.equal(created.config.trigger.coalesce, true);
      assert.equal(created.config.scope.match.text_contains, "confirm");
      assert.equal(created.config.scope.match.text_excludes, "draft");
      assert.equal(created.config.handler.params.skill, "review");
      const clearTaskInstruction = await fetch(
        `${origin}/v1/me/flows/${created.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: {
              ...created.config,
              handler: {
                ...created.config.handler,
                task: "   ",
                params: { skill: "review", prompt: "   " },
              },
            },
          }),
        },
      );
      assert.equal(clearTaskInstruction.status, 400);
      const typed = await (
        await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "CRM order review",
            match: { unit_kind: "crm.order_review" },
            executor_type: "dsh",
            executor_config: { instruction: "Review the order." },
          }),
        })
      ).json();
      assert.equal(typed.config.scope.match.unit_kind, "crm.order_review");
      assert.equal(typed.config.trigger.kind, "push");
      const pullAppResponse = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "Morning digest",
          match: { source: "feishu" },
          trigger: { kind: "pull", interval_ms: 3_600_000 },
          executor_type: "dsh",
          executor_config: { prompt: "Summarize updates." },
          write_back_thread_id: "dsh:results",
        }),
      });
      const pullApp = await pullAppResponse.json();
      assert.equal(pullAppResponse.status, 201, JSON.stringify(pullApp));
      assert.deepEqual(pullApp.config.scope.match, { source: "feishu" });
      assert.equal(pullApp.config.trigger.kind, "pull");
      const pullTasks = await (
        await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "Morning tasks",
            match: { record_class: "task" },
            trigger: { kind: "pull", interval_ms: 3_600_000 },
            executor_type: "dsh",
            executor_config: { prompt: "Summarize updates." },
            write_back_thread_id: "dsh:results",
          }),
        })
      ).json();
      assert.equal(pullTasks.config.scope.match.record_class, "task");
      assert.equal(pullTasks.config.scope.match.thread_id, undefined);
      assert.equal(pullTasks.config.trigger.kind, "pull");
      const pulled = await (
        await fetch(`${origin}/v1/me/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: flowJson({
            name: "Morning digest",
            match: { thread_id: "feishu:oc_chat" },
            trigger: { kind: "pull", interval_ms: 3_600_000 },
            executor_type: "dsh",
            executor_config: { prompt: "Summarize updates." },
            write_back_thread_id: "dsh:results",
          }),
        })
      ).json();
      assert.equal(pulled.config.trigger.kind, "pull");
      assert.equal(pulled.config.trigger.interval_ms, 3_600_000);
      assert.equal(pulled.config.destination.send, true);
      assert.equal(pulled.config.include_context, true);
      assert.ok(pulled.next_run_at);
      assert.equal(created.config.handler.params.prompt, "Reply with a decision.");
      const recipes = await (await fetch(`${origin}/v1/me/flows`)).json();
      assert.equal(recipes.length, 5);
      const listed = recipes.find((recipe) => recipe.name === "Feishu tasks");
      assert.equal(listed.config.handler.params.prompt, "Reply with a decision.");
      assert.equal(listed.config.include_context, true);
      assert.equal(listed.config.destination.thread, "dsh:results");
      assert.equal(listed.config.scope.match.text_contains, "confirm");
      assert.equal(listed.config.scope.match.text_excludes, "draft");
      assert.equal(
        recipes.find((recipe) => recipe.name === "CRM order review")?.config.scope.match.unit_kind,
        "crm.order_review",
      );
      const renamed = await fetch(`${origin}/v1/me/flows/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed filtered rule" }),
      });
      assert.equal(renamed.status, 201);
      const renamedRule = await renamed.json();
      assert.deepEqual(renamedRule.config.scope.match, created.config.scope.match);
      assert.equal(renamedRule.config.destination.thread, "dsh:results");
      const cleared = await fetch(`${origin}/v1/me/flows/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            ...created.config,
            scope: { kind: "new_messages", match: { record_class: "task", source: "feishu" } },
          },
        }),
      });
      assert.equal(cleared.status, 201);
      assert.deepEqual((await cleared.json()).config.scope.match, { source: "feishu" });
      const clearedDestination = await fetch(`${origin}/v1/me/flows/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { ...created.config, destination: undefined },
        }),
      });
      assert.equal(clearedDestination.status, 201);
      assert.equal((await clearedDestination.json()).config.destination, undefined);
      const afterClear = await (await fetch(`${origin}/v1/me/flows`)).json();
      assert.equal(afterClear.find((recipe) => recipe.id === created.id).config.destination, undefined);
      assert.equal(afterClear.find((recipe) => recipe.id === pulled.id).config.destination.thread, "dsh:results");
      const prefs = await (
        await fetch(`${origin}/v1/me/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inbox_sort: "attention" }),
        })
      ).json();
      assert.equal(prefs.inbox_sort, "attention");
      const remembered = await (await fetch(`${origin}/v1/me/prefs`)).json();
      assert.equal(remembered.inbox_sort, "attention");
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.ok(inbox[0].record_class);
      assert.ok(inbox[0].thread_facet);
      assert.ok(inbox[0].attention);
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("installs HTTP and local executors and seeds the default DSH binding", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(engine.executor_catalog.length, 2);
      assert.equal(engine.executor_catalog[0].kind, "local_connector");
      assert.equal(engine.executor_catalog[1].kind, "http");
      assert.equal(engine.executor_installations.some((item) => item.id === "dsh"), false);

      const missingLocal = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "local_connector", config: {} }),
      });
      assert.equal(missingLocal.status, 400);

      const remote = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "http",
          name: "Remote agent",
          config: { base_url: "https://agent.example/exec/" },
        }),
      });
      const remoteBody = await remote.json();
      assert.equal(remote.status, 201, JSON.stringify(remoteBody));
      assert.equal(remoteBody.kind, "http");
      assert.equal(remoteBody.base_url, "https://agent.example/exec");

      const catalog = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(catalog.some((item) => item.executor_type === "dsh"), false);
      assert.equal(
        catalog.some((item) => item.executor_type === remoteBody.id),
        true,
      );

      const disabled = await fetch(
        `${origin}/v1/me/executors/${remoteBody.id}/disable`,
        { method: "POST" },
      );
      assert.equal(disabled.status, 201);
      const afterDisable = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(
        afterDisable.some((item) => item.executor_type === remoteBody.id),
        false,
      );

      const connector = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: "http://127.0.0.1:3080" },
        }),
      });
      const connectorBody = await connector.json();
      assert.equal(connector.status, 201, JSON.stringify(connectorBody));

      const local = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "local_connector",
          name: "Office DSH",
          config: { installation_id: connectorBody.id },
        }),
      });
      const localBody = await local.json();
      assert.equal(local.status, 201, JSON.stringify(localBody));
      assert.equal(localBody.kind, "local_connector");
      assert.equal(localBody.connector_id, connectorBody.id);

      const recipe = await fetch(`${origin}/v1/me/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flowJson({
          name: "Pinned local",
          match: { record_class: "task", source: "feishu" },
          executor_type: localBody.id,
          executor_config: { prompt: "Review the task." },
        }),
      });
      const recipeBody = await recipe.json();
      assert.equal(recipe.status, 201, JSON.stringify(recipeBody));
      assert.equal(recipeBody.config.handler.executor_type, localBody.id);
    } finally {
      await app.close();
    }
  });
});
