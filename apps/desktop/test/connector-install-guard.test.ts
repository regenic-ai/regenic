import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogInstallConfirm,
  matchesCatalogFieldWhen,
} from "../src/renderer/src/connector-install-guard.ts";
import type { ConnectorCatalogItem } from "../src/renderer/src/types.ts";

describe("connector-install-guard", () => {
  const feishuKind = {
    connector_type: "feishu-chat",
    install_confirm: {
      when: { field: "selection", value: "all" },
      warning: "warning",
      ack: "ack",
    },
  } as ConnectorCatalogItem;

  it("requires confirmation from catalog install_confirm", () => {
    assert.deepEqual(
      catalogInstallConfirm(feishuKind, { selection: "all" }),
      feishuKind.install_confirm,
    );
    assert.equal(
      catalogInstallConfirm(feishuKind, { selection: "recent" }),
      undefined,
    );
    assert.equal(catalogInstallConfirm({} as ConnectorCatalogItem, {}), undefined);
  });

  it("matches multi-value visible_when through domain helper", () => {
    assert.equal(
      matchesCatalogFieldWhen(
        { field: "selection", values: ["all", "recent"] },
        { selection: "recent" },
      ),
      true,
    );
    assert.equal(
      matchesCatalogFieldWhen(
        { field: "selection", values: ["all", "recent"] },
        { selection: "pick" },
      ),
      false,
    );
  });
});
