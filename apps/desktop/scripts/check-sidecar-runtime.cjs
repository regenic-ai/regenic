const { execFileSync } = require("node:child_process");
const { basename, resolve } = require("node:path");

const npmNode = process.env.npm_node_execpath;
const nodeBinary = process.env.NODE_BINARY ??
  (npmNode && /^node(?:\.exe)?$/i.test(basename(npmNode)) ? npmNode : "node");
const authorityStore = resolve(__dirname, "../../../packages/authority-store");
const betterSqlite3 = resolve(authorityStore, "node_modules/better-sqlite3");

function runNode(args) {
  return execFileSync(nodeBinary, args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  const electronVersion = execFileSync(
    require("electron"),
    ["-p", "process.versions.electron"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 20_000,
    },
  ).trim();
  if (electronVersion !== require("electron/package.json").version) {
    throw new Error(`Unexpected Electron runtime version: ${electronVersion}`);
  }
} catch (error) {
  fail(
    `The desktop Electron runtime is missing or cannot start. Run pnpm install --frozen-lockfile && pnpm rebuild electron, then retry.\n${error.stderr?.trim() || error.message}`,
  );
}

let version;
try {
  version = runNode(["-p", "process.versions.node"]);
} catch (error) {
  fail(`Could not run the local kernel's Node executable (${nodeBinary}): ${error.message}`);
}

const [major, minor] = version.split(".").map(Number);
if (
  !((major === 22 && minor >= 12) || (major === 24 && minor >= 12) || major === 26)
) {
  fail(
    `Unsupported local kernel Node.js ${version}. Use the CI-validated Node 22.12+, 24.12+, or 26.x runtime; set NODE_BINARY to an absolute path when the desktop host uses another Node version.`,
  );
}

try {
  const sqliteProbe =
    `const Database = require(${JSON.stringify(betterSqlite3)}); ` +
    "new Database(':memory:').close()";
  runNode(["-e", sqliteProbe]);
} catch (error) {
  const detail = error.stderr?.trim() || error.message;
  fail(
    `The local kernel cannot load better-sqlite3 under Node ${version}. Reinstall dependencies using the same Node runtime, or set NODE_BINARY to a supported Node executable.\n${detail}`,
  );
}
