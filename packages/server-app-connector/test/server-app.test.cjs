const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const {
  SERVER_APP_SOURCE,
  serverAppDriver,
} = require("../dist/index.js");

test("discovers, connects, pulls and executes through one installation", async (t) => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    received.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/.well-known/regenic") {
      return response.end(JSON.stringify({
        protocol: "1.0",
        app_id: "acme.support",
        name: "Acme Support",
        capabilities: {
          source: { push: true, pull: true, reply: true, create: true },
          agent: true,
        },
      }));
    }
    if (request.url === "/v1/regenic/connections") {
      return response.end(JSON.stringify({
        protocol: "1.0",
        connection_id: "remote-connection",
      }));
    }
    if (request.url === "/v1/regenic/invoke") {
      const result = body.kind === "create"
        ? { target: "created:1" }
        : body.kind === "send"
          ? {
              accepted: true,
              rpc_id: "sent:1",
              channel_message_ids: ["message:sent:1"],
            }
          : body.kind === "resolve_streams"
        ? { streams: [{ stream_key: "chat:1", thread_id: "thread:1" }] }
        : body.kind === "poll"
          ? {
              batch: {
                schema_version: "1.0",
                connector_id: "remote",
                org_id: "remote",
                delivery_id: "delivery-1",
                received_at: "2026-01-01T00:00:01.000Z",
                records: [{
                  operation: "create",
                  source: "remote",
                  external_id: "message:1",
                  occurred_at: "2026-01-01T00:00:00.000Z",
                  actor: { id: "user:1" },
                  scope: { id: "chat:1" },
                  thread: { id: "thread:1" },
                  type: "message",
                  content: [{ role: "body", media_type: "text/plain", text: "hello" }],
                }],
              },
              poll_hint: { live_seeded: true, history_pending: false },
            }
          : { members: [], complete: true };
      return response.end(JSON.stringify({
        protocol: "1.0",
        request_id: body.context.request_id,
        ok: true,
        result,
      }));
    }
    if (request.url === "/v1/runs") {
      return response.end(JSON.stringify({
        external_run_id: "run-1",
        status: "running",
      }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const drafted = await serverAppDriver.install({
    id: "install-1",
    org_id: "org-1",
    config: { base_url: baseUrl, token: "server-token" },
    now: "2026-01-01T00:00:00.000Z",
  });
  const installation = {
    ...drafted,
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const host = fakeHost("server-token");
  const patch = await serverAppDriver.connectInstallation(
    installation,
    host,
    {},
    {
      ingest: {
        url: "http://127.0.0.1:4370/v1/me/connectors/install-1/ingest",
        header: "x-regenic-ingest-token",
        token: "ingest-token",
      },
    },
  );
  assert.deepEqual(patch, { connection_id: "remote-connection" });
  assert.equal(serverAppDriver.capabilities(installation).execute, true);
  assert.equal(installation.config.token, "server-token");

  const streams = await serverAppDriver.resolveStreams(
    installation,
    host,
    {},
    { discover: true },
  );
  assert.equal(streams[0].stream_key, "acme.support:install-1:chat:1");
  const polled = await streams[0].connector.poll(null, { latest: true });
  assert.equal(polled.batch.connector_id, "install-1");
  assert.equal(polled.batch.records[0].source, SERVER_APP_SOURCE);
  assert.equal(polled.batch.records[0].external_id, "acme.support:install-1:message:1");
  assert.equal(polled.batch.records[0].actor.id, "acme.support:install-1:user:1");
  assert.equal(polled.batch.records[0].thread.id, "acme.support:install-1:thread:1");

  const pushed = serverAppDriver.transformPushBatch(installation, {
    stream_key: "chat:1",
    batch_id: "push-1",
    events: [{
      operation: "create",
      source: "wrong-but-normalized",
      external_id: "message:2",
      occurred_at: "2026-01-01T00:00:00.000Z",
      actor: { id: "user:1" },
      scope: { id: "chat:1" },
      thread: { id: "thread:1" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "pushed" }],
    }],
  });
  assert.equal(pushed.stream_key, "acme.support:install-1:chat:1");
  assert.equal(pushed.events[0].source, SERVER_APP_SOURCE);
  assert.equal(
    pushed.events[0].external_id,
    "acme.support:install-1:message:2",
  );
  assert.equal(pushed.events[0].actor.id, "acme.support:install-1:user:1");

  const created = await serverAppDriver.createThread(
    installation,
    host,
    {},
    { text: "start" },
  );
  assert.deepEqual(created, {
    source: SERVER_APP_SOURCE,
    target: "acme.support:install-1:created:1",
  });
  const egress = await serverAppDriver.bindEgress(
    installation,
    { source: SERVER_APP_SOURCE, target: created.target },
    host,
    {},
  );
  const receipt = await egress.send({
    installation_id: installation.id,
    target: { scope_id: "acme.support:install-1:chat:1" },
    content: [{ role: "body", media_type: "text/plain", text: "reply" }],
  });
  assert.deepEqual(receipt.channel_message_ids, [
    "acme.support:install-1:message:sent:1",
  ]);

  const executor = await serverAppDriver.bindExecutor(installation, host, {});
  const run = await executor.start({
    run_id: "kernel-run",
    work_item: {
      id: "work-1",
      thread_id: "thread-1",
      record_class: "request",
      thread_facet: "conversation",
    },
    recipe: { id: "recipe-1", executor_config: {} },
    evidence_text: "evidence",
  }, { org_id: "org-1", env: {} });
  assert.equal(run.external_run_id, "run-1");
  assert.equal(
    received.find((entry) => entry.url === "/v1/regenic/connections")
      .body.ingest.token,
    "ingest-token",
  );
  assert.deepEqual(
    received.find((entry) => entry.url === "/v1/regenic/connections")
      .body.namespace,
    { source: "server_app", id_prefix: "acme.support:install-1:" },
  );
});

test("requires HTTPS for remote servers but permits loopback HTTP", async () => {
  await assert.rejects(
    serverAppDriver.install({
      id: "remote-http",
      org_id: "org-1",
      config: { base_url: "http://app.example.com", token: "secret" },
      now: "2026-01-01T00:00:00.000Z",
    }),
    /must use HTTPS/,
  );
  await assert.rejects(
    serverAppDriver.install({
      id: "prefixed-host",
      org_id: "org-1",
      config: { base_url: "http://127.example.com", token: "secret" },
      now: "2026-01-01T00:00:00.000Z",
    }),
    /must use HTTPS/,
  );
  await assert.rejects(
    serverAppDriver.install({
      id: "loopback-range",
      org_id: "org-1",
      config: { base_url: "http://127.0.0.2:9", token: "secret" },
      now: "2026-01-01T00:00:00.000Z",
    }),
    (error) => !/must use HTTPS/.test(String(error)),
  );
});

test("rejects an unreachable loopback callback for a remote push source", async () => {
  const installation = {
    id: "install-remote",
    org_id: "org-1",
    connector_type: "server-app",
    status: "enabled",
    config: {
      base_url: "https://app.example.com",
      app_id: "acme.remote",
      app_name: "Remote",
      manifest: {
        protocol: "1.0",
        app_id: "acme.remote",
        name: "Remote",
        capabilities: { source: { push: true } },
        endpoints: {
          connect: "/v1/regenic/connections",
          invoke: "/v1/regenic/invoke",
          runs: "/v1/runs",
        },
      },
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await assert.rejects(
    serverAppDriver.connectInstallation(installation, fakeHost("token"), {}, {
      ingest: {
        url: "http://127.0.0.1:4370/v1/me/connectors/install-remote/ingest",
        header: "x-regenic-ingest-token",
        token: "ingest-token",
      },
    }),
    /public_url_required/,
  );
});

test("agent thread prefix stays specific without an app id", () => {
  const installation = {
    id: "inst-1",
    org_id: "org",
    connector_type: "server-app",
    status: "enabled",
    config: {
      app_id: "demo",
      manifest: {
        protocol: "1.0",
        app_id: "demo",
        name: "Demo",
        capabilities: { agent: true },
      },
    },
    created_at: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(serverAppDriver.threadIdPrefix(installation), "server_app:demo:inst-1:");
  assert.equal(
    serverAppDriver.threadIdPrefix({ ...installation, config: {} }),
    "server_app::inst-1:",
  );
  assert.equal(serverAppDriver.threadIdPrefix({ ...installation, id: " " }), "");
  assert.equal(serverAppDriver.capabilities(installation).agent_sessions, true);
  assert.equal(serverAppDriver.capabilities({
    ...installation,
    config: {
      manifest: {
        protocol: "1.0",
        app_id: "notes",
        name: "Notes",
        capabilities: { source: { pull: true } },
      },
    },
  }).agent_sessions, false);
  assert.equal(serverAppDriver.capabilities({
    ...installation,
    config: { manifest: { capabilities: { agent: true } } },
  }).agent_sessions, true);
  assert.throws(() => serverAppDriver.capabilities({
    ...installation,
    config: { manifest: { capabilities: {} } },
  }));
});

function fakeHost(token) {
  return {
    get() {
      throw new Error("registry is not used by this test");
    },
    plugin() {
      throw new Error("plugins are not used by this test");
    },
    now() {
      return "2026-01-01T00:00:00.000Z";
    },
    secrets: {
      async read() {
        return token;
      },
      write() {},
    },
  };
}

async function readJson(request) {
  if (request.method === "GET") return null;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}
