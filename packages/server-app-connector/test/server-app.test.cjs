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
          source: { push: true, pull: true, reply: false, create: false },
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
      const result = body.kind === "resolve_streams"
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

  const streams = await serverAppDriver.resolveStreams(
    installation,
    host,
    {},
    { discover: true },
  );
  assert.equal(streams[0].stream_key, "acme.support:chat:1");
  const polled = await streams[0].connector.poll(null, { latest: true });
  assert.equal(polled.batch.connector_id, "install-1");
  assert.equal(polled.batch.records[0].source, SERVER_APP_SOURCE);
  assert.equal(polled.batch.records[0].external_id, "acme.support:message:1");
  assert.equal(polled.batch.records[0].thread.id, "acme.support:thread:1");

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
    { source: "server_app", id_prefix: "acme.support:" },
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
