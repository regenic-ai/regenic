import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMarketIndex, parsePackageList } from "./generate-market-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const listPath = resolve(root, "market/connectors.txt");
const indexPath = resolve(root, "market/connectors.json");

const packages = parsePackageList(await readFile(listPath, "utf8"));
const generated = await generateMarketIndex({
  packages,
  title: "Regenic Connectors",
});
const expected = await readFile(indexPath, "utf8");
const actual = `${JSON.stringify(generated, null, 2)}\n`;
if (actual !== expected) {
  throw new Error("market/connectors.json is stale. Regenerate it from market/connectors.txt.");
}
console.log(`Official connector index matches ${packages.length} reviewed package(s).`);
