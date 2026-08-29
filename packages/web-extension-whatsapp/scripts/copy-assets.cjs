const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const file of ["manifest.json", "popup.html", "settings.html"]) {
  copyFileSync(join(root, file), join(dist, file));
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
writeFileSync(
  join(dist, "build-info.js"),
  `globalThis.REGENIC_EXTENSION_BUILD = ${JSON.stringify({
    version: manifest.version,
  })};\n`,
);