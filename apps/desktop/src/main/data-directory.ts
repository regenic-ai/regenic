import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export const STORE_DB = "regenic.db";
export const STORE_BLOBS = "blobs";
export const STORE_FOLDER = "Regenic";
export const STORE_META_FILE = "regenic.store.json";
export const STORE_RELOCATED_FILE = "regenic.relocated.json";
export const STORE_LOCK_FILE = "regenic.store.lock";
export const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const MAX_FOOTPRINT_FILES = 20_000;

export type DataPathSource = "env" | "settings" | "repo" | "default" | "relocated";
export type DataDirectoryAction = "migrate" | "empty" | "adopt" | "replace";

export interface DataPaths {
  database: string;
  blobRoot: string;
  dataRoot: string;
}

export interface ResolvedDataPaths extends DataPaths {
  source: DataPathSource;
  envOverride: boolean;
  productRoot: string;
  checkoutRoot?: string;
  relocatedFrom?: string;
}

export interface DataDirectoryPlan {
  path: string;
  currentRoot: string;
  sameAsCurrent: boolean;
  sourceHasData: boolean;
  destHasData: boolean;
  destLooksLikeStore: boolean;
  remoteWarning: boolean;
  relocatedTo?: string;
  canChange: boolean;
  reason?: string;
}

export interface ResolveDataPathsInput {
  repoRoot: string;
  homeDir: string;
  dataRoot?: string | null;
  allowRepo?: boolean;
  env?: NodeJS.ProcessEnv | {
    REGENIC_DATABASE?: string;
    REGENIC_BLOB_ROOT?: string;
  };
  exists?: (path: string) => boolean;
}

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export function parseDataRoot(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("settings.dataDirReasonAbs");
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("settings.dataDirReasonAbs");
  }
  const next = normalize(resolve(trimmed));
  if (next.includes("\0")) {
    throw new Error("settings.dataDirReasonAbs");
  }
  return next;
}

export function tryParseDataRoot(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return parseDataRoot(raw);
  } catch {
    return undefined;
  }
}

export function storeLayoutSplit(paths: DataPaths): boolean {
  return (
    !equalPath(dirname(paths.database), paths.dataRoot) ||
    !equalPath(paths.blobRoot, join(paths.dataRoot, STORE_BLOBS))
  );
}

export function storePaths(root: string): DataPaths {
  const dataRoot = parseDataRoot(root);
  return {
    dataRoot,
    database: join(dataRoot, STORE_DB),
    blobRoot: join(dataRoot, STORE_BLOBS),
  };
}

export function nestVolumeRoot(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return path;
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed}\\${STORE_FOLDER}`;
  }
  return path;
}

export function looksLikeSqliteDatabase(
  file: string,
  readHeader: (file: string) => Buffer = readSqliteHeader,
): boolean {
  try {
    const header = readHeader(file);
    return header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
  } catch {
    return false;
  }
}

export function sidecarFiles(database: string): string[] {
  return SIDECAR_SUFFIXES.map((suffix) => `${database}${suffix}`);
}

export function kernelDatabaseMatches(
  expected: string,
  reported: string | null | undefined,
): boolean {
  if (!reported?.trim()) {
    return false;
  }
  return equalPath(expected, reported);
}

export function equalPath(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

export function isNestedPath(parent: string, child: string): boolean {
  const a = normalizePath(parent);
  const b = normalizePath(child);
  if (equalPath(a, b)) {
    return false;
  }
  const prefix = a.endsWith(sep) ? a : `${a}${sep}`;
  if (process.platform === "win32") {
    return b.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return b.startsWith(prefix);
}

export type VolumeKind = "remote" | "removable" | "fixed" | "unknown";

export interface ForbiddenDataRootOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
}

export interface InspectDataDirectoryOptions {
  volumeKind?: (path: string) => VolumeKind;
  systemRoot?: string;
  platform?: NodeJS.Platform;
}

const UNIX_SYSTEM_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/private",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/Applications",
  "/Library",
];

const windowsDriveKindCache = new Map<string, VolumeKind>();

export function isRemoteOrRemovablePath(
  path: string,
  volumeKind: (path: string) => VolumeKind = detectVolumeKind,
): boolean {
  const kind = volumeKind(path);
  if (kind === "remote" || kind === "removable") {
    return true;
  }
  const next = path.replace(/\\/g, "/");
  return (
    next.startsWith("//") ||
    next.startsWith("/Volumes/") ||
    next.startsWith("/mnt/") ||
    next.startsWith("/media/")
  );
}

export function isForbiddenDataRoot(
  path: string,
  options: ForbiddenDataRootOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const unix = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (unix === "/") {
    return true;
  }
  for (const prefix of UNIX_SYSTEM_PREFIXES) {
    if (unix === prefix || unix.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  if (platform !== "win32") {
    return false;
  }
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    return false;
  }
  const windows = winNorm(path);
  const winDir = winNorm(systemRoot);
  const driveRoot = winDir.slice(0, 2);
  if (windows === `${driveRoot}\\` || windows === driveRoot) {
    return true;
  }
  const blocked = [
    winDir,
    `${driveRoot}\\program files`,
    `${driveRoot}\\program files (x86)`,
    `${driveRoot}\\programdata`,
    `${driveRoot}\\recovery`,
    `${driveRoot}\\$recycle.bin`,
  ];
  return blocked.some((root) => windows === root || windows.startsWith(`${root}\\`));
}

export function detectVolumeKind(path: string): VolumeKind {
  const next = path.replace(/\\/g, "/");
  if (next.startsWith("//")) {
    return "remote";
  }
  if (process.platform !== "win32") {
    if (
      next.startsWith("/Volumes/") ||
      next.startsWith("/mnt/") ||
      next.startsWith("/media/")
    ) {
      return "removable";
    }
    return "unknown";
  }
  const letter = path.match(/^([A-Za-z]):/);
  if (!letter) {
    return "unknown";
  }
  const key = letter[1].toUpperCase();
  const cached = windowsDriveKindCache.get(key);
  if (cached) {
    return cached;
  }
  const kind = readWindowsDriveKind(key);
  windowsDriveKindCache.set(key, kind);
  return kind;
}

export function resolveDataPaths(input: ResolveDataPathsInput): ResolvedDataPaths {
  const exists = input.exists ?? existsSync;
  const envDb = trimEnv(input.env?.REGENIC_DATABASE);
  const envBlobs = trimEnv(input.env?.REGENIC_BLOB_ROOT);
  const envOverride = Boolean(envDb || envBlobs);
  const settingsRoot = tryParseDataRoot(input.dataRoot);
  const repoDb = join(input.repoRoot, STORE_DB);
  const repoBlobs = join(input.repoRoot, STORE_BLOBS);
  const defaultRoot = join(input.homeDir, ".regenic");

  let fallbackRoot: string;
  let source: DataPathSource;
  if (settingsRoot) {
    fallbackRoot = settingsRoot;
    source = "settings";
  } else if (input.allowRepo !== false && exists(repoDb)) {
    fallbackRoot = input.repoRoot;
    source = "repo";
  } else {
    fallbackRoot = defaultRoot;
    source = "default";
  }

  const fallbackBlobs =
    source === "repo" && (exists(repoDb) || exists(repoBlobs))
      ? repoBlobs
      : join(fallbackRoot, STORE_BLOBS);
  const database = envDb ?? join(fallbackRoot, STORE_DB);
  const blobRoot = envBlobs ?? fallbackBlobs;
  const productRoot = settingsRoot ?? defaultRoot;
  return {
    database,
    blobRoot,
    dataRoot: settingsRoot ?? (envDb ? dirnameSafe(envDb) : fallbackRoot),
    source: envOverride ? "env" : source,
    envOverride,
    productRoot,
    ...(source === "repo" ? { checkoutRoot: input.repoRoot } : {}),
  };
}

export function storeHasData(
  paths: Pick<DataPaths, "database" | "blobRoot">,
  exists: (path: string) => boolean = existsSync,
  readDir: (path: string) => string[] = readdirSync,
): boolean {
  if (exists(paths.database)) {
    return true;
  }
  if (!exists(paths.blobRoot)) {
    return false;
  }
  try {
    return readDir(paths.blobRoot).length > 0;
  } catch {
    return false;
  }
}

export function inspectDataDirectory(
  destRaw: string,
  current: ResolvedDataPaths,
  exists: (path: string) => boolean = existsSync,
  options: InspectDataDirectoryOptions = {},
): DataDirectoryPlan {
  const path = parseDataRoot(
    nestVolumeRoot(parseDataRoot(destRaw), options.platform),
  );
  const dest = storePaths(path);
  const sameAsCurrent = equalPath(path, current.dataRoot);
  const remoteWarning = isRemoteOrRemovablePath(path, options.volumeKind);
  const sourceHasData = storeHasData(current, exists);
  const destHasData = storeHasData(dest, exists);
  const destLooksLikeStore = storeLooksLikeRegenic(dest, exists);
  if (current.envOverride) {
    return {
      path,
      currentRoot: current.dataRoot,
      sameAsCurrent,
      sourceHasData,
      destHasData,
      destLooksLikeStore,
      remoteWarning,
      canChange: false,
      reason: "settings.dataDirEnv",
    };
  }
  if (sameAsCurrent) {
    return {
      path,
      currentRoot: current.dataRoot,
      sameAsCurrent: true,
      sourceHasData,
      destHasData,
      destLooksLikeStore,
      remoteWarning,
      canChange: true,
    };
  }
  if (
    isForbiddenDataRoot(path, {
      platform: options.platform,
      systemRoot: options.systemRoot,
    })
  ) {
    return {
      path,
      currentRoot: current.dataRoot,
      sameAsCurrent: false,
      sourceHasData,
      destHasData,
      destLooksLikeStore,
      remoteWarning,
      canChange: false,
      reason: "settings.dataDirReasonSystem",
    };
  }
  if (isNestedPath(current.dataRoot, path) || isNestedPath(path, current.dataRoot)) {
    return {
      path,
      currentRoot: current.dataRoot,
      sameAsCurrent: false,
      sourceHasData,
      destHasData,
      destLooksLikeStore,
      remoteWarning,
      canChange: false,
      reason: "settings.dataDirReasonNested",
    };
  }
  if (exists(path)) {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      return {
        path,
        currentRoot: current.dataRoot,
        sameAsCurrent: false,
        sourceHasData,
        destHasData: false,
        destLooksLikeStore: false,
        remoteWarning,
        canChange: false,
        reason: "settings.dataDirReasonFolder",
      };
    }
  }
  return {
    path,
    currentRoot: current.dataRoot,
    sameAsCurrent: false,
    sourceHasData,
    destHasData,
    destLooksLikeStore,
    remoteWarning,
    canChange: true,
  };
}

export function assertDataDirectoryAction(
  action: DataDirectoryAction,
  plan: DataDirectoryPlan,
): void {
  if (plan.sameAsCurrent) {
    return;
  }
  if (!plan.canChange) {
    throw new Error(plan.reason ?? "settings.dataDirError");
  }
  if (action === "adopt" || action === "replace") {
    if (!plan.destHasData) {
      throw new Error("settings.dataDirReasonNoStore");
    }
    if (action === "adopt" && plan.destLooksLikeStore === false) {
      throw new Error("settings.dataDirReasonNotStore");
    }
    return;
  }
  if (plan.destHasData) {
    throw new Error("settings.dataDirDestExists");
  }
  if (action === "migrate" && !plan.sourceHasData) {
    throw new Error("settings.dataDirReasonNoSource");
  }
}

export function cleanupIncomingStaging(root: string): void {
  removeStaging(root, `${STAGING_PREFIX}incoming-`);
}

export function wipeStorePayload(root: string): void {
  const paths = storePaths(root);
  for (const file of [paths.database, ...sidecarFiles(paths.database)]) {
    rmSync(file, { force: true });
  }
  if (existsSync(paths.blobRoot)) {
    rmSync(paths.blobRoot, { recursive: true, force: true });
  }
  if (!existsSync(paths.dataRoot)) {
    return;
  }
  for (const name of [STORE_META_FILE, STORE_LOCK_FILE]) {
    rmSync(join(paths.dataRoot, name), { force: true });
  }
  for (const name of readdirSync(paths.dataRoot)) {
    if (name.startsWith(STAGING_PREFIX)) {
      rmSync(join(paths.dataRoot, name), { recursive: true, force: true });
    }
  }
}

export function wipeStoreFiles(root: string): void {
  wipeStorePayload(root);
  const paths = storePaths(root);
  rmSync(join(paths.dataRoot, STORE_RELOCATED_FILE), { force: true });
}

export function storeFootprintBytes(root: string): number {
  const paths = storePaths(root);
  let total = 0;
  let files = 0;
  const addFile = (file: string): void => {
    if (files >= MAX_FOOTPRINT_FILES) {
      return;
    }
    try {
      const stat = statSync(file);
      if (!stat.isFile()) {
        return;
      }
      total += stat.size;
      files += 1;
    } catch {
      // Missing sidecars are normal.
    }
  };
  addFile(paths.database);
  for (const sidecar of sidecarFiles(paths.database)) {
    addFile(sidecar);
  }
  walkFiles(paths.blobRoot, addFile);
  return total;
}

function walkFiles(dir: string, visit: (file: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(next, visit);
      continue;
    }
    visit(next);
  }
}

export function materializeDataRoot(
  action: DataDirectoryAction,
  from: Pick<DataPaths, "database" | "blobRoot">,
  destRoot: string,
): void {
  const dest = storePaths(destRoot);
  mkdirSync(dest.dataRoot, { recursive: true });
  cleanupIncomingStaging(dest.dataRoot);
  if (action === "adopt" || action === "empty") {
    return;
  }
  const stamp = Date.now();
  const incoming = join(dest.dataRoot, `${STAGING_PREFIX}incoming-${stamp}`);
  if (action === "migrate") {
    try {
      copyStore(from, incoming);
      promoteStore(incoming, dest.dataRoot);
    } catch (error) {
      rmSync(incoming, { recursive: true, force: true });
      wipeStoreFiles(dest.dataRoot);
      throw error;
    }
    rmSync(incoming, { recursive: true, force: true });
    return;
  }
  const replaced = join(dest.dataRoot, `${STAGING_PREFIX}replaced-${stamp}`);
  try {
    copyStore(from, incoming);
    parkStore(dest.dataRoot, replaced);
    promoteStore(incoming, dest.dataRoot);
    rmSync(incoming, { recursive: true, force: true });
    rmSync(replaced, { recursive: true, force: true });
  } catch (error) {
    restoreParkedStore(replaced, dest.dataRoot);
    rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}

export function copyStore(
  from: Pick<DataPaths, "database" | "blobRoot">,
  destRoot: string,
): void {
  const dest = storePaths(destRoot);
  mkdirSync(dest.dataRoot, { recursive: true });
  if (existsSync(from.database)) {
    copyFileSync(from.database, dest.database);
  }
  for (const sidecar of sidecarFiles(from.database)) {
    if (!existsSync(sidecar)) {
      continue;
    }
    copyFileSync(sidecar, join(dest.dataRoot, basenameOf(sidecar)));
  }
  if (existsSync(from.blobRoot)) {
    mkdirSync(dest.blobRoot, { recursive: true });
    copyDirectory(from.blobRoot, dest.blobRoot);
  }
}

function parkStore(root: string, parked: string): void {
  const paths = storePaths(root);
  mkdirSync(parked, { recursive: true });
  moveIfPresent(paths.database, join(parked, STORE_DB));
  for (const sidecar of sidecarFiles(paths.database)) {
    moveIfPresent(sidecar, join(parked, basenameOf(sidecar)));
  }
  moveIfPresent(paths.blobRoot, join(parked, STORE_BLOBS));
}

function promoteStore(incoming: string, destRoot: string): void {
  const from = storePaths(incoming);
  const dest = storePaths(destRoot);
  moveIfPresent(from.database, dest.database);
  for (const sidecar of sidecarFiles(from.database)) {
    moveIfPresent(sidecar, join(dest.dataRoot, basenameOf(sidecar)));
  }
  moveIfPresent(from.blobRoot, dest.blobRoot);
}

function restoreParkedStore(parked: string, destRoot: string): void {
  if (!existsSync(parked)) {
    return;
  }
  try {
    promoteStore(parked, destRoot);
    rmSync(parked, { recursive: true, force: true });
  } catch {
    // Keep the parked copy for manual recovery.
  }
}

function moveIfPresent(from: string, to: string): void {
  if (!existsSync(from)) {
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

function copyDirectory(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirectory(source, dest);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if (statSync(source).isDirectory()) {
          copyDirectory(source, dest);
          continue;
        }
      } catch {
        continue;
      }
    }
    copyFileSync(source, dest);
  }
}

function normalizePath(path: string): string {
  return normalize(resolve(path));
}

function dirnameSafe(file: string): string {
  const normalized = normalize(file);
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function basenameOf(file: string): string {
  const normalized = normalize(file);
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function storeLooksLikeRegenic(
  paths: Pick<DataPaths, "database" | "blobRoot">,
  exists: (path: string) => boolean,
): boolean {
  if (exists(paths.database)) {
    return looksLikeSqliteDatabase(paths.database);
  }
  return storeHasData(paths, exists);
}

function readSqliteHeader(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytes = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

function trimEnv(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function removeStaging(root: string, prefix: string): void {
  if (!existsSync(root)) {
    return;
  }
  for (const name of readdirSync(root)) {
    if (name.startsWith(prefix)) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
}

function winNorm(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function readWindowsDriveKind(letter: string): VolumeKind {
  try {
    const script = `[System.IO.DriveInfo]::new('${letter}:\\').DriveType`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    ).trim();
    if (out === "Network") {
      return "remote";
    }
    if (out === "Removable" || out === "CDRom") {
      return "removable";
    }
    if (out === "Fixed") {
      return "fixed";
    }
  } catch {
    // Fall back to path heuristics.
  }
  return "unknown";
}

const STAGING_PREFIX = ".regenic-";
