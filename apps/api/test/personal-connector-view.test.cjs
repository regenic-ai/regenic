const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { slackChannelDriver } = require("@regenic/slack-connector");
const { dshSessionDriver } = require("@regenic/dsh-connector");
const { feishuChatDriver } = require("@regenic/feishu-connector");
const { cursorAgentDriver } = require("@regenic/cursor-connector");
const {
  catalogFromDrivers,
  connectorAllowsMultiple,
  connectorCatalog,
  nextPickedChatNames,
  toInstallationView,
} = require("../dist/personal-connector-view");

function firstParty(env = {}) {
  return catalogFromDrivers(
    {
      list: () => [
        slackChannelDriver,
        dshSessionDriver,
        feishuChatDriver,
        cursorAgentDriver,
      ],
    },
    env,
  );
}

function catalogOf(readiness = {}) {
  return connectorCatalog([], {
    ...readiness,
    extras: readiness.extras ?? firstParty(readiness.env ?? {}),
  });
}

describe("connector catalog hints", () => {
  it("uses a service hint when lark-cli is missing or signed out", () => {
    const missing = catalogOf({
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

    const signedOut = catalogOf({
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

  it("projects setup steps from each first-party catalog", () => {
    const catalog = catalogOf({ env: {} });
    const slack = catalog.find((item) => item.connector_type === "slack-channel");
    const dsh = catalog.find((item) => item.connector_type === "dsh-session");
    const feishu = catalog.find((item) => item.connector_type === "feishu-chat");
    const cursor = catalog.find((item) => item.connector_type === "cursor-agent");
    assert.deepEqual(
      slack.setup_steps.map((step) => step.title),
      [
        "Create a Slack app and copy a bot token",
        "Set REGENIC_SLACK_TOKEN, then fully quit and reopen the desktop",
        "Enter the channel ID",
      ],
    );
    assert.equal(slack.setup_steps[0].href, "https://api.slack.com/apps");
    assert.equal(dsh.setup_steps[1].command, "dsh web --port 3080");
    assert.equal(dsh.setup_steps[1].visible_when.value, "web");
    assert.equal(dsh.setup_steps.at(-1).visible_when.value, "cli");
    assert.equal(
      feishu.setup_steps[0].command,
      "npx @larksuite/cli@latest install",
    );
    assert.equal(feishu.setup_steps[0].href, "https://github.com/larksuite/cli");
    assert.equal(cursor.setup_steps[0].href, "https://cursor.com/dashboard");
    assert.match(cursor.setup_steps[1].body, /keychain/);
    const hosted = catalogOf({
      env: { REGENIC_DSH_BASE_URL: "http://dsh.cluster" },
    }).find((item) => item.connector_type === "dsh-session");
    assert.equal(hosted.setup_steps[0].title, "Use the cluster DSH URL");
    assert.equal(
      hosted.fields.some((field) => field.key === "transport"),
      false,
    );
  });

  it("drops empty setup titles and non-http hrefs", () => {
    const extras = catalogFromDrivers({
      list: () => [
        {
          connector_type: "extra-review",
          source: "extra",
          installCatalog() {
            return {
              title: "Extra review",
              description: "Loaded plugin.",
              credential_hint: "EXTRA_URL",
              setup_steps: [
                { title: "  " },
                {
                  title: "Open the docs",
                  href: "javascript:alert(1)",
                },
                {
                  title: "Run the probe",
                  command: " extra-probe ",
                  href: "https://extra.example/docs",
                },
              ],
            };
          },
        },
      ],
    });
    const extra = connectorCatalog([], { extras }).find(
      (item) => item.connector_type === "extra-review",
    );
    assert.deepEqual(extra.setup_steps, [
      {
        title: "Open the docs",
      },
      {
        title: "Run the probe",
        command: "extra-probe",
        href: "https://extra.example/docs",
      },
    ]);
  });

  it("lists DSH web and CLI service prerequisites from the catalog", () => {
    const slack = catalogOf({ env: {} }).find(
      (item) => item.connector_type === "slack-channel",
    );
    assert.match(slack.prerequisites[0].hint, /REGENIC_SLACK_TOKEN/);
    assert.equal(slack.setup_ready, false);
    const dsh = catalogOf({ env: {} }).find(
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
    const dsh = catalogOf({
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
    const catalog = catalogOf({
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

  it("labels a Feishu install from the driver, not a host type switch", () => {
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
          return feishuChatDriver;
        },
      },
    );
    assert.equal(view.label, "All conversations");
    assert.equal(view.channel, "feishu");
    assert.equal(view.channel_label, "Feishu");
    assert.equal(view.settings.kinds, "group,p2p");
  });

  it("lists no catalog rows until a driver declares installCatalog", () => {
    const catalog = connectorCatalog([], { env: {} });
    assert.deepEqual(catalog.map((item) => item.connector_type), []);
    assert.deepEqual(
      firstParty({}).map((item) => item.connector_type),
      ["slack-channel", "dsh-session", "feishu-chat", "cursor-agent"],
    );
    assert.equal(connectorAllowsMultiple("slack-channel", firstParty()), true);
    assert.equal(connectorAllowsMultiple("extra-review"), true);
  });

  it("appends install cards from loaded extra drivers", () => {
    const extras = catalogFromDrivers({
      list: () => [
        slackChannelDriver,
        {
          connector_type: "extra-review",
          source: "extra",
          installCatalog() {
            return {
              title: "Extra review",
              description: "Loaded plugin.",
              credential_hint: "EXTRA_URL",
              singleton: true,
              fields: [{ key: "max_open", label: "Max open", default: "50" }],
              prerequisites: [
                {
                  kind: "env",
                  key: "EXTRA_URL",
                  label: "Base URL",
                  required: true,
                },
              ],
              instance_label: "Extra queue",
              instance_detail_key: "max_open",
            };
          },
        },
      ],
    });
    const catalog = connectorCatalog([], {
      env: { EXTRA_URL: "https://extra.internal" },
      extras,
    });
    assert.equal(catalog[0].connector_type, "slack-channel");
    const extra = catalog.find((item) => item.connector_type === "extra-review");
    assert.equal(extra.title, "Extra review");
    assert.deepEqual(extra.setup_steps, []);
    assert.equal(extra.setup_ready, true);
    assert.equal(extra.singleton, true);
    assert.equal(extra.fields[0].key, "max_open");
    assert.equal(connectorAllowsMultiple("extra-review", extras), false);
  });

  it("labels an extra install from the driver, not a host type switch", () => {
    const view = toInstallationView(
      {
        id: "extra-1",
        org_id: "local-owner",
        connector_type: "extra-review",
        status: "enabled",
        config: { max_open: "50" },
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
      null,
      {
        get() {
          return {
            source: "extra",
            capabilities() {
              return { sync: true, reply: false, create: false };
            },
            installCatalog() {
              return {
                title: "Extra review",
                description: "Loaded plugin.",
                credential_hint: "EXTRA_URL",
                instance_label: "Extra queue",
                instance_detail_key: "max_open",
              };
            },
          };
        },
      },
    );
    assert.equal(view.label, "Extra queue");
    assert.equal(view.detail, "50");
    assert.equal(view.channel, "extra");
    assert.equal(view.channel_label, "Extra review");
    assert.equal(view.settings.max_open, "50");
  });

  it("persists picked chat names from stream labels", () => {
    assert.deepEqual(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1", "oc_2"] },
        [
          { thread_id: "feishu:oc_1", label: "合伙" },
          { thread_id: "feishu:oc_2", label: "李诗婷" },
        ],
      ),
      ["合伙", "李诗婷"],
    );
    assert.equal(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1"], chat_names: ["Ada"] },
        [{ thread_id: "feishu:oc_1", label: "Ada" }],
      ),
      null,
    );
    assert.equal(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1", "oc_2"] },
        [{ thread_id: "feishu:oc_1", label: "oc_1" }],
      ),
      null,
    );
  });
});
