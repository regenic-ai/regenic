import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  equalPath,
  STORE_DB,
  STORE_META_FILE,
  STORE_RELOCATED_FILE,
  storePaths,
  tryParseDataRoot,
  type DataDirectoryAction,
  type ResolvedDataPaths,
} from "./data-directory.ts";

export const STORE_META_NAME = STORE_META_FILE;
export const STORE_RELOCATED_NAME = STORE_RELOCATED_FILE;

export interface StoreIdentity {
  id: string;
}

export interface StoreRelocation {
  to: string;
  at: string;
  storeId: string;
}

export interface StoreIdentityIo {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, body: string) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  mkdir?: (path: string) => void;
  now?: () => string;
  randomId?: () => string;
}

export function storeMetaPath(root: string): string {
  return join(root, STORE_META_NAME);
}

export function storeRelocationPath(root: string): string {
  return join(root, STORE_RELOCATED_NAME);
}

export function newStoreId(io: StoreIdentityIo = {}): string {
  return io.randomId?.() ?? randomUUID();
}

export function readStoreIdentity(
  root: string,
  io: StoreIdentityIo = {},
): StoreIdentity | null {
  return parseIdentity(readJson(storeMetaPath(root), io));
}

export function writeStoreIdentity(
  root: string,
  identity: StoreIdentity,
  io: StoreIdentityIo = {},
): StoreIdentity {
  writeJson(storeMetaPath(root), { id: identity.id }, io);
  return identity;
}

export function ensureStoreIdentity(
  root: string,
  io: StoreIdentityIo = {},
): StoreIdentity {
  return readStoreIdentity(root, io) ?? writeStoreIdentity(root, { id: newStoreId(io) }, io);
}

export function readStoreRelocation(
  root: string,
  io: StoreIdentityIo = {},
): StoreRelocation | null {
  return parseRelocation(readJson(storeRelocationPath(root), io));
}

export function writeStoreRelocation(
  from: string,
  to: string,
  storeId: string,
  io: StoreIdentityIo = {},
): StoreRelocation {
  const relocation: StoreRelocation = {
    to,
    storeId,
    at: io.now?.() ?? new Date().toISOString(),
  };
  writeJson(storeRelocationPath(from), relocation, io);
  return relocation;
}

export function clearStoreRelocation(root: string, io: StoreIdentityIo = {}): void {
  const file = storeRelocationPath(root);
  const exists = io.exists ?? existsSync;
  if (!exists(file)) {
    return;
  }
  const remove = io.remove ?? ((path: string) => rmSync(path, { force: true }));
  remove(file);
}

export function followStoreRelocation(
  root: string,
  io: StoreIdentityIo = {},
): string | null {
  const relocation = readStoreRelocation(root, io);
  if (!relocation) {
    return null;
  }
  const dest = tryParseDataRoot(relocation.to);
  if (!dest || equalPath(dest, root)) {
    return null;
  }
  const exists = io.exists ?? existsSync;
  if (!exists(join(dest, STORE_DB))) {
    return null;
  }
  const destId = readStoreIdentity(dest, io);
  if (destId && destId.id !== relocation.storeId) {
    return null;
  }
  return dest;
}

export function applyStoreRelocation(
  resolved: ResolvedDataPaths,
  io: StoreIdentityIo = {},
): ResolvedDataPaths {
  if (resolved.envOverride || resolved.source === "settings") {
    return resolved;
  }
  const dest = followStoreRelocation(resolved.dataRoot, io);
  if (!dest) {
    return resolved;
  }
  const paths = storePaths(dest);
  return {
    ...resolved,
    ...paths,
    source: "relocated",
    relocatedFrom: resolved.dataRoot,
  };
}

export function prepareDestinationStore(
  dest: string,
  action: DataDirectoryAction,
  source: string,
  io: StoreIdentityIo = {},
): StoreIdentity {
  if (action === "migrate" || action === "replace") {
    clearStoreRelocation(dest, io);
    return writeStoreIdentity(dest, ensureStoreIdentity(source, io), io);
  }
  if (action === "adopt" && readStoreRelocation(dest, io)) {
    clearStoreRelocation(dest, io);
    return writeStoreIdentity(dest, { id: newStoreId(io) }, io);
  }
  if (action === "empty") {
    return writeStoreIdentity(dest, { id: newStoreId(io) }, io);
  }
  return ensureStoreIdentity(dest, io);
}

export function sealSourceStore(
  source: string,
  dest: string,
  action: DataDirectoryAction,
  identity: StoreIdentity,
  io: StoreIdentityIo = {},
): void {
  if (action !== "migrate" && action !== "replace") {
    return;
  }
  writeStoreRelocation(source, dest, identity.id, io);
}

export function reclaimStoreIfRelocated(
  root: string,
  io: StoreIdentityIo = {},
): boolean {
  const relocation = readStoreRelocation(root, io);
  if (!relocation || equalPath(relocation.to, root)) {
    if (relocation) {
      clearStoreRelocation(root, io);
    }
    ensureStoreIdentity(root, io);
    return false;
  }
  clearStoreRelocation(root, io);
  writeStoreIdentity(root, { id: newStoreId(io) }, io);
  return true;
}

function readJson(file: string, io: StoreIdentityIo): unknown {
  const exists = io.exists ?? existsSync;
  if (!exists(file)) {
    return null;
  }
  try {
    return JSON.parse(io.readFile?.(file) ?? readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, body: unknown, io: StoreIdentityIo): void {
  const mkdir = io.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  mkdir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const write = io.writeFile ?? ((path, next) => writeFileSync(path, next));
  const rename = io.rename ?? renameSync;
  write(tmp, `${JSON.stringify(body, null, 2)}\n`);
  rename(tmp, file);
}

function parseIdentity(raw: unknown): StoreIdentity | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) {
    return null;
  }
  return { id: id.trim() };
}

function parseRelocation(raw: unknown): StoreRelocation | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const body = raw as { to?: unknown; at?: unknown; storeId?: unknown };
  const to = tryParseDataRoot(body.to);
  if (!to || typeof body.storeId !== "string" || !body.storeId.trim()) {
    return null;
  }
  return {
    to,
    storeId: body.storeId.trim(),
    at: typeof body.at === "string" ? body.at : "",
  };
}
