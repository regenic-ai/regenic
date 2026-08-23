const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  connectorCatalog,
  toInstallationView,
} = require("../dist/personal-connector-view");

describe("connector catalog hints", () => {
  it("uses a service hint when lark-cli is missing or signed out", () => {
    const missing = connectorCatalog([], {
      env: {},
      services: {
        "lark-cli": {
          ready: false,
          hint: "Not installed. Run: npx @larksuite/cli@latest install. Docs: https://github.com/larksuite/cli",
        },
      },
    });
    const feishu = missing.find((item) => item.connector_type === "feishu-chat");
    assert.equal(feishu.setup_ready, false);
    assert.match(feishu.prerequisites[0].hint, /npx @larksuite\/cli@latest install/);

    const signedOut = connectorCatalog([], {
      env: {},
      services: {
        "lark-cli": {
          ready: false,
          hint: "Installed, not signed in. Run: lark-cli config init && lark-cli auth login --recommend. Tokens stay in the OS keychain.",
        },
      },
    });
    assert.match(
      signedOut.find((item) => item.connector_type === "feishu-chat").prerequisites[0].hint,
      /auth login --recommend/,
    );
  });

  it("lists DSH web and CLI service prerequisites from the catalog", () => {
    const slack = connectorCatalog([], { env: {} }).find(
      (item) => item.connector_type === "slack-channel",
    );
    assert.match(slack.prerequisites[0].hint, /REGENIC_SLACK_TOKEN/);
    assert.equal(slack.setup_ready, false);
    const dsh = connectorCatalog([], { env: {} }).find(
      (item) => item.connector_type === "dsh-session",
    );
    assert.deepEqual(
      dsh.prerequisites.map((item) => item.key),
      ["dsh-web", "dsh-cli", "REGENIC_DSH_TOKEN"],
    );
    assert.equal(dsh.prerequisites[1].visible_when.value, "cli");
  });

  it("fills Feishu conversation options for a pick list", () => {
    const catalog = connectorCatalog([], {
      env: {},
      field_options: {
        "feishu-chat": {
          chat_ids: [{ value: "oc_1", label: "Group · Bioby.ai" }],
        },
      },
    });
    const feishu = catalog.find((item) => item.connector_type === "feishu-chat");
    assert.equal(feishu.fields[0].key, "selection");
    assert.equal(feishu.fields[1].key, "kinds");
    assert.equal(feishu.fields[1].default, "group,p2p");
    assert.equal(feishu.fields[2].multiple, true);
    assert.deepEqual(feishu.fields[2].options, [
      { value: "oc_1", label: "Group · Bioby.ai" },
    ]);
  });

  it("labels a Feishu install as all conversations by default", () => {
    const view = toInstallationView(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all", kinds: ["group", "p2p"] },
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      },
      null,
      {
        get() {
          return {
            capabilities() {
              return { sync: true, reply: true, create: false };
            },
          };
        },
      },
    );
    assert.equal(view.label, "All conversations");
    assert.equal(view.settings.kinds, "group,p2p");
  });
});
