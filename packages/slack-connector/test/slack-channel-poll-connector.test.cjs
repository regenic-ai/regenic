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
  SlackApiError,
  SlackChannelPollConnector,
  SlackWebApiHistoryClient,
} = require("../dist");

function createConnector(client) {
  return new SlackChannelPollConnector(client, {
    connector_id: "slack-channel",
    org_id: "local-owner",
    channel_id: "C123",
    channel_name: "engineering",
    now: () => "2026-08-12T00:00:00.000Z",
  });
}

describe("SlackChannelPollConnector", () => {
  it("maps a Slack history page, threads, and its opaque next cursor", async () => {
    const calls = [];
    const connector = createConnector({
      async conversationsHistory(input) {
        calls.push(input);
        return {
          ok: true,
          messages: [
            { ts: "1723420800.000001", user: "U123", text: "Root" },
            {
              ts: "1723420860.000001",
              user: "U456",
              text: "Reply",
              thread_ts: "1723420800.000001",
            },
          ],
          response_metadata: { next_cursor: "opaque-next" },
        };
      },
    });

    const result = await connector.poll({ value: "opaque-current" });

    assert.deepEqual(calls, [
      { channel: "C123", cursor: "opaque-current", limit: 100 },
    ]);
    assert.equal(result.next_cursor, "opaque-next");
    assert.equal(result.batch.records[0].external_id, "C123:1723420800.000001");
    assert.equal(result.batch.records[1].type, "thread_reply");
    assert.equal(result.batch.records[1].parent_external_id, "C123:1723420800.000001");
    assert.equal(result.batch.records[1].scope.name, "engineering");
  });

  it("settles a Slack page through the shared connector runtime", async () => {
    const connector = createConnector({
      async conversationsHistory() {
        return {
          ok: true,
          messages: [{ ts: "1723420800.000001", user: "U123", text: "Message" }],
          response_metadata: { next_cursor: "cursor-2" },
        };
      },
    });
    const runtime = new MemoryConnectorRuntimeStore();
    await runtime.createInstallation({
      id: "slack-installation",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123" },
      created_at: "2026-08-12T00:00:00.000Z",
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), new MemoryAuthorityStore()),
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    const run = await runner.poll({
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

  it("raises a named error when Slack rejects conversations.history", async () => {
    const connector = createConnector({
      async conversationsHistory() {
        return { ok: false, error: "ratelimited" };
      },
    });

    await assert.rejects(() => connector.poll(null), SlackApiError);
  });

  it("calls the Slack Web API with its bearer token and parses a history page", async () => {
    const requests = [];
    const client = new SlackWebApiHistoryClient({
      access_token: "test-token",
      endpoint: "https://slack.example/history",
      async fetch(url, init) {
        requests.push({ url, init });
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "Message" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });

    const page = await client.conversationsHistory({
      channel: "C123",
      cursor: "opaque-cursor",
      limit: 100,
    });

    assert.equal(
      requests[0].url,
      "https://slack.example/history?channel=C123&limit=100&cursor=opaque-cursor",
    );
    assert.deepEqual(requests[0].init.headers, {
      authorization: "Bearer test-token",
    });
    assert.equal(page.messages[0].text, "Message");
    assert.equal(page.response_metadata.next_cursor, "cursor-2");
  });
});