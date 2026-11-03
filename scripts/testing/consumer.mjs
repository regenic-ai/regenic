import { createRequire } from "node:module";
import { join } from "node:path";
import {
  evidence, hash, isolatedEnvironment, npm, pnpm, provenance,
  packedArtifact, removeRoot, repo, requireRuntime, run, temporaryRoot,
} from "./lib.mjs";

requireRuntime();
const require = createRequire(join(repo, "packages/connector-contract/package.json"));
const { CONNECTOR_PROTOCOL } = require("@regenic/connector-contract");
const root = temporaryRoot("consumer");
const packDir = join(root, "packs");
const consumerDir = join(root, "consumer");
const env = { ...isolatedEnvironment(root), CONSUMER_ROOT: consumerDir };
const packed = [];
try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(packDir, { recursive: true }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumerDir, { recursive: true }));
  for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
    const directory = join(repo, "packages", name);
    const output = run(pnpm, ["pack", "--pack-destination", packDir], { cwd: directory, env, capture: true });
    const path = packedArtifact(output, packDir);
    packed.push({ name, path, sha512: hash(path) });
  }
  run(npm, ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    "--prefix", consumerDir, ...packed.map((entry) => entry.path)], { env });
  run(process.execPath, [join(repo, "scripts/testing/consumer-probe.cjs")], { env });
  evidence("packed-consumer", {
    ...provenance(), status: "passed", contract_protocol: CONNECTOR_PROTOCOL,
    packages: packed.map(({ name, sha512 }) => ({ name, sha512 })),
    install_mode: "npm install --ignore-scripts --omit=dev",
    zod_note: "This exercises the packed host SDK/plugin contract, not downstream inheritance of root-only overrides.",
  });
} finally {
  removeRoot(root);
}
