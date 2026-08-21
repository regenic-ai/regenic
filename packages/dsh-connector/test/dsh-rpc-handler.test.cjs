const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
} = require("@regenic/domain");
const {
  DshCliSessionClient,
  DshSessionPollConnector,
  MemoryDshRunLog,
  handleDshPublicRpc,
} = require("../dist");

function services(overrides = {}) {
  return {
    async listSessions() {
      return [{ sessionId: "dsh-main", status: "enabled", installationId: "dsh-1" }];
    },
    async receive(sessionId) {
      return {
        events: [
          {
            type: "user/message",
            seq: 0,
            time: 1_724_208_000_000,
            actor_id: "user",
            data: { content: [{ type: "text", text: sessionId }] },
          },
        ],
        hasMore: false,
      };
    },
    async send() {
      return { accepted: true };
    },
    ...overrides,
  };
}

describe("handleDshPublicRpc", () => {
  it("rejects a missing JSON content type with 415", async () => {
    const result = await handleDshPublicRpc(
      "session.list",
      { contentType: "text/plain", body: {} },
      services(),
    );
    assert.equal(result.status, 415);
    assert.equal(result.body.error.code, "unsupported_media_type");
  });

  it("echoes rpcId for session.list", async () => {
    const result = await handleDshPublicRpc(
      "session.list",
      {
        contentType: "application/json",
        body: { type: "client-request", rpcId: "rpc-list", method: "session.list", payload: {} },
      },
      services(),
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.rpcId, "rpc-list");
    assert.equal(result.body.result.value.items[0].sessionId, "dsh-main");
  });

  it("returns bad-request when rpcId is missing", async () => {
    const result = await handleDshPublicRpc(
      "session.history",
      {
        contentType: "application/json; charset=utf-8",
        body: { type: "client-request", method: "session.history", payload: {} },
      },
      services(),
    );
    assert.equal(result.body.result.error.code, "bad-request");
  });

  it("receives through session.history and ingests the journal page", async () => {
    const connector = new DshSessionPollConnector(
      new DshCliSessionClient(new MemoryDshRunLog([{
        run_id: "run-1",
        seq: 0,
        task: "Hello",
        stdout: "Hi",
        started_at: "2026-08-21T00:00:00.000Z",
        finished_at: "2026-08-21T00:00:01.000Z",
      }])),
      {
        connector_id: "dsh-1",
        org_id: "local-owner",
        session_id: "dsh-main",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );
    const authority = new MemoryAuthorityStore();
    const runtime = new MemoryConnectorRuntimeStore();
    await runtime.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), authority),
      runtime,
      () => "2026-08-21T00:00:00.000Z",
    );

    const result = await handleDshPublicRpc(
      "session.history",
      {
        contentType: "application/json",
        body: {
          type: "client-request",
          rpcId: "rpc-hist",
          method: "session.history",
          payload: { sessionId: "dsh-main" },
        },
      },
      {
        async listSessions() {
          return [];
        },
        async receive() {
          const run = await runner.poll({
            installation_id: "dsh-1",
            stream_key: "session:dsh-main",
            lease_owner: "api",
            lease_duration_ms: 30_000,
          });
          assert.equal(run.status, "completed");
          return connector.lastSurfacePage;
        },
        async send() {
          return { accepted: true };
        },
      },
    );

    assert.equal(result.body.result.ok, true);
    assert.equal(result.body.result.value.events[0].seq, 0);
    assert.equal((await authority.listEvents("local-owner")).length, 2);
  });

  it("sends through session.prompt without touching the store", async () => {
    const sent = [];
    const authority = new MemoryAuthorityStore();
    const result = await handleDshPublicRpc(
      "session.prompt",
      {
        contentType: "application/json",
        body: {
          type: "client-request",
          rpcId: "rpc-send",
          method: "session.prompt",
          payload: {
            sessionId: "dsh-main",
            mode: "queue",
            content: [{ type: "text", text: "Follow up" }],
          },
        },
      },
      services({
        async send(sessionId, text) {
          sent.push({ sessionId, text });
          return { accepted: true };
        },
      }),
    );
    assert.deepEqual(sent, [{ sessionId: "dsh-main", text: "Follow up" }]);
    assert.deepEqual(result.body.result.value, { accepted: true });
    assert.deepEqual(await authority.listEvents("local-owner"), []);
  });
});
