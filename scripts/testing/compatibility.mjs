import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  evidence, hash, isolatedEnvironment, packedArtifact, pnpm, provenance, repo,
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
const root = temporaryRoot(`compat-${id}-${sdk}`);
const source = join(root, "source");
const env = {
  ...isolatedEnvironment(root), npm_config_manage_package_manager_versions: "false",
  ...(sdk === "candidate" ? { REGENIC_ROOT: repo } : {}),
};
const record = {
  ...provenance(), core_source_sha: run("git", ["rev-parse", "HEAD"], { capture: true }),
  connector: id, repository: connector.repository,
  connector_source_sha: connector.source_sha, sdk_mode: sdk, expected_contract: expectedSdk,
  status: "failed", automatic_mode: manifest.automatic_mode,
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
  if (packageJson.name !== connector.package_name) throw new Error(`Package mismatch: expected ${connector.package_name}, got ${packageJson.name}`);
  const sdkRoot = join(root, "sdk");
  if (sdk === "candidate") {
    env.REGENIC_ROOT = repo;
    record.candidate_packages = {};
    for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
      const output = run(pnpm, ["pack", "--pack-destination", root], {
        cwd: join(repo, "packages", name), env, capture: true,
      });
      record.candidate_packages[name] = packedArtifact(output, root);
    }
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
  run(pnpm, ["install", "--frozen-lockfile"], { cwd: source, env });
  stage = "build";
  run(pnpm, ["-r", "--if-present", "run", "build"], { cwd: source, env });
  stage = "typecheck";
  run(pnpm, ["-r", "--if-present", "run", "typecheck"], { cwd: source, env });
  stage = "connector-tests";
  run(pnpm, ["-r", "--if-present", "run", "test"], { cwd: source, env });

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
    ? Object.values(record.candidate_packages)
    : ["@regenic/connector-contract@0.2.0", "@regenic/plugin-host@0.1.0",
      "@regenic/connector-test-utils@0.1.0"];
  run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    "--prefix", prefix, ...sdkPackages, tarball], { env });
  stage = "packed-load";
  const consumerRequire = await import("node:module").then(({ createRequire }) => createRequire(join(prefix, "entry.cjs")));
  const plugin = consumerRequire(connector.package_name);
  let installedPackageRoot = dirname(consumerRequire.resolve(connector.package_name));
  while (installedPackageRoot !== dirname(installedPackageRoot) && !existsSync(join(installedPackageRoot, "package.json"))) {
    installedPackageRoot = dirname(installedPackageRoot);
  }
  const installedManifestPath = resolve(installedPackageRoot, "package.json");
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
  if (installedManifest.regenic?.plugin !== true) throw new Error("Packed connector lacks regenic.plugin manifest");
  if (installedManifest.regenic.engines?.regenic !== "1.0") throw new Error("Packed connector declares unsupported Regenic host protocol");
  const contract = consumerRequire("@regenic/connector-contract");
  if (contract.CONNECTOR_PROTOCOL !== "1.0") throw new Error(`Unexpected contract protocol ${contract.CONNECTOR_PROTOCOL}`);
  let contractRoot = dirname(consumerRequire.resolve("@regenic/connector-contract"));
  while (contractRoot !== dirname(contractRoot) && !existsSync(join(contractRoot, "package.json"))) {
    contractRoot = dirname(contractRoot);
  }
  const contractVersion = JSON.parse(readFileSync(join(contractRoot, "package.json"), "utf8")).version;
  if (contractVersion !== expectedSdk) throw new Error(`Expected contract ${expectedSdk}, got ${contractVersion}`);
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
  record.installed_contract_version = contractVersion;
  record.package_contributions = installedManifest.regenic.contributes;
  record.status = "passed";
} finally {
  rmSync(root, { recursive: true, force: true });
  const output = join(repo, "coverage/test-evidence");
  mkdirSync(output, { recursive: true });
  const name = `compatibility-${id}-${sdk}`;
  const { writeFileSync } = await import("node:fs");
  record.failed_stage = record.status === "failed" ? stage : undefined;
  delete record.candidate_packages;
  writeFileSync(join(output, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
