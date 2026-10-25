const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { describe, it } = require("node:test");

function checkFixture(t, filename, source) {
  const root = mkdtempSync(join(tmpdir(), "regenic-connector-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checker = join(root, "scripts/check-dependency-boundaries.mjs");
  const fixture = join(root, "apps/api/src", filename);
  mkdirSync(dirname(checker), { recursive: true });
  mkdirSync(dirname(fixture), { recursive: true });
  mkdirSync(join(root, "packages"));
  copyFileSync(join(__dirname, "../../../scripts/check-dependency-boundaries.mjs"), checker);
  writeFileSync(fixture, source);
  const result = spawnSync(process.execPath, [checker], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  return result;
}

describe("connector helper dependency boundaries", () => {
  it("rejects type-only imports back into the owning service", (t) => {
    const result = checkFixture(t, "personal-connector-conversation.ts",
      'import type { CreatedConversationView } from "./personal-connector.service";');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Connector helper imports its owning service/);
  });

  it("rejects nested re-exports with an explicit JavaScript extension", (t) => {
    const result = checkFixture(t, "nested/personal-connector-types.ts",
      'export type { CreatedConversationView } from "../personal-connector.service.js";');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Connector helper imports its owning service/);
  });

  it("allows helpers to import leaf DTOs and state capabilities", (t) => {
    const result = checkFixture(t, "personal-connector-conversation.ts", [
      'import type { CreatedConversationView } from "./personal-connector-types";',
      'import type { ConnectorConversationState } from "./personal-connector-state";',
    ].join("\n"));
    assert.equal(result.status, 0, result.stderr);
  });

  it("preserves compatibility type imports for service consumers", (t) => {
    const result = checkFixture(t, "personal.controller.ts",
      'import type { ConnectorInstallInput } from "./personal-connector.service";');
    assert.equal(result.status, 0, result.stderr);
  });
});
