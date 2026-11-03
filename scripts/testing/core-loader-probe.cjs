const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { existsSync, realpathSync } = require("node:fs");
const path = require("node:path");
const {
  assertCandidatePackage,
  assertRuntimeOverride,
} = require("./compatibility-evidence.cjs");

const pluginDir = path.resolve(process.argv[2] ?? "");
if (!existsSync(path.join(pluginDir, "package.json"))) {
  throw new Error(`Missing plugin package at ${pluginDir}`);
}
const pluginManifest = JSON.parse(
  require("node:fs").readFileSync(path.join(pluginDir, "package.json"), "utf8"),
);
const apiLoaderPath = path.join(__dirname, "../../apps/api/dist/channel-plugins.js");
const apiRequire = createRequire(apiLoaderPath);
const loader = apiRequire(apiLoaderPath);
const env = {
  ...process.env,
  REGENIC_CHANNEL_PLUGIN: pluginDir,
  REGENIC_CRM_CONNECTOR: "",
  REGENIC_PLUGIN_DIR: path.join(path.dirname(pluginDir), "empty-plugin-dir"),
};
const drivers = loader.extraChannelDrivers(env);
const executors = loader.extraTaskExecutors(env);
const expectedDrivers = pluginManifest.regenic?.contributes?.drivers ?? [];
const expectedExecutors = pluginManifest.regenic?.contributes?.executors ?? [];

assert.equal(drivers.length, expectedDrivers.length, "core loader did not accept every declared driver contribution");
assert.equal(executors.length, expectedExecutors.length, "core loader did not accept every declared executor contribution");
assert.ok(drivers.every((driver) => driver.connector_protocol === "1.0"));

const apiDomainRequire = createRequire(apiRequire.resolve("@regenic/domain"));
const coreContractPath = apiDomainRequire.resolve("@regenic/connector-contract");
let coreContractRoot = path.dirname(coreContractPath);
while (
  coreContractRoot !== path.dirname(coreContractRoot) &&
  !existsSync(path.join(coreContractRoot, "package.json"))
) {
  coreContractRoot = path.dirname(coreContractRoot);
}
const coreContractManifest = path.join(coreContractRoot, "package.json");
const coreContract = JSON.parse(require("node:fs").readFileSync(coreContractManifest, "utf8"));
const pluginRequire = createRequire(path.join(pluginDir, "package.json"));
const pluginContractPath = pluginRequire.resolve("@regenic/connector-contract");
let pluginContractRoot = path.dirname(pluginContractPath);
while (
  pluginContractRoot !== path.dirname(pluginContractRoot) &&
  !existsSync(path.join(pluginContractRoot, "package.json"))
) {
  pluginContractRoot = path.dirname(pluginContractRoot);
}
const pluginContractManifest = path.join(pluginContractRoot, "package.json");
const pluginContract = JSON.parse(require("node:fs").readFileSync(pluginContractManifest, "utf8"));

assert.equal(
  pluginManifest.regenic?.engines?.regenic,
  "1.0",
  "plugin manifest is outside the core loader protocol boundary",
);
if (process.env.EXPECTED_CANDIDATE_CONTRACT_MANIFEST) {
  assertCandidatePackage({
    manifest_realpath: realpathSync(pluginContractManifest),
    version: pluginContract.version,
  }, {
    manifest_realpath: realpathSync(process.env.EXPECTED_CANDIDATE_CONTRACT_MANIFEST),
    version: process.env.EXPECTED_CANDIDATE_CONTRACT_VERSION,
  }, process.env.EXPECTED_CANDIDATE_CONTRACT_VERSION);
}
if (process.env.EXPECTED_COPILOT_ZOD_VERSION) {
  const sdkEntry = pluginRequire.resolve("@github/copilot-sdk");
  const sdkRequire = createRequire(sdkEntry);
  let zodRoot = path.dirname(sdkRequire.resolve("zod"));
  while (zodRoot !== path.dirname(zodRoot) && !existsSync(path.join(zodRoot, "package.json"))) {
    zodRoot = path.dirname(zodRoot);
  }
  const zod = JSON.parse(require("node:fs").readFileSync(path.join(zodRoot, "package.json"), "utf8"));
  assertRuntimeOverride(
    process.env.COPILOT_ZOD_OVERRIDE,
    zod,
    process.env.EXPECTED_COPILOT_ZOD_VERSION,
    "Copilot SDK Zod",
  );
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  activated: false,
  plugin_manifest: realpathSync(path.join(pluginDir, "package.json")),
  plugin_contract: {
    manifest_realpath: realpathSync(pluginContractManifest),
    version: pluginContract.version,
  },
  core_contract: {
    manifest_realpath: realpathSync(coreContractManifest),
    version: coreContract.version,
    protocol: "1.0",
  },
  core_contract_protocol: "1.0",
  zod_version: process.env.EXPECTED_COPILOT_ZOD_VERSION ?? null,
  drivers: drivers.map((driver) => ({
    connector_type: driver.connector_type,
    connector_protocol: driver.connector_protocol,
  })),
  executors: executors.map((executor) => ({
    executor_type: executor.executor_type,
    source: executor.catalog().source,
  })),
})}\n`);
