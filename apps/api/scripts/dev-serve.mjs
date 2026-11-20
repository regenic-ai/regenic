import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  nodeOptionsWithHeap,
  restartDelayMs,
  shouldRecycleWatcher,
} = require("./api-process.cjs");
const tsxCli = require.resolve("tsx/cli");
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const PROBE_MS = 5_000;

let child = null;
let stopping = false;
let everListened = false;
let misses = 0;
let restartAttempt = 0;
let probeTimer = null;

function probePort(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function clearProbe() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

async function checkListen(port, host) {
  if (!child || stopping) return;
  const open = await probePort(port, host);
  if (!child || stopping) return;
  if (open) {
    everListened = true;
    misses = 0;
    restartAttempt = 0;
    return;
  }
  if (!everListened) return;
  misses += 1;
  if (!shouldRecycleWatcher({
    everListened,
    misses,
    stopping,
    childAlive: true,
  })) {
    return;
  }
  console.error(`[api] port ${port} is not listening; restarting tsx watch`);
  misses = 0;
  child.kill("SIGTERM");
}

function startChild() {
  const port = Number(process.env.PORT) || 3000;
  const host = "127.0.0.1";
  everListened = false;
  misses = 0;
  child = spawn(process.execPath, [tsxCli, "watch", "src/main.ts"], {
    cwd: apiRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithHeap(process.env.NODE_OPTIONS),
    },
  });
  child.on("exit", (code, signal) => {
    child = null;
    clearProbe();
    if (stopping) {
      process.exit(code ?? 0);
    }
    const delay = restartDelayMs(restartAttempt);
    restartAttempt += 1;
    console.error(
      `[api] tsx watch exited code=${code ?? "null"} signal=${signal ?? "none"}; restarting in ${delay}ms`,
    );
    setTimeout(startChild, delay);
  });
  probeTimer = setInterval(() => {
    void checkListen(port, host);
  }, PROBE_MS);
  probeTimer.unref?.();
}

function shutdown(signal) {
  stopping = true;
  clearProbe();
  if (child) child.kill(signal);
  else process.exit(0);
}

const invoked = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (invoked) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  startChild();
}
