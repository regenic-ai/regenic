import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("whatsapp extension load path", () => {
  it("injects a classic loader so content-script.js can stay an ES module", () => {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.content_scripts[0].js, ["inject-loader.js"]);
    assert.equal(manifest.content_scripts[0].type, undefined);
    const loader = readFileSync(join(root, "src/inject-loader.ts"), "utf8");
    assert.match(loader, /void import\(chrome\.runtime\.getURL\("content-script\.js"\)\)/);
    assert.equal(loader.includes("import {"), false);
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.side_panel.default_path, "popup.html");
    assert.ok(manifest.permissions.includes("sidePanel"));
    assert.deepEqual(manifest.web_accessible_resources[0].resources, [
      "content-script.js",
      "page-logic.js",
    ]);
  });
});
