import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function run(command, args, options = {}) {
  const { capture = false, ...rest } = options;
  const result = spawnSync(command, args, {
    cwd: repo, timeout: 20 * 60_000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", ...rest,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Captured output is deliberately not copied into uploaded evidence.
    if (capture) process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  }
  return result.stdout?.trim();
}

export function packedArtifact(output, directory) {
  const filename = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith(".tgz"));
  if (!filename) throw new Error("Package pack command did not report a .tgz artifact");
  return isAbsolute(filename) ? filename : join(directory, filename);
}

export function isolatedEnvironment(root) {
  const env = {};
  for (const name of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL",
    "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"]) {
    env[name] = join(root, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  return {
    ...env, CI: "true", NO_COLOR: "1",
    npm_config_manage_package_manager_versions: "false",
    REGENIC_PLUGIN_DIR: join(root, "plugins"),
    REGENIC_MODEL_DRIVER: "none", REGENIC_EMBEDDING_DRIVER: "none",
    REGENIC_CONNECTOR_PULL_MS: "0", REGENIC_CONNECTOR_BOOTSTRAP_MS: "0",
  };
}

export function temporaryRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `regenic-test-${prefix}-`));
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

export function hash(path) {
  return createHash("sha512").update(readFileSync(path)).digest("hex");
}

export function provenance() {
  return {
    source_sha: run("git", ["rev-parse", "HEAD"], { capture: true }),
    dirty: Boolean(run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true })),
    node: process.version, platform: process.platform, arch: process.arch,
    pnpm: run(pnpm, ["--version"], { capture: true }),
    lock_sha512: hash(join(repo, "pnpm-lock.yaml")),
  };
}

export function evidence(name, value) {
  const directory = resolve(process.env.REGENIC_TEST_OUTPUT ?? join(repo, "coverage/test-evidence"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export function requireRuntime(versions = process.versions) {
  const [major, minor] = versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 14) || major >= 24) || !(Number(versions.napi) >= 10)) {
    throw new Error("Testing lanes require Node 22.14+ (22.x) or Node 24+ with Node-API 10+. better-sqlite3 13 requires Node-API 10; older runtimes can crash when opening a database.");
  }
}
