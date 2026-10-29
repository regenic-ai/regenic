const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  builtinChannelDrivers,
  dshSessionDriver,
  feishuChatDriver,
} = require("@regenic/connector-host");
const {
  catalogFromDrivers,
  connectorAllowsMultiple,
  connectorCatalog,
  nextPickedChatNames,
  toInstallationView,
} = require("../dist/personal-connector-view");

function firstPartyDrivers() {
  return builtinChannelDrivers();
}

function firstParty(env = {}, locale) {
  return catalogFromDrivers({ list: () => firstPartyDrivers() }, env, locale);
}

function catalogOf(readiness = {}) {
  return connectorCatalog([], {
    ...readiness,
    drivers: readiness.drivers ?? { list: () => firstPartyDrivers() },
    extras: readiness.extras ?? firstParty(readiness.env ?? {}, readiness.locale),
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
    const dsh = catalog.find((item) => item.connector_type === "dsh-session");
    const feishu = catalog.find((item) => item.connector_type === "feishu-chat");
    const cursor = catalog.find((item) => item.connector_type === "cursor-agent");
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

  it("resolves plugin catalog copy for Chinese", () => {
    const catalog = catalogOf({ env: {}, locale: "zh" });
    const feishu = catalog.find((item) => item.connector_type === "feishu-chat");
    assert.equal(feishu.title, "飞书");
    assert.equal(feishu.fields[0].label, "同步模式");
    assert.equal(feishu.fields[1].label, "同步范围");
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

  it("exposes a declared subject catalog without interpreting the ids", () => {
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
            };
          },
          subjectCatalog() {
            return {
              kinds: [
                { id: "extra.order_review", label: "Order review" },
                { id: "  extra.order_review  ", label: "Duplicate" },
                { id: "", label: "Empty" },
              ],
            };
          },
        },
      ],
    });
    const extra = connectorCatalog([], { extras }).find(
      (item) => item.connector_type === "extra-review",
    );
    assert.equal(extra.source, "extra");
    assert.deepEqual(extra.unit_kinds, [
      { id: "extra.order_review", label: "Order review" },
    ]);
  });

  it("lists DSH web and CLI service prerequisites from the catalog", () => {
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
    assert.equal(feishu.fields[0].key, "sync_mode");
    assert.equal(feishu.fields[0].default, "conversation");
    assert.equal(feishu.fields[1].key, "selection");
    assert.equal(feishu.fields[2].key, "kinds");
    assert.equal(feishu.fields[2].default, "group,p2p");
    assert.equal(feishu.fields[3].multiple, true);
    assert.equal(feishu.fields[3].filter_options_by, "kinds");
    assert.equal(feishu.fields[3].option_labels_key, "chat_names");
    assert.deepEqual(feishu.fields[3].options, [
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
    assert.equal(view.sync, undefined);
  });

  it("attaches sync coverage when the store has started a catalog", () => {
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
      "en",
      {
        sync: {
          discovered: 120,
          seeded: 34,
          unseeded: 86,
          backfilling: 8,
          media_pending: 0,
          catalog_complete: false,
        },
      },
    );
    assert.equal(view.sync.discovered, 120);
    assert.equal(view.sync.seeded, 34);
    assert.equal(view.sync.backfilling, 8);
    assert.equal(view.sync.catalog_complete, false);
  });

  it("projects file import only when the driver can parseImport", () => {
    const catalog = catalogOf({ env: {} });
    assert.ok(catalog.every((item) => item.import_files === undefined));

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
              import_files: { accept: " .csv ", title: "  Extra CSV  " },
            };
          },
        },
        {
          connector_type: "extra-import",
          source: "extra",
          installCatalog() {
            return {
              title: "Extra import",
              description: "Loaded plugin.",
              credential_hint: "EXTRA_URL",
              import_files: { accept: " .csv ", title: "  Extra CSV  " },
            };
          },
          parseImport() {
            return { file_hash: "", batches: [], errors: [] };
          },
        },
      ],
    });
    const catalogWithExtras = connectorCatalog([], { extras });
    assert.equal(
      catalogWithExtras.find((item) => item.connector_type === "extra-review")
        .import_files,
      undefined,
    );
    assert.deepEqual(
      catalogWithExtras.find((item) => item.connector_type === "extra-import")
        .import_files,
      { accept: ".csv", title: "Extra CSV" },
    );
  });

  it("lists no catalog rows until a driver declares installCatalog", () => {
    const catalog = connectorCatalog([], { env: {} });
    assert.deepEqual(catalog.map((item) => item.connector_type), []);
    assert.deepEqual(
      firstParty({}).map((item) => item.connector_type),
      ["dsh-session", "feishu-chat", "cursor-agent"],
    );
    assert.equal(connectorAllowsMultiple("dsh-session", firstParty()), true);
    assert.equal(connectorAllowsMultiple("extra-review"), true);
  });

  it("appends install cards from loaded extra drivers", () => {
    const extras = catalogFromDrivers({
      list: () => [
        dshSessionDriver,
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
    assert.equal(catalog[0].connector_type, "dsh-session");
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

  it("persists picked option labels from stream labels", () => {
    const field = { key: "chat_ids", option_labels_key: "chat_names" };
    assert.deepEqual(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1", "oc_2"] },
        [
          { thread_id: "feishu:oc_1", label: "合伙" },
          { thread_id: "feishu:oc_2", label: "李诗婷" },
        ],
        field,
      ),
      ["合伙", "李诗婷"],
    );
    assert.equal(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1"], chat_names: ["Ada"] },
        [{ thread_id: "feishu:oc_1", label: "Ada" }],
        field,
      ),
      null,
    );
    assert.equal(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1", "oc_2"] },
        [{ thread_id: "feishu:oc_1", label: "oc_1" }],
        field,
      ),
      null,
    );
    assert.equal(
      nextPickedChatNames(
        { selection: "pick", chat_ids: ["oc_1"] },
        [{ thread_id: "feishu:oc_1", label: "合伙" }],
      ),
      null,
    );
  });
});
