import {
  cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import compatibilityEvidence from "./compatibility-evidence.cjs";
import {
  hash, isolatedEnvironment, packedArtifact, pnpm, provenance, repo,
  requireRuntime, run, temporaryRoot,
} from "./lib.mjs";

const {
  assertCandidatePackage,
  assertPackageVersion,
  assertRuntimeOverride,
  parseAuditResult,
} = compatibilityEvidence;
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
  const parsed = parseAuditResult(result);
  return {
    exit_status: result.status ?? null,
    report_keys: Object.keys(parsed).sort(),
    vulnerabilities: parsed.metadata?.vulnerabilities ?? parsed.vulnerabilities ?? null,
    advisory_count: Object.keys(parsed.advisories ?? {}).length,
  };
}

function packageRoot(packagePath) {
  let current = packagePath;
  while (current !== dirname(current) && !existsSync(join(current, "package.json"))) {
    current = dirname(current);
  }
  return current;
}

function candidateSdkArtifacts(directory, env) {
  run(pnpm, ["--filter", "@regenic/connector-test-utils...", "run", "build"], { env });
  mkdirSync(directory);
  const packages = {};
  for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
    const packageDir = join(repo, "packages", name);
    const output = run(pnpm, ["pack", "--pack-destination", directory], {
      cwd: packageDir,
      env,
      capture: true,
    });
    const tarball = packedArtifact(output, directory);
    packages[name] = {
      path: tarball,
      sha512: hash(tarball),
      version: JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version,
    };
  }
  return packages;
}

function assertInstalledTarball(prefix, name, artifact, actual) {
  const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
  const lockEntry = Object.entries(lock.packages ?? {})
    .find(([key]) => key.replaceAll("\\", "/").endsWith(`/node_modules/@regenic/${name}`))?.[1];
  if (!lockEntry?.resolved || !lockEntry?.integrity) {
    throw new Error(`Candidate SDK lock entry is missing file resolution or integrity: ${name}`);
  }
  const lockTarball = realpathSync(resolve(prefix, lockEntry.resolved.replace(/^file:/, "")));
  if (lockTarball !== realpathSync(artifact.path)) {
    throw new Error(`Candidate SDK ${name} did not resolve from its packed tarball`);
  }
  const expectedIntegrity = `sha512-${Buffer.from(artifact.sha512, "hex").toString("base64")}`;
  if (lockEntry.integrity !== expectedIntegrity) {
    throw new Error(`Candidate SDK ${name} lock integrity does not match packed tarball`);
  }
  const expectedManifest = realpathSync(join(prefix, "node_modules", "@regenic", name, "package.json"));
  assertCandidatePackage(actual, { manifest_realpath: expectedManifest, version: artifact.version }, artifact.version);
  return {
    ...actual,
    tarball_sha512: artifact.sha512,
    lock_resolved: lockEntry.resolved,
    lock_integrity: lockEntry.integrity,
  };
}

function installCandidateSdk(packages, prefix, env) {
  mkdirSync(prefix);
  run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix,
    ...Object.values(packages).map((item) => item.path),
  ], { env });
  const consumerRequire = createRequire(join(prefix, "entry.cjs"));
  const resolved = {};
  for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
    resolved[name] = assertInstalledTarball(
      prefix,
      name,
      packages[name],
      packageInfo(consumerRequire, `@regenic/${name}`),
    );
  }
  return resolved;
}

function runCoreLoader(pluginDir, env, candidateContract, copilotZodOverride) {
  const childEnv = {
    ...env,
    ...(candidateContract ? {
      EXPECTED_CANDIDATE_CONTRACT_MANIFEST: candidateContract.manifest_realpath,
      EXPECTED_CANDIDATE_CONTRACT_VERSION: candidateContract.version,
    } : {}),
    ...(copilotZodOverride ? {
      EXPECTED_COPILOT_ZOD_VERSION: "4.6.7",
      COPILOT_ZOD_OVERRIDE: copilotZodOverride,
    } : {}),
  };
  return JSON.parse(run(process.execPath, [
    join(repo, "scripts/testing/core-loader-probe.cjs"),
    pluginDir,
  ], { env: childEnv, capture: true }));
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
  if (sdk === "stable") {
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
  let linkedStableSdk = false;
  if (existsSync(linkScript) && sdk === "stable") {
    stage = "link-regenic";
    run(process.execPath, [linkScript, "--required"], { cwd: source, env });
    linkedStableSdk = true;
  }

  const sourceRequire = createRequire(join(packageDir, "package.json"));
  const sourceContract = packageInfo(sourceRequire, "@regenic/connector-contract");
  assertPackageVersion(sourceContract, expectedSdk, "Connector frozen source dependency");
  record.source_build_sdk = {
    origin: linkedStableSdk ? "stable-published-sdk-link" : "connector-lockfile-registry-resolution",
    contract: sourceContract,
    lock_sha512: existsSync(join(source, "pnpm-lock.yaml"))
      ? hash(join(source, "pnpm-lock.yaml"))
      : hash(join(source, "package-lock.json")),
  };

  stage = "build";
  run(pnpm, ["-r", "--if-present", "run", "build"], { cwd: source, env });
  stage = "typecheck";
  run(pnpm, ["-r", "--if-present", "run", "typecheck"], { cwd: source, env });
  stage = "connector-tests";
  run(pnpm, ["-r", "--if-present", "run", "test"], { cwd: source, env });

  stage = "core-loader-build";
  run(pnpm, ["--filter", "@regenic/api...", "run", "build"], { env });
  let candidatePackages;
  let candidateSdkResolved;
  let candidatePrefix;
  if (sdk === "candidate") {
    stage = "candidate-sdk-pack";
    candidatePackages = candidateSdkArtifacts(join(root, "candidate-packs"), env);
    candidatePrefix = join(root, "candidate-sdk-consumer");
    candidateSdkResolved = installCandidateSdk(candidatePackages, candidatePrefix, env);
    record.candidate_sdk = {
      packages: Object.fromEntries(Object.entries(candidateSdkResolved).map(([name, info]) => [
        name,
        {
          version: info.version,
          manifest_realpath: info.manifest_realpath,
          tarball_sha512: info.tarball_sha512,
          lock_resolved: info.lock_resolved,
          lock_integrity: info.lock_integrity,
        },
      ])),
    };
  }

  if (consumerMode === "clone-root-core-loader") {
    stage = "root-audit";
    record.root_audit = runAuditNonGating(source, env);

    stage = "copilot-zod-runtime";
    const sdkEntry = sourceRequire.resolve("@github/copilot-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const sdkZod = packageInfo(sdkRequire, "zod");
    const hostPkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const pnpmOverrides = hostPkg.pnpm?.overrides ?? {};
    const zodOverride = pnpmOverrides.zod
      ?? pnpmOverrides["@github/copilot-sdk@1.0.28>zod"]
      ?? hostPkg.overrides?.zod;
    assertRuntimeOverride(zodOverride, sdkZod, "4.6.7", "Copilot SDK Zod");

    stage = "clone-root-core-loader";
    const loaderPlugin = join(root, "core-loader-plugin");
    mkdirSync(loaderPlugin);
    cpSync(join(packageDir, "dist"), join(loaderPlugin, "dist"), { recursive: true });
    writeFileSync(join(loaderPlugin, "package.json"), readFileSync(packageJsonPath));
    const candidateNodeModules = candidatePrefix ? join(candidatePrefix, "node_modules") : "";
    const nodePath = [candidateNodeModules, join(source, "node_modules")]
      .filter(Boolean)
      .join(process.platform === "win32" ? ";" : ":");
    const coreLoader = runCoreLoader(
      loaderPlugin,
      { ...env, NODE_PATH: nodePath },
      candidateSdkResolved?.["connector-contract"],
      zodOverride,
    );
    record.core_loader = coreLoader;
    record.copilot_zod = {
      override: zodOverride,
      sdk_entry: sdkEntry,
      actual_version: sdkZod.version,
      manifest_realpath: sdkZod.manifest_realpath,
    };
    record.consumer_contract = {
      source_build: sourceContract,
      core_loader_plugin: coreLoader.plugin_contract,
      candidate_load: coreLoader.plugin_contract,
      physical_instance_equality_required: false,
    };
  } else if (consumerMode === "packed-npm") {
    stage = "connector-pack";
    const packDir = join(root, "connector-packs");
    mkdirSync(packDir);
    const packedJson = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageDir, env, capture: true,
    }));
    const tarball = join(packDir, packedJson[0].filename);
    const tarballSha512 = hash(tarball);
    const prefix = join(root, "consumer");
    const sdkPackages = sdk === "candidate"
      ? Object.values(candidatePackages).map((item) => item.path)
      : [
          "@regenic/connector-contract@0.2.0",
          "@regenic/plugin-host@0.1.0",
          "@regenic/connector-test-utils@0.1.0",
        ];
    run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      "--prefix", prefix, ...sdkPackages, tarball], { env });
    stage = "core-loader-packed-consumer";
    const consumerRequire = createRequire(join(prefix, "entry.cjs"));
    const installedRoot = packageRoot(dirname(consumerRequire.resolve(connector.package_name)));
    const installedManifestPath = join(installedRoot, "package.json");
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    if (installedManifest.regenic?.plugin !== true) throw new Error("Packed connector lacks regenic.plugin manifest");
    if (installedManifest.regenic.engines?.regenic !== "1.0") throw new Error("Packed connector declares unsupported Regenic host protocol");
    const pluginRequire = createRequire(join(installedRoot, "package.json"));
    const pluginContract = packageInfo(pluginRequire, "@regenic/connector-contract");
    assertPackageVersion(pluginContract, expectedSdk, "Packed connector contract");
    let installedCandidateContract;
    if (sdk === "candidate") {
      installedCandidateContract = assertInstalledTarball(
        prefix,
        "connector-contract",
        candidatePackages["connector-contract"],
        pluginContract,
      );
      record.consumer_contract = {
        plugin: installedCandidateContract,
      };
    }
    const coreLoader = runCoreLoader(installedRoot, env, installedCandidateContract);
    record.core_loader = coreLoader;
    record.connector_tarball_sha512 = tarballSha512;
    record.consumer_contract ??= {
      plugin: pluginContract,
    };
    record.package_contributions = installedManifest.regenic.contributes;
  } else {
    throw new Error(`Unsupported consumer_mode: ${consumerMode}`);
  }
  record.contract_range = connector.contract_range;
  record.package_version = packageJson.version;
  record.connector_lock_sha512 = existsSync(join(source, "pnpm-lock.yaml"))
    ? hash(join(source, "pnpm-lock.yaml"))
    : hash(join(source, "package-lock.json"));
  record.status = "passed";
} finally {
  rmSync(shortTmp, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  const output = join(repo, "coverage/test-evidence");
  mkdirSync(output, { recursive: true });
  const name = `compatibility-${id}-${sdk}`;
  record.failed_stage = record.status === "failed" ? stage : undefined;
  writeFileSync(join(output, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
