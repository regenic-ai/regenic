import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineRevision } from "../src/renderer/src/console-refresh.ts";
import type { ConnectorCatalogItem, PersonalEngineView } from "../src/renderer/src/types.ts";

function engineWithCatalog(title: string, step: string): PersonalEngineView {
  const catalog: ConnectorCatalogItem = {
    connector_type: "feishu-chat",
    title,
    description: "",
    credential_hint: "",
    installed: false,
    instance_count: 0,
    setup_ready: true,
    singleton: false,
    fields: [],
    prerequisites: [],
    setup_steps: [{ title: step }],
    docs: [],
  };
  return {
    kernel: "running",
    org_id: "local-owner",
    database_path: null,
    inbox_count: 0,
    installations: [],
    catalog: [catalog],
    executor_installations: [],
    executor_catalog: [],
  };
}

describe("engineRevision", () => {
  it("changes when resolved catalog copy changes", () => {
    const english = engineRevision(
      engineWithCatalog("Feishu", "Install lark-cli"),
      false,
    );
    const chinese = engineRevision(
      engineWithCatalog("飞书", "安装 lark-cli"),
      false,
    );
    assert.notEqual(english, chinese);
  });

  it("changes when a resolved executor connector label changes", () => {
    const english = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        executor_installations: [
          {
            id: "ex-1",
            kind: "local_connector",
            name: "Office",
            status: "enabled",
            label: "Office",
            detail: "Feishu",
          },
        ],
      },
      false,
    );
    const chinese = engineRevision(
      {
        ...engineWithCatalog("飞书", "安装 lark-cli"),
        executor_installations: [
          {
            id: "ex-1",
            kind: "local_connector",
            name: "Office",
            status: "enabled",
            label: "Office",
            detail: "飞书",
          },
        ],
      },
      false,
    );
    assert.notEqual(english, chinese);
  });

  it("changes when sync coverage counts change", () => {
    const before = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        installations: [
          {
            id: "feishu-1",
            connector_type: "feishu-chat",
            status: "enabled",
            label: "All conversations",
            detail: null,
            syncable: true,
            can_reply: true,
            can_create: false,
            last_attempt: null,
            sync: {
              discovered: 34,
              seeded: 12,
              unseeded: 22,
              backfilling: 4,
              media_pending: 0,
              catalog_complete: false,
              bootstrap_pending: 26,
              steady: 8,
            },
          },
        ],
      },
      false,
    );
    const after = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        installations: [
          {
            id: "feishu-1",
            connector_type: "feishu-chat",
            status: "enabled",
            label: "All conversations",
            detail: null,
            syncable: true,
            can_reply: true,
            can_create: false,
            last_attempt: null,
            sync: {
              discovered: 120,
              seeded: 34,
              unseeded: 86,
              backfilling: 8,
              media_pending: 0,
              catalog_complete: false,
              bootstrap_pending: 94,
              steady: 26,
            },
          },
        ],
      },
      false,
    );
    assert.notEqual(before, after);
  });
});
