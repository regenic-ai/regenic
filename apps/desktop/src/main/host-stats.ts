import { execFile } from "node:child_process";
import { readdir, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  classifyDisk,
  classifyMemory,
  diskHint,
  memoryHint,
  rememberKernelSample,
  volumeFromStatfs,
  type HostStats,
} from "../shared/host-watch";

const DATA_TTL_MS = 15_000;
const MAX_DATA_FILES = 20_000;
const execFileAsync = promisify(execFile);

export interface HostStatPaths {
  database: string;
  blobRoot: string;
}

export interface HostStatDeps {
  now?: () => number;
  statfs?: typeof statfs;
  fileSize?: (path: string) => Promise<number>;
  directorySize?: (path: string) => Promise<number>;
  sidecarPid?: number | null;
  listenPort?: number | null;
  appBytes?: () => number;
  processRss?: (pid: number) => Promise<number | null>;
  processAlive?: (pid: number) => boolean;
  listenPid?: (port: number) => Promise<number | null>;
}

let dataCache: { at: number; bytes: number } | null = null;
let lastKernel: { pid: number; bytes: number } | null = null;
let lastSeenPid: number | null = null;

export async function collectHostStats(
  paths: HostStatPaths,
  deps: HostStatDeps = {},
): Promise<HostStats> {
  const now = deps.now ?? Date.now;
  const readFs = deps.statfs ?? statfs;
  const volumePath = dirname(paths.database);
  const fs = await readVolume(volumePath, readFs);
  const dataBytes = await readDataBytes(paths, now(), deps);
  const diskKind = classifyDisk(fs);
  const sampled = await sampleAppMemory(deps);
  const memoryKind = classifyMemory(sampled);
  return {
    disk: {
      kind: diskKind,
      total_bytes: fs.total_bytes,
      free_bytes: fs.free_bytes,
      used_bytes: Math.max(0, fs.total_bytes - fs.free_bytes),
      data_bytes: dataBytes,
      path: volumePath,
      hint: diskHint(diskKind),
    },
    memory: {
      kind: memoryKind,
      kernel_bytes: sampled.kernel_bytes,
      app_bytes: sampled.app_bytes,
      used_bytes: (sampled.kernel_bytes ?? 0) + sampled.app_bytes,
      kernel_alive: sampled.kernel_alive,
      hint: memoryHint({ ...sampled, kind: memoryKind }),
    },
  };
}

export function resetHostStatCache(): void {
  dataCache = null;
  lastKernel = null;
  lastSeenPid = null;
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

export async function processRssBytes(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim().split(/\s+/).pop());
    if (!Number.isFinite(kb) || kb < 0) {
      return null;
    }
    return Math.round(kb * 1024);
  } catch {
    return null;
  }
}

export async function listenPid(port: number): Promise<number | null> {
  if (!Number.isInteger(port) || port < 1) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function sampleAppMemory(deps: HostStatDeps): Promise<{
  kernel_bytes: number | null;
  app_bytes: number;
  kernel_alive: boolean | null;
}> {
  const appBytes = Math.max(0, deps.appBytes?.() ?? 0);
  const pid = await resolveKernelPid(deps);
  let alive: boolean | null = null;
  let rss: number | null = null;
  if (pid) {
    alive = (deps.processAlive ?? processAlive)(pid);
    if (alive) {
      rss = await (deps.processRss ?? processRssBytes)(pid);
    }
  }
  const remembered = rememberKernelSample({
    pid,
    alive,
    rss,
    previous: lastKernel,
  });
  lastKernel = remembered.previous;
  return {
    kernel_bytes: remembered.kernel_bytes,
    app_bytes: appBytes,
    kernel_alive: remembered.kernel_alive,
  };
}

async function resolveKernelPid(deps: HostStatDeps): Promise<number | null> {
  if (typeof deps.sidecarPid === "number" && deps.sidecarPid > 0) {
    lastSeenPid = deps.sidecarPid;
    return deps.sidecarPid;
  }
  if (typeof deps.listenPort === "number" && deps.listenPort > 0) {
    const pid = await (deps.listenPid ?? listenPid)(deps.listenPort);
    if (pid) {
      lastSeenPid = pid;
      return pid;
    }
  }
  return lastSeenPid;
}

async function readVolume(
  path: string,
  readFs: typeof statfs,
): Promise<{ total_bytes: number; free_bytes: number }> {
  try {
    return volumeFromStatfs(await readFs(path));
  } catch {
    return { total_bytes: 0, free_bytes: 0 };
  }
}

async function readDataBytes(
  paths: HostStatPaths,
  now: number,
  deps: HostStatDeps,
): Promise<number> {
  if (dataCache && now - dataCache.at < DATA_TTL_MS) {
    return dataCache.bytes;
  }
  const fileSize = deps.fileSize ?? statSize;
  const directorySize = deps.directorySize ?? walkDirectorySize;
  const db = await fileSize(paths.database);
  const blobs = await directorySize(paths.blobRoot);
  const bytes = db + blobs;
  dataCache = { at: now, bytes };
  return bytes;
}

async function statSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function walkDirectorySize(root: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      break;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= MAX_DATA_FILES) {
        return total;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      seen += 1;
      total += await statSize(full);
    }
  }
  return total;
}
