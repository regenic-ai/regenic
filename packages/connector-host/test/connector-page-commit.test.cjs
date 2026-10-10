const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { CursorAgentPollConnector } = require("@regenic/cursor-connector");
const {
  ConnectorRunner,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  channelRecord,
} = require("@regenic/domain");
const {
  DshCliSessionClient,
  DshSessionPollConnector,
  MemoryDshRunLog,
} = require("@regenic/dsh-connector");
const { feishuChatDriver, FeishuChatPollConnector } = require("@regenic/feishu-connector");
const { SlackChannelPollConnector } = require("@regenic/slack-connector");

describe("connector pages commit through the host runtime", () => {
  it("settles a Feishu page and keeps the cursor", async () => {
    const connector = new FeishuChatPollConnector(
      {
        async listMessages() {
          return {
            items: [{
              message_id: "om_1",
              msg_type: "text",
              create_time: "1723420800000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: { content: JSON.stringify({ text: "Root" }) },
            }],
            has_more: false,
          };
        },
      },
      {
        connector_id: "feishu-chat",
        org_id: "local-owner",
        chat_id: "oc_1",
        chat_name: "engineering",
        now: () => "2026-08-12T00:00:00.000Z",
      },
    );
    const { runtime, store } = coupledStores();
    await runtime.createInstallation({
      id: "feishu-installation",
      org_id: "local-owner",
      connector_type: "feishu-chat",
      status: "enabled",
      config: { chat_id: "oc_1" },
      created_at: "2026-08-12T00:00:00.000Z",
    });
    const run = await new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), store),
      store,
      () => "2026-08-12T00:00:00.000Z",
    ).poll({
      installation_id: "feishu-installation",
      stream_key: "chat:oc_1",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    const cursor = await runtime.getCursor("feishu-installation", "chat:oc_1");

    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
    assert.equal(
      cursor.cursor,
      JSON.stringify({
        start_time: "1723420800",
        recent_seeded: true,
      }),
    );
  });

  it("settles a Slack page and keeps the cursor", async () => {
    const connector = new SlackChannelPollConnector(
      {
        async conversationsHistory() {
          return {
            ok: true,
            messages: [{ ts: "1723420800.000001", user: "U123", text: "Message" }],
            response_metadata: { next_cursor: "cursor-2" },
          };
        },
      },
      {
        connector_id: "slack-channel",
        org_id: "local-owner",
        channel_id: "C123",
        channel_name: "engineering",
        now: () => "2026-08-12T00:00:00.000Z",
      },
    );
    const { runtime, store } = coupledStores();
    await runtime.createInstallation({
      id: "slack-installation",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123" },
      created_at: "2026-08-12T00:00:00.000Z",
    });
    const run = await new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), store),
      store,
      () => "2026-08-12T00:00:00.000Z",
    ).poll({
      installation_id: "slack-installation",
      stream_key: "channel:C123",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    const cursor = await runtime.getCursor("slack-installation", "channel:C123");

    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
    assert.equal(cursor.cursor, "cursor-2");
  });

  it("settles a Cursor page", async () => {
    const connector = new CursorAgentPollConnector(
      {
        async getAgent() {
          return {
            id: "bc-1",
            name: "Add README",
            status: "IDLE",
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:05:00.000Z",
            latestRunId: "run-1",
          };
        },
        async getConversation() {
          return {
            id: "bc-1",
            messages: [
              { id: "msg-1", type: "user_message", text: "Add a README" },
              { id: "msg-2", type: "assistant_message", text: "Added README.md" },
            ],
          };
        },
      },
      {
        connector_id: "cursor-agent",
        org_id: "local-owner",
        agent_id: "bc-1",
        agent_name: "Add README",
        now: () => "2026-08-21T00:06:00.000Z",
      },
    );
    const { runtime, store } = coupledStores();
    await runtime.createInstallation({
      id: "cursor-installation",
      org_id: "local-owner",
      connector_type: "cursor-agent",
      status: "enabled",
      config: { agent_id: "bc-1" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const run = await new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), store),
      store,
      () => "2026-08-21T00:06:00.000Z",
    ).poll({
      installation_id: "cursor-installation",
      stream_key: "agent:bc-1",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
  });

  it("settles a DSH journal page and keeps the seq cursor", async () => {
    const connector = new DshSessionPollConnector(
      new DshCliSessionClient(new MemoryDshRunLog([{
        run_id: "run-0",
        seq: 0,
        task: "Hello",
        stdout: "Hi",
        started_at: "2026-08-21T00:00:00.000Z",
        finished_at: "2026-08-21T00:00:01.000Z",
      }])),
      {
        connector_id: "dsh-session",
        org_id: "local-owner",
        session_id: "dsh-main",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );
    const { runtime, store } = coupledStores();
    await runtime.createInstallation({
      id: "dsh-installation",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "cli", mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const settled = await new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), store),
      store,
      () => "2026-08-21T00:00:00.000Z",
    ).poll({
      installation_id: "dsh-installation",
      stream_key: "session:dsh-main",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    const cursor = await runtime.getCursor("dsh-installation", "session:dsh-main");

    assert.equal(settled.status, "completed");
    assert.equal(settled.result.records[0].status, "accepted");
    assert.equal(cursor.cursor, "1");
  });

  it("dedupes a split Feishu image echo against reply outbound ids", async () => {
    const authority = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authority);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const outboundId = feishuChatDriver.outboundId(
      { source: "feishu", target: "oc_1" },
      { accepted: true, rpc_id: "om_text" },
    );
    const outbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-out-reply",
      received_at: "2026-09-02T00:15:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: outboundId,
          occurred_at: "2026-09-02T00:15:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          text: "记得我这个小技巧会更符合写代码逻辑",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "tasks.png",
              bytes: png,
            },
          ],
        }),
      ],
    });
    const echoed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-sync-reply",
      received_at: "2026-09-02T00:15:02.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_text",
          occurred_at: "2026-09-02T00:15:00.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: "记得我这个小技巧会更符合写代码逻辑",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_image",
          occurred_at: "2026-09-02T00:15:01.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "image.png",
              bytes: png,
            },
          ],
        }),
      ],
    });

    assert.equal(outbound.records[0].status, "accepted");
    assert.equal(echoed.records[0].status, "duplicate");
    assert.equal(echoed.records[1].status, "duplicate");
    assert.equal(echoed.records[0].event_id, outbound.records[0].event_id);
    assert.equal(echoed.records[1].event_id, outbound.records[0].event_id);
    assert.equal(authority.allEvents().length, 1);
  });
});

function coupledStores() {
  const events = new MemoryAuthorityStore();
  const runtime = new MemoryConnectorRuntimeStore();
  const store = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === "commitSyncPage") {
        return async (input) => {
          const committed = await events.commitSyncPage(input);
          await runtime.commitSyncPage(input);
          return committed;
        };
      }
      const runtimeValue = runtime[prop];
      if (typeof runtimeValue === "function") {
        return runtimeValue.bind(runtime);
      }
      const eventValue = events[prop];
      if (typeof eventValue === "function") {
        return eventValue.bind(events);
      }
      return runtimeValue ?? eventValue;
    },
  });
  return { events, runtime, store };
}
