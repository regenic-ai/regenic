import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  inspectStoreLock,
  type StoreLockState,
} from "./store-lock.ts";

const SIDECAR_MARK = "api/dist/main.js";

export function isSidecarCommand(command: string): boolean {
  return command.includes(SIDECAR_MARK);
}

/** Pid still listening on a kernel port after its owner is gone. */
export function leftoverListenerPid(input: {
  lock: StoreLockState;
  port: number;
  listenPid: number | null;
  ourPid: number;
  ownsDatabase: boolean;
  command: string | null;
}): number | null {
  if (input.lock.state === "held" || input.lock.state === "ours") return null;
  const pid = input.listenPid;
  if (!pid || pid === input.ourPid) return null;
  if (input.ownsDatabase) return pid;
  if (input.lock.state !== "stale") return null;
  const lockPort = originPort(input.lock.lock.origin);
  if (lockPort !== input.port) return null;
  if (input.lock.lock.sidecarPid === pid) return pid;
  if (input.command && isSidecarCommand(input.command)) return pid;
  return null;
}

export async function terminatePid(
  pid: number,
  deps: {
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
    graceMs?: number;
    killWaitMs?: number;
  } = {},
): Promise<boolean> {
  const isAlive = deps.isAlive ?? processAlive;
  const kill = deps.kill ?? ((target, signal) => {
    process.kill(target, signal);
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  const graceMs = deps.graceMs ?? 1_000;
  const killWaitMs = deps.killWaitMs ?? 1_000;
  if (!isAlive(pid)) return true;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }
  const termUntil = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < termUntil) await sleep(50);
  if (!isAlive(pid)) return true;
  try {
    kill(pid, "SIGKILL");
  } catch {
    return !isAlive(pid);
  }
  const killUntil = Date.now() + killWaitMs;
  while (isAlive(pid) && Date.now() < killUntil) await sleep(50);
  return !isAlive(pid);
}

export async function reapLeftoverKernel(input: {
  dataRoot: string;
  ourPid: number;
  ports: number[];
  ownsDatabase: (origin: string) => Promise<boolean>;
  listenPid?: (port: number) => Promise<number | null>;
  command?: (pid: number) => Promise<string | null>;
  terminate?: (pid: number) => Promise<boolean>;
  inspect?: (dataRoot: string, ourPid: number) => StoreLockState;
}): Promise<boolean> {
  const inspect = input.inspect ?? inspectStoreLock;
  const listen = input.listenPid ?? listenPortPid;
  const commandOf = input.command ?? processCommand;
  const terminate = input.terminate ?? ((pid: number) => terminatePid(pid));
  let freed = true;
  for (const port of input.ports) {
    const origin = `http://127.0.0.1:${port}`;
    const listening = await listen(port);
    const lock = inspect(input.dataRoot, input.ourPid);
    const ownsDatabase = listening ? await input.ownsDatabase(origin) : false;
    const command = listening && !ownsDatabase ? await commandOf(listening) : null;
    const pid = leftoverListenerPid({
      lock,
      port,
      listenPid: listening,
      ourPid: input.ourPid,
      ownsDatabase,
      command,
    });
    if (!pid) continue;
    if (!await terminate(pid)) freed = false;
  }
  return freed;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listenPortPid(port: number): Promise<number | null> {
  if (!Number.isInteger(port) || port < 1) return null;
  try {
    const { stdout } = await promisify(execFile)("lsof", [
      "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t",
    ]);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function originPort(origin: string | undefined): number | null {
  if (!origin) return null;
  try {
    const port = Number(new URL(origin).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function processCommand(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await promisify(execFile)("ps", ["-o", "command=", "-p", String(pid)]);
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
