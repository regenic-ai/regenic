import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  hash, isolatedEnvironment, packedArtifact, pnpm, provenance, repo,
  requireRuntime, run, temporaryRoot,
} from "./lib.mjs";

requireRuntime();
const manifest = JSON.parse(readFileSync(join(repo, "scripts/testing/connectors.json"), "utf8"));
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const id = value("connector");
const sdk = value("sdk");
if (!id || !sdk) throw new Error("Usage: node scripts/testing/compatibility.mjs --connector <id> --sdk stable|candidate");
const connector = manifest.connectors.find((item) => item.id === id);
if (!connector) throw new Error(`Unknown connector: ${id}`);
const expectedSdk = connector[`${sdk}_sdk`];
if (!expectedSdk) throw new Error(`${id} does not declare ${sdk} contract compatibility`);
const consumerMode = connector.consumer_mode ?? "packed-npm";

function packageInfo(requireFn, spec) {
  let root = dirname(requireFn.resolve(spec));
  while (root !== dirname(root) && !existsSync(join(root, "package.json"))) {
    root = dirname(root);
  }
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Unable to locate package.json for ${spec}`);
  }
  return {
    spec,
    manifest_path: manifestPath,
    manifest_realpath: realpathSync(manifestPath),
    version: JSON.parse(readFileSync(manifestPath, "utf8")).version,
  };
}

function runAuditNonGating(cwd, env) {
  const result = spawnSync(pnpm, ["audit", "--prod", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  let parsed = null;
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      parsed = JSON.parse(trimmed);
      break;
    } catch {
      continue;
    }
  }
  return {
    exit_status: result.status ?? null,
    parsed,
    parseable_json: parsed !== null,
  };
}

const root = temporaryRoot(`c-${id.slice(0, 6)}-${sdk[0]}`);
const source = join(root, "source");
const shortTmp = join("/tmp", `rgc-${id.slice(0, 6)}-${sdk[0]}-${process.pid}`);
mkdirSync(shortTmp, { recursive: true });
const env = {
  ...isolatedEnvironment(root),
  npm_config_manage_package_manager_versions: "false",
  TMPDIR: shortTmp,
  TMP: shortTmp,
  TEMP: shortTmp,
  ...(sdk === "candidate" ? { REGENIC_ROOT: repo } : {}),
};

const record = {
  ...provenance(),
  core_source_sha: run("git", ["rev-parse", "HEAD"], { capture: true }),
  connector: id,
  repository: connector.repository,
  connector_source_sha: connector.source_sha,
  sdk_mode: sdk,
  expected_contract: expectedSdk,
  consumer_mode: consumerMode,
  status: "failed",
  automatic_mode: manifest.automatic_mode,
  manual_live_mode: manifest.manual_live_mode,
};

let stage = "fetch";
try {
  run("git", ["init", "--quiet", source]);
  run("git", ["-C", source, "remote", "add", "origin", `https://github.com/${connector.repository}.git`]);
  run("git", ["-C", source, "fetch", "--quiet", "--depth=1", "origin", connector.source_sha]);
  run("git", ["-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const actualSha = run("git", ["-C", source, "rev-parse", "HEAD"], { capture: true });
  if (actualSha !== connector.source_sha) throw new Error(`Source SHA mismatch: expected ${connector.source_sha}, got ${actualSha}`);

  const packageDir = join(source, connector.package_dir);
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`Missing declared package manifest: ${connector.package_dir}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== connector.package_name) {
    throw new Error(`Package mismatch: expected ${connector.package_name}, got ${packageJson.name}`);
  }

  const sdkRoot = join(root, "sdk");
  if (sdk === "candidate") {
    env.REGENIC_ROOT = repo;
  } else {
    mkdirSync(sdkRoot);
    const sdkPrefix = join(sdkRoot, "consumer");
    mkdirSync(sdkPrefix);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", sdkPrefix,
      "@regenic/plugin-host@0.1.0", "@regenic/connector-contract@0.2.0",
      "@regenic/connector-test-utils@0.1.0"], { env });
    mkdirSync(join(sdkRoot, "packages"));
    for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
      const link = join(sdkRoot, "packages", name);
      const target = join(sdkPrefix, "node_modules", "@regenic", name);
      if (!existsSync(target)) throw new Error(`Missing stable SDK package ${name}`);
      await import("node:fs/promises").then(({ symlink }) => symlink(target, link, "dir"));
    }
    env.REGENIC_ROOT = sdkRoot;
  }

  stage = "frozen-install";
  if (existsSync(join(source, "pnpm-lock.yaml"))) {
    run(pnpm, ["install", "--frozen-lockfile"], { cwd: source, env });
  } else if (existsSync(join(source, "package-lock.json"))) {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, env });
  } else {
    throw new Error("Source repository has no supported lock file for frozen install (pnpm-lock.yaml or package-lock.json)");
  }
  const linkScript = join(source, "scripts", "link-regenic.mjs");
  if (existsSync(linkScript)) {
    stage = "link-regenic";
    run(process.execPath, [linkScript, "--required"], { cwd: source, env });
  }

  const sourceRequire = createRequire(join(packageDir, "package.json"));
  const sourceContract = packageInfo(sourceRequire, "@regenic/connector-contract");
  if (sourceContract.version !== expectedSdk) {
    throw new Error(`Source dependency mismatch: expected @regenic/connector-contract ${expectedSdk}, got ${sourceContract.version}`);
  }
  record.source_contract = sourceContract;

  stage = "build";
  run(pnpm, ["-r", "--if-present", "run", "build"], { cwd: source, env });
  stage = "typecheck";
  run(pnpm, ["-r", "--if-present", "run", "typecheck"], { cwd: source, env });
  stage = "connector-tests";
  run(pnpm, ["-r", "--if-present", "run", "test"], { cwd: source, env });

  if (consumerMode === "clone-root-absolute") {
    stage = "root-audit";
    const audit = runAuditNonGating(source, env);
    record.root_audit = audit;

    stage = "absolute-load";
    const rootRequire = createRequire(join(source, "package.json"));
    const pluginRequire = createRequire(join(packageDir, "package.json"));
    const plugin = pluginRequire(packageDir);
    const hostContract = packageInfo(rootRequire, "@regenic/connector-contract");
    const pluginContract = packageInfo(pluginRequire, "@regenic/connector-contract");
    if (pluginContract.version !== expectedSdk || hostContract.version !== expectedSdk) {
      throw new Error(`Absolute-load contract mismatch: host=${hostContract.version}, plugin=${pluginContract.version}, expected=${expectedSdk}`);
    }
    const sameContractInstance = hostContract.manifest_realpath === pluginContract.manifest_realpath;
    if (!sameContractInstance) {
      throw new Error("Absolute plugin load did not share the same connector-contract instance with host");
    }
    const hostPkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const pnpmOverrides = hostPkg.pnpm?.overrides ?? {};
    const zodOverride = pnpmOverrides.zod
      ?? pnpmOverrides["@github/copilot-sdk@1.0.28>zod"]
      ?? hostPkg.overrides?.zod;
    if (typeof zodOverride !== "string" || !zodOverride.includes("4.6.7")) {
      throw new Error("Copilot source root does not expose the expected Zod 4.6.7 override");
    }
    record.absolute_load = {
      plugin_loaded: Boolean(plugin),
      host_contract: hostContract,
      plugin_contract: pluginContract,
      shared_contract_instance: sameContractInstance,
      zod_override: zodOverride,
    };
    record.contract_range = connector.contract_range;
    record.package_version = packageJson.version;
    record.connector_lock_sha512 = existsSync(join(source, "pnpm-lock.yaml"))
      ? hash(join(source, "pnpm-lock.yaml"))
      : existsSync(join(source, "package-lock.json")) ? hash(join(source, "package-lock.json")) : null;
    record.status = "passed";
  } else if (consumerMode === "packed-npm") {
    stage = "pack";
    const packDir = join(root, "packs");
    mkdirSync(packDir);
    const packedJson = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageDir, env, capture: true,
    }));
    const tarball = join(packDir, packedJson[0].filename);
    const tarballSha512 = hash(tarball);
    const prefix = join(root, "consumer");
    const sdkPackages = sdk === "candidate"
      ? [
          join(repo, "packages/plugin-host"),
          join(repo, "packages/connector-contract"),
          join(repo, "packages/connector-test-utils"),
        ]
      : [
          "@regenic/connector-contract@0.2.0",
          "@regenic/plugin-host@0.1.0",
          "@regenic/connector-test-utils@0.1.0",
        ];
    run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      "--prefix", prefix, ...sdkPackages, tarball], { env });
    stage = "packed-load";
    const consumerRequire = createRequire(join(prefix, "entry.cjs"));
    const plugin = consumerRequire(connector.package_name);
    let installedPackageRoot = dirname(consumerRequire.resolve(connector.package_name));
    while (
      installedPackageRoot !== dirname(installedPackageRoot) &&
      !existsSync(join(installedPackageRoot, "package.json"))
    ) {
      installedPackageRoot = dirname(installedPackageRoot);
    }
    const installedManifestPath = resolve(installedPackageRoot, "package.json");
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    if (installedManifest.regenic?.plugin !== true) throw new Error("Packed connector lacks regenic.plugin manifest");
    if (installedManifest.regenic.engines?.regenic !== "1.0") throw new Error("Packed connector declares unsupported Regenic host protocol");

    const hostContract = packageInfo(consumerRequire, "@regenic/connector-contract");
    if (hostContract.version !== expectedSdk) {
      throw new Error(`Consumer host contract mismatch: expected ${expectedSdk}, got ${hostContract.version}`);
    }
    const pluginRequire = createRequire(consumerRequire.resolve(connector.package_name));
    const pluginContract = packageInfo(pluginRequire, "@regenic/connector-contract");
    if (pluginContract.version !== expectedSdk) {
      throw new Error(`Consumer plugin contract mismatch: expected ${expectedSdk}, got ${pluginContract.version}`);
    }
    const sharedContractInstance = hostContract.manifest_realpath === pluginContract.manifest_realpath;
    if (!sharedContractInstance) {
      throw new Error("Packed consumer did not share one connector-contract instance between host and plugin");
    }

    const contract = consumerRequire("@regenic/connector-contract");
    if (contract.CONNECTOR_PROTOCOL !== "1.0") throw new Error(`Unexpected contract protocol ${contract.CONNECTOR_PROTOCOL}`);
    for (const name of installedManifest.regenic.contributes?.drivers ?? []) {
      if (typeof plugin[name]?.install !== "function") throw new Error(`Packed driver contribution is not loadable: ${name}`);
      if (plugin[name].connector_protocol !== contract.CONNECTOR_PROTOCOL) throw new Error(`Driver protocol mismatch: ${name}`);
    }
    for (const name of installedManifest.regenic.contributes?.executors ?? []) {
      if (typeof plugin[name]?.start !== "function") throw new Error(`Packed executor contribution is not loadable: ${name}`);
    }
    record.contract_range = connector.contract_range;
    record.package_version = packedJson[0].version;
    record.tarball_sha512 = tarballSha512;
    record.connector_lock_sha512 = existsSync(join(source, "pnpm-lock.yaml"))
      ? hash(join(source, "pnpm-lock.yaml"))
      : existsSync(join(source, "package-lock.json")) ? hash(join(source, "package-lock.json")) : null;
    record.consumer_contract = {
      host: hostContract,
      plugin: pluginContract,
      shared_contract_instance: sharedContractInstance,
    };
    record.package_contributions = installedManifest.regenic.contributes;
    record.status = "passed";
  } else {
    throw new Error(`Unsupported consumer_mode: ${consumerMode}`);
  }
} finally {
  rmSync(shortTmp, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  const output = join(repo, "coverage/test-evidence");
  mkdirSync(output, { recursive: true });
  const name = `compatibility-${id}-${sdk}`;
  record.failed_stage = record.status === "failed" ? stage : undefined;
  writeFileSync(join(output, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
