import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseDataRoot } from "./data-directory.ts";

export const STORE_LOCK_NAME = "regenic.store.lock";

export interface StoreLockHolder {
  pid: number;
  origin?: string;
  updatedAt: string;
}

export interface StoreLockIo {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, body: string) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  mkdir?: (path: string) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => string;
}

export type StoreLockState =
  | { state: "absent" }
  | { state: "ours"; lock: StoreLockHolder }
  | { state: "stale"; lock: StoreLockHolder }
  | { state: "held"; lock: StoreLockHolder };

export function storeLockPath(dataRoot: string): string {
  return join(parseDataRoot(dataRoot), STORE_LOCK_NAME);
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function inspectStoreLock(
  dataRoot: string,
  ourPid: number,
  io: StoreLockIo = {},
): StoreLockState {
  const file = storeLockPath(dataRoot);
  const exists = io.exists ?? existsSync;
  if (!exists(file)) {
    return { state: "absent" };
  }
  let raw: string;
  try {
    raw = io.readFile?.(file) ?? readFileSync(file, "utf8");
  } catch {
    return { state: "stale", lock: { pid: 0, updatedAt: "" } };
  }
  const lock = parseStoreLock(raw);
  if (!lock) {
    return { state: "stale", lock: { pid: 0, updatedAt: "" } };
  }
  if (lock.pid === ourPid) {
    return { state: "ours", lock };
  }
  const alive = (io.isAlive ?? processAlive)(lock.pid);
  return { state: alive ? "held" : "stale", lock };
}

export function storeLockHeldByOther(
  dataRoot: string,
  ourPid: number,
  io: StoreLockIo = {},
): boolean {
  return inspectStoreLock(dataRoot, ourPid, io).state === "held";
}

export function acquireStoreLock(
  dataRoot: string,
  holder: { pid: number; origin?: string },
  io: StoreLockIo = {},
): StoreLockHolder {
  const inspected = inspectStoreLock(dataRoot, holder.pid, io);
  if (inspected.state === "held") {
    throw new Error("settings.dataDirReasonHeld");
  }
  const lock: StoreLockHolder = {
    pid: holder.pid,
    ...(holder.origin ? { origin: holder.origin } : {}),
    updatedAt: io.now?.() ?? new Date().toISOString(),
  };
  const file = storeLockPath(dataRoot);
  const tmp = `${file}.${holder.pid}.tmp`;
  const mkdir = io.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  mkdir(dirname(file));
  const write = io.writeFile ?? ((path, body) => writeFileSync(path, body));
  const rename = io.rename ?? renameSync;
  write(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  rename(tmp, file);
  return lock;
}

export function releaseStoreLock(
  dataRoot: string,
  ourPid: number,
  io: StoreLockIo = {},
): void {
  const inspected = inspectStoreLock(dataRoot, ourPid, io);
  if (inspected.state !== "ours") {
    return;
  }
  const file = storeLockPath(dataRoot);
  const remove = io.remove ?? ((path: string) => rmSync(path, { force: true }));
  remove(file);
}

function parseStoreLock(raw: string): StoreLockHolder | null {
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      origin?: unknown;
      updatedAt?: unknown;
    };
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) {
      return null;
    }
    return {
      pid: Number(parsed.pid),
      ...(typeof parsed.origin === "string" && parsed.origin
        ? { origin: parsed.origin }
        : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}
