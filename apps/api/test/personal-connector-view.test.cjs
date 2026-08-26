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
    assert.equal(dsh.prerequisites[0].required, false);
  });

  it("does not block a DSH web install when dsh web is down", () => {
    const dsh = connectorCatalog([], {
      env: {},
      services: {
        "dsh-web": { ready: false, hint: "Start dsh web --port 3080 first." },
        "dsh-cli": { ready: true, hint: "dsh is on PATH." },
      },
    }).find((item) => item.connector_type === "dsh-session");
    assert.equal(dsh.prerequisites[0].ready, false);
    assert.equal(dsh.setup_ready, true);
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
            source: "feishu",
            capabilities() {
              return { sync: true, reply: true, create: false };
            },
          };
        },
      },
    );
    assert.equal(view.label, "All conversations");
    assert.equal(view.channel, "feishu");
    assert.equal(view.channel_label, "Feishu");
    assert.equal(view.settings.kinds, "group,p2p");
  });

  it("lists CRM catalog rows but keeps them blocked without the private plugin", () => {
    const catalog = connectorCatalog([], { env: {} });
    const ops = catalog.find((item) => item.connector_type === "crm-ops-review");
    const order = catalog.find((item) => item.connector_type === "crm-order-review");
    assert.equal(ops.title, "CRM ops review");
    assert.equal(order.title, "CRM order review");
    assert.equal(ops.setup_ready, false);
    assert.equal(order.setup_ready, false);
    assert.match(ops.prerequisites[0].hint, /cannot use CRM/);
  });

  it("marks CRM setup ready only when the private plugin and base URL are present", () => {
    const catalog = connectorCatalog([], {
      env: { REGENIC_CRM_BASE_URL: "https://crm.internal" },
      services: {
        "crm-connector": { ready: true, hint: "Private CRM connector is loaded." },
      },
    });
    const ops = catalog.find((item) => item.connector_type === "crm-ops-review");
    assert.equal(ops.setup_ready, true);
    assert.equal(ops.prerequisites[0].ready, true);
    assert.equal(ops.fields[0].key, "max_open_tasks");
  });

  it("labels a CRM ops install without branching inbox on source", () => {
    const view = toInstallationView(
      {
        id: "crm-1",
        org_id: "local-owner",
        connector_type: "crm-ops-review",
        status: "enabled",
        config: { max_open_tasks: "50" },
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
      null,
      {
        get() {
          return {
            source: "crm",
            capabilities() {
              return { sync: true, reply: false, create: false };
            },
          };
        },
      },
    );
    assert.equal(view.label, "Email submit review");
    assert.equal(view.channel, "crm");
    assert.equal(view.settings.max_open_tasks, "50");
  });
});
