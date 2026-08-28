import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import {
  assertDataDirectoryAction,
  equalPath,
  inspectDataDirectory,
  isRemoteOrRemovablePath,
  kernelDatabaseMatches,
  materializeDataRoot,
  resolveDataPaths,
  storeLayoutSplit,
  storePaths,
  wipeStorePayload,
  type DataDirectoryAction,
  type ResolvedDataPaths,
} from "./data-directory";
import {
  applyStoreRelocation,
  inspectSourceRetention,
  prepareDestinationStore,
  readStoreRelocation,
  reclaimStoreIfRelocated,
  sealSourceStore,
} from "./store-identity";
import {
  acquireStoreLock,
  inspectStoreLock,
  releaseStoreLock,
  storeLockHeldByOther,
} from "./store-lock";
import appIconIco from "../brand/app-icon.ico?asset";
import appIconPng from "../brand/app-icon.png?asset";
import appIconWinPng from "../brand/app-icon-win.png?asset";
import trayPng from "../brand/tray-mark.png?asset";
import { collectHostStats, resetHostStatCache } from "./host-stats";
import { formatBytes, portFromHttpOrigin } from "../shared/host-watch";
import { waitForPersonalKernel } from "../shared/kernel-ready";
import { probeKernelDatabase, probeKernelMode } from "./kernel-probe";
import { isMessageKey, translate } from "../shared/messages.ts";
import { parseLocale } from "../shared/locale.ts";
import {
  LOCAL_KERNEL_ORIGIN,
  loadDesktopPreference,
  loadKernelPreference,
  parseKernelOrigin,
  saveDataRootPreference,
  saveKernelPreference,
  saveLocalePreference,
  savePreviousDataRootPreference,
  type KernelPreference,
} from "./kernel-settings";

const TRAY_SIZE = { width: 360, height: 480 };
const DEFAULT_PORT = Number(process.env.REGENIC_DESKTOP_API_PORT ?? 4370);

let mainWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let sidecar: ChildProcess | null = null;
let lastOwnedSidecarPid: number | null = null;
let ownedStoreRoot: string | null = null;
let apiOrigin = `http://127.0.0.1:${DEFAULT_PORT}`;
let quitting = false;
let lastInboxCount: number | null = null;

function repoRoot(): string {
  return process.env.REGENIC_REPO_ROOT ?? join(app.getAppPath(), "../..");
}

function currentDataPaths(): ResolvedDataPaths {
  const preference = loadDesktopPreference(settingsFile());
  return applyStoreRelocation(
    resolveDataPaths({
      repoRoot: repoRoot(),
      homeDir: homedir(),
      dataRoot: preference.dataRoot,
      allowRepo: !app.isPackaged,
      env: {
        REGENIC_DATABASE: process.env.REGENIC_DATABASE,
        REGENIC_BLOB_ROOT: process.env.REGENIC_BLOB_ROOT,
      },
    }),
  );
}

function nodeBinary(): string {
  return process.env.npm_node_execpath ?? process.env.NODE_BINARY ?? "node";
}

function preloadPath(): string {
  const candidates = [
    join(__dirname, "../preload/index.cjs"),
    join(__dirname, "../preload/index.js"),
    join(__dirname, "../preload/index.mjs"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

function rendererUrl(surface: "console" | "tray"): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set("surface", surface);
    return url.toString();
  }
  return join(__dirname, "../renderer/index.html");
}

async function loadSurface(
  window: BrowserWindow,
  surface: "console" | "tray",
): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(rendererUrl(surface));
    return;
  }
  await window.loadFile(rendererUrl(surface), { query: { surface } });
}

function countWorkThreads(
  items: Array<{ event?: { id?: string; source?: string; external_id?: string } }>,
): number {
  const ids = new Set<string>();
  for (const item of items) {
    const event = item.event;
    if (!event?.id || !event.source || !event.external_id) {
      continue;
    }
    const cut = event.external_id.indexOf(":out:");
    const withoutOut = cut >= 0 ? event.external_id.slice(0, cut) : event.external_id;
    const colon = withoutOut.lastIndexOf(":");
    ids.add(
      colon > 0
        ? `${event.source}:${withoutOut.slice(0, colon)}`
        : `${event.source}:${withoutOut || event.id}`,
    );
  }
  return ids.size;
}

function electronAppBytes(): number {
  return app.getAppMetrics().reduce((sum, metric) => {
    const kb = metric.memory?.workingSetSize ?? 0;
    return sum + kb * 1024;
  }, 0);
}

function sidecarEnv(
  port: number,
  database: string,
  blobRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.REGENIC_DATABASE = database;
  env.REGENIC_BLOB_ROOT = blobRoot;
  env.REGENIC_ORG = process.env.REGENIC_ORG ?? "local-owner";
  env.PORT = String(port);
  env.LISTEN_HOST = "127.0.0.1";
  if (!Number(env.REGENIC_CONNECTOR_PULL_MS)) {
    env.REGENIC_CONNECTOR_PULL_MS = "3000";
  }
  delete env.REGENIC_PERSONAL_API;
  const noProxy = [
    env.NO_PROXY,
    env.no_proxy,
    "127.0.0.1",
    "localhost",
  ]
    .flatMap((value) => (value ? String(value).split(",") : []))
    .map((part) => part.trim())
    .filter(Boolean);
  env.NO_PROXY = [...new Set(noProxy)].join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

function settingsFile(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

function isUsingCustomKernel(): boolean {
  const preference = loadDesktopPreference(settingsFile());
  return (
    preference.mode === "custom" &&
    Boolean(preference.origin) &&
    preference.origin === apiOrigin
  );
}

function kernelView() {
  const preference = loadDesktopPreference(settingsFile());
  const paths = currentDataPaths();
  const sourceRetention = currentSourceRetention(preference.previousDataRoot, paths);
  return {
    mode: preference.mode,
    customOrigin: preference.origin ?? LOCAL_KERNEL_ORIGIN,
    activeOrigin: apiOrigin,
    locale: preference.locale,
    dataDirectory: {
      path: paths.dataRoot,
      database: paths.database,
      blobRoot: paths.blobRoot,
      source: paths.source,
      envOverride: paths.envOverride,
      productRoot: paths.productRoot,
      checkoutRoot: paths.checkoutRoot,
      relocatedFrom: paths.relocatedFrom,
      splitLayout: storeLayoutSplit(paths),
      canChange: preference.mode === "local" && !paths.envOverride,
      remoteWarning: isRemoteOrRemovablePath(paths.dataRoot),
    },
    ...(sourceRetention ? { sourceRetention } : {}),
  };
}

function currentSourceRetention(
  previousDataRoot: string | undefined,
  paths: ResolvedDataPaths,
) {
  const retention = inspectSourceRetention(previousDataRoot, paths, {
    repoRoot: repoRoot(),
  });
  if (previousDataRoot && !retention) {
    savePreviousDataRootPreference(settingsFile(), null);
  }
  if (!retention) {
    return undefined;
  }
  return {
    path: retention.path,
    bytes: retention.bytes,
    size: formatBytes(retention.bytes),
    canDelete: retention.canDelete,
  };
}

function broadcastOrigin(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("regenic:api-origin", apiOrigin);
  }
}

function broadcastLocale(locale: "en" | "zh"): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("regenic:locale", locale);
  }
}

function requestSidecarStop(): ChildProcess | null {
  const child = sidecar;
  sidecar = null;
  lastOwnedSidecarPid = null;
  child?.kill();
  return child;
}

function stopOwnedSidecar(): void {
  requestSidecarStop();
}

const SIDECAR_STOP_MS = 15_000;
const SIDECAR_KILL_WAIT_MS = 3_000;

function sidecarAlreadyExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForSidecarExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (sidecarAlreadyExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(sidecarAlreadyExited(child));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopOwnedSidecarAndWait(): Promise<void> {
  const child = requestSidecarStop();
  if (!child || sidecarAlreadyExited(child)) {
    return;
  }
  if (await waitForSidecarExit(child, SIDECAR_STOP_MS)) {
    return;
  }
  child.kill("SIGKILL");
  if (await waitForSidecarExit(child, SIDECAR_KILL_WAIT_MS)) {
    return;
  }
  throw dataDirectoryError("settings.dataDirKernelStop");
}

function dataDirectoryError(key: string): Error {
  if (!isMessageKey(key)) {
    return new Error(key);
  }
  const locale = loadDesktopPreference(settingsFile()).locale;
  return new Error(translate(locale, key));
}

function spawnSidecar(port: number): void {
  const { database, blobRoot } = currentDataPaths();
  const apiEntry = join(repoRoot(), "apps/api/dist/main.js");
  if (!existsSync(apiEntry)) {
    throw new Error(`API sidecar is not built: ${apiEntry}`);
  }
  sidecar = spawn(nodeBinary(), [apiEntry], {
    env: sidecarEnv(port, database, blobRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  lastOwnedSidecarPid = sidecar.pid ?? null;
  sidecar.stdout?.on("data", (chunk) => {
    process.stdout.write(`[kernel] ${chunk}`);
  });
  sidecar.stderr?.on("data", (chunk) => {
    process.stderr.write(`[kernel] ${chunk}`);
  });
  sidecar.on("exit", (code) => {
    if (!quitting) {
      process.stderr.write(`[kernel] exited (${code ?? "null"})\n`);
    }
    sidecar = null;
  });
}

async function pickFreeLocalPort(): Promise<{ port: number; origin: string }> {
  for (let offset = 0; offset < 10; offset += 1) {
    const port = DEFAULT_PORT + offset;
    const origin = `http://127.0.0.1:${port}`;
    if ((await probeKernelMode(origin)) === "none") {
      return { port, origin };
    }
  }
  throw new Error("No free local port for the personal kernel");
}

function releaseOwnedStoreLock(): void {
  if (!ownedStoreRoot) {
    return;
  }
  releaseStoreLock(ownedStoreRoot, process.pid);
  ownedStoreRoot = null;
}

async function originHoldsDatabase(
  origin: string,
  database: string,
): Promise<boolean> {
  if ((await probeKernelMode(origin)) !== "personal") {
    return false;
  }
  return kernelDatabaseMatches(database, await probeKernelDatabase(origin));
}

async function findReusableLocalKernel(database: string): Promise<string | null> {
  const lock = inspectStoreLock(currentDataPaths().dataRoot, process.pid);
  if (lock.state === "held" && lock.lock.origin) {
    if (await originHoldsDatabase(lock.lock.origin, database)) {
      return lock.lock.origin;
    }
  }
  for (let offset = 0; offset < 10; offset += 1) {
    const origin = `http://127.0.0.1:${DEFAULT_PORT + offset}`;
    if (await originHoldsDatabase(origin, database)) {
      return origin;
    }
  }
  return null;
}

async function storeHeldByLocalKernel(database: string): Promise<boolean> {
  for (let offset = 0; offset < 10; offset += 1) {
    const origin = `http://127.0.0.1:${DEFAULT_PORT + offset}`;
    if ((await probeKernelMode(origin)) !== "personal") {
      continue;
    }
    const reported = await probeKernelDatabase(origin);
    if (kernelDatabaseMatches(database, reported)) {
      return true;
    }
  }
  return false;
}

async function startLocalKernel(options?: { forceSpawn?: boolean }): Promise<void> {
  const paths = currentDataPaths();
  if (!options?.forceSpawn) {
    const reusable = await findReusableLocalKernel(paths.database);
    if (reusable) {
      apiOrigin = reusable;
      return;
    }
  }
  if (storeLockHeldByOther(paths.dataRoot, process.pid)) {
    throw dataDirectoryError("settings.dataDirReasonHeld");
  }
  const picked = await pickFreeLocalPort();
  apiOrigin = picked.origin;
  acquireStoreLock(paths.dataRoot, {
    pid: process.pid,
    origin: apiOrigin,
  });
  ownedStoreRoot = paths.dataRoot;
  reclaimStoreIfRelocated(paths.dataRoot);
  spawnSidecar(picked.port);
  try {
    await waitForPersonalKernel({
      origin: apiOrigin,
      probe: probeKernelMode,
      isAlive: () => sidecar != null && sidecar.exitCode == null,
    });
  } catch (error) {
    stopOwnedSidecar();
    releaseOwnedStoreLock();
    throw error;
  }
}

async function assertPersonalKernel(origin: string): Promise<void> {
  const mode = await probeKernelMode(origin, 4000);
  if (mode === "none") {
    throw new Error(`Cannot reach the kernel at ${origin}`);
  }
  if (mode !== "personal") {
    throw new Error(
      `Kernel at ${origin} is not personal. On that server set REGENIC_PERSONAL_API=1; /v1/me stays off when LISTEN_HOST is not loopback.`,
    );
  }
}

async function connectSavedKernel(): Promise<void> {
  const preference = loadKernelPreference(settingsFile());
  if (preference.mode === "custom" && preference.origin) {
    try {
      await assertPersonalKernel(preference.origin);
      apiOrigin = preference.origin;
      return;
    } catch (error) {
      process.stderr.write(
        `[kernel] ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
  await startLocalKernel();
}

async function applyKernelPreference(preference: KernelPreference): Promise<void> {
  resetHostStatCache();
  if (preference.mode === "custom" && preference.origin) {
    await assertPersonalKernel(preference.origin);
    saveKernelPreference(settingsFile(), preference);
    await stopOwnedSidecarAndWait();
    releaseOwnedStoreLock();
    apiOrigin = preference.origin;
    broadcastOrigin();
    return;
  }
  saveKernelPreference(settingsFile(), { mode: "local" });
  await startLocalKernel();
  broadcastOrigin();
}

function parseDataDirectoryAction(raw: unknown): DataDirectoryAction {
  if (
    raw === "migrate" ||
    raw === "empty" ||
    raw === "adopt" ||
    raw === "replace"
  ) {
    return raw;
  }
  throw dataDirectoryError("settings.dataDirReasonAction");
}

function inspectCurrentDataDirectory(dest: string) {
  const preference = loadDesktopPreference(settingsFile());
  const plan = inspectDataDirectory(dest, currentDataPaths());
  const relocatedTo = readStoreRelocation(plan.path)?.to;
  if (preference.mode === "custom") {
    return {
      ...plan,
      ...(relocatedTo ? { relocatedTo } : {}),
      canChange: false,
      reason: "settings.dataDirCustom",
    };
  }
  return {
    ...plan,
    ...(relocatedTo ? { relocatedTo } : {}),
  };
}

function dataDirectoryCopyError(error: unknown): Error {
  const code =
    error instanceof Error && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return dataDirectoryError("settings.dataDirCopyBusy");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isMessageKey(message)) {
    return dataDirectoryError(message);
  }
  return error instanceof Error ? error : new Error(message);
}

async function restoreLocalKernel(database: string): Promise<void> {
  const reusable = await findReusableLocalKernel(database);
  if (reusable) {
    apiOrigin = reusable;
    broadcastOrigin();
    return;
  }
  if (await storeHeldByLocalKernel(database)) {
    return;
  }
  await startLocalKernel({ forceSpawn: true });
  broadcastOrigin();
}

async function applyDataDirectory(input: {
  path: string;
  action: DataDirectoryAction;
}) {
  const plan = inspectCurrentDataDirectory(input.path);
  if (plan.sameAsCurrent) {
    return kernelView();
  }
  assertDataDirectoryAction(input.action, plan);
  const current = currentDataPaths();
  const hadOwnedSidecar = sidecar != null;
  const previousLocked = ownedStoreRoot;
  let committed = false;
  await stopOwnedSidecarAndWait();
  try {
    if (storeLockHeldByOther(current.dataRoot, process.pid)) {
      throw dataDirectoryError("settings.dataDirReasonHeld");
    }
    if (storeLockHeldByOther(plan.path, process.pid)) {
      throw dataDirectoryError("settings.dataDirReasonHeld");
    }
    if (await storeHeldByLocalKernel(current.database)) {
      throw dataDirectoryError("settings.dataDirReasonHeld");
    }
    materializeDataRoot(input.action, current, plan.path);
    const identity = prepareDestinationStore(
      plan.path,
      input.action,
      current.dataRoot,
    );
    const previousRoot = loadDesktopPreference(settingsFile()).dataRoot ?? null;
    saveDataRootPreference(settingsFile(), plan.path);
    resetHostStatCache();
    try {
      await startLocalKernel({ forceSpawn: true });
    } catch (error) {
      saveDataRootPreference(settingsFile(), previousRoot);
      if (previousLocked) {
        acquireStoreLock(previousLocked, { pid: process.pid });
        ownedStoreRoot = previousLocked;
      }
      throw error;
    }
    committed = true;
    if (
      previousLocked &&
      ownedStoreRoot &&
      !equalPath(previousLocked, ownedStoreRoot)
    ) {
      releaseStoreLock(previousLocked, process.pid);
    }
    try {
      sealSourceStore(current.dataRoot, plan.path, input.action, identity);
      rememberSourceRetention(input.action, current.dataRoot);
    } catch (error) {
      process.stderr.write(
        `[kernel] ${error instanceof Error ? error.message : error}\n`,
      );
    }
    broadcastOrigin();
    return kernelView();
  } catch (error) {
    if (!committed && hadOwnedSidecar) {
      try {
        await restoreLocalKernel(current.database);
      } catch {
        // Keep the original failure; the console can retry or relaunch.
      }
    }
    throw dataDirectoryCopyError(error);
  }
}

function rememberSourceRetention(
  action: DataDirectoryAction,
  previousRoot: string,
): void {
  if (action !== "migrate" && action !== "replace") {
    savePreviousDataRootPreference(settingsFile(), null);
    return;
  }
  const retention = inspectSourceRetention(previousRoot, currentDataPaths(), {
    repoRoot: repoRoot(),
  });
  savePreviousDataRootPreference(
    settingsFile(),
    retention?.canDelete ? previousRoot : null,
  );
}

function parseRetentionAction(raw: unknown): "keep" | "discard" {
  if (raw === "keep" || raw === "discard") {
    return raw;
  }
  throw dataDirectoryError("settings.dataDirReasonAction");
}

async function resolveSourceRetention(action: "keep" | "discard") {
  const preference = loadDesktopPreference(settingsFile());
  const current = currentDataPaths();
  const retention = inspectSourceRetention(preference.previousDataRoot, current, {
    repoRoot: repoRoot(),
  });
  if (
    action === "keep" ||
    !retention?.canDelete ||
    equalPath(retention.path, current.dataRoot)
  ) {
    savePreviousDataRootPreference(settingsFile(), null);
    return kernelView();
  }
  if (storeLockHeldByOther(retention.path, process.pid)) {
    throw dataDirectoryError("settings.dataDirReasonHeld");
  }
  if (await storeHeldByLocalKernel(storePaths(retention.path).database)) {
    throw dataDirectoryError("settings.dataDirReasonHeld");
  }
  try {
    wipeStorePayload(retention.path);
  } catch {
    throw dataDirectoryError("settings.dataDirReclaimError");
  }
  savePreviousDataRootPreference(settingsFile(), null);
  resetHostStatCache();
  return kernelView();
}

function appIconFile(): string {
  if (process.platform === "darwin") {
    return appIconPng;
  }
  if (process.platform === "win32") {
    return appIconIco;
  }
  return appIconWinPng;
}

function loadAppIcon(): Electron.NativeImage {
  if (process.platform === "darwin") {
    return nativeImage.createFromPath(appIconPng);
  }
  const png = nativeImage.createFromPath(appIconWinPng);
  if (!png.isEmpty()) {
    return png;
  }
  return nativeImage.createFromPath(appIconIco);
}

function applyAppIcon(window?: BrowserWindow): void {
  const image = loadAppIcon();
  if (image.isEmpty()) {
    return;
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
    return;
  }
  const targets = window ? [window] : BrowserWindow.getAllWindows();
  for (const win of targets) {
    if (!win.isDestroyed()) {
      win.setIcon(image);
    }
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Regenic",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0a",
    icon: appIconFile(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--regenic-api=${apiOrigin}`],
    },
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  attachExternalLinks(window);
  void loadSurface(window, "console");
  applyAppIcon(window);
  return window;
}

function createTrayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: TRAY_SIZE.width,
    height: TRAY_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#171c18",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--regenic-api=${apiOrigin}`],
    },
  });
  window.on("blur", () => {
    if (!window.webContents.isDevToolsOpened()) {
      window.hide();
    }
  });
  attachExternalLinks(window);
  void loadSurface(window, "tray");
  return window;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function attachExternalLinks(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    if (isHttpUrl(details.url)) {
      void shell.openExternal(details.url);
    }
    return { action: "deny" };
  });
}

function trayIcon(): Electron.NativeImage {
  const source = nativeImage.createFromPath(trayPng);
  const image = nativeImage.createEmpty();
  const oneX = source.resize({ width: 16, height: 16, quality: "best" });
  const twoX = source.resize({ width: 32, height: 32, quality: "best" });
  image.addRepresentation({
    scaleFactor: 1,
    width: 16,
    height: 16,
    buffer: oneX.toPNG(),
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: twoX.toPNG(),
  });
  image.setTemplateImage(true);
  return image;
}

function positionTrayWindow(): void {
  if (!tray || !trayWindow) {
    return;
  }
  const bounds = tray.getBounds();
  const x = Math.round(bounds.x + bounds.width / 2 - TRAY_SIZE.width / 2);
  const y = Math.round(bounds.y + bounds.height + 6);
  trayWindow.setPosition(x, y, false);
}

function toggleTrayWindow(): void {
  if (!trayWindow) {
    return;
  }
  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }
  positionTrayWindow();
  trayWindow.show();
  trayWindow.focus();
}

function showConsole(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
  trayWindow?.hide();
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("Regenic");
  tray.on("click", () => {
    toggleTrayWindow();
  });
  tray.on("right-click", () => {
    const locale = loadDesktopPreference(settingsFile()).locale;
    const menu = Menu.buildFromTemplate([
      {
        label: translate(locale, "tray.openConsole"),
        click: () => showConsole(),
      },
      { type: "separator" },
      {
        label: translate(locale, "tray.quit"),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray?.popUpContextMenu(menu);
  });
}

async function pollNotifications(): Promise<void> {
  try {
    const response = await fetch(`${apiOrigin}/v1/me/inbox?heads=1`);
    if (!response.ok) {
      return;
    }
    const items = (await response.json()) as Array<{
      event?: { id?: string; source?: string; external_id?: string };
    }>;
    const count = Array.isArray(items) ? countWorkThreads(items) : 0;
    if (lastInboxCount !== null && count > lastInboxCount && Notification.isSupported()) {
      const locale = loadDesktopPreference(settingsFile()).locale;
      new Notification({
        title: "Regenic",
        body: translate(locale, "tray.workCountNotify", { count }),
      }).show();
    }
    lastInboxCount = count;
  } catch {
    // Kernel may be restarting; tray surface will show Stopped.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showConsole();
  });
}

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) {
    return;
  }
  applyAppIcon();
  ipcMain.handle("regenic:show-console", async () => {
    showConsole();
  });
  ipcMain.handle("regenic:quit", async () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle("regenic:get-api-origin", async () => apiOrigin);
  ipcMain.handle("regenic:get-kernel-settings", async () => kernelView());
  ipcMain.handle("regenic:open-external", async (_event, url: unknown) => {
    if (isHttpUrl(url)) {
      await shell.openExternal(url);
    }
  });
  ipcMain.handle("regenic:get-host-stats", async () =>
    collectHostStats(currentDataPaths(), {
      sidecarPid: sidecar?.pid ?? lastOwnedSidecarPid,
      listenPort: portFromHttpOrigin(apiOrigin),
      skipLocalStore: isUsingCustomKernel(),
      appBytes: electronAppBytes,
    }),
  );
  ipcMain.handle(
    "regenic:set-kernel-settings",
    async (_event, input: { mode?: string; origin?: string }) => {
      if (input?.mode === "custom") {
        await applyKernelPreference({
          mode: "custom",
          origin: parseKernelOrigin(input.origin ?? ""),
        });
      } else {
        await applyKernelPreference({ mode: "local" });
      }
      return kernelView();
    },
  );
  ipcMain.handle("regenic:set-locale", async (_event, locale: unknown) => {
    const next = saveLocalePreference(settingsFile(), parseLocale(locale));
    broadcastLocale(next);
    return next;
  });
  ipcMain.handle("regenic:pick-data-directory", async () => {
    const options = {
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const picked = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) {
      return null;
    }
    return inspectCurrentDataDirectory(picked.filePaths[0]);
  });
  ipcMain.handle(
    "regenic:set-data-directory",
    async (_event, input: { path?: unknown; action?: unknown }) => {
      if (typeof input?.path !== "string") {
        throw dataDirectoryError("settings.dataDirReasonAbs");
      }
      return applyDataDirectory({
        path: input.path,
        action: parseDataDirectoryAction(input.action),
      });
    },
  );
  ipcMain.handle(
    "regenic:resolve-source-retention",
    async (_event, input: { action?: unknown }) => {
      return resolveSourceRetention(parseRetentionAction(input?.action));
    },
  );

  try {
    await connectSavedKernel();
  } catch (error) {
    process.stderr.write(`[kernel] ${error instanceof Error ? error.message : error}\n`);
  }

  mainWindow = createMainWindow();
  trayWindow = createTrayWindow();
  createTray();
  void pollNotifications();
  setInterval(() => {
    void pollNotifications();
  }, 8000);

  app.on("activate", () => {
    showConsole();
  });
});

app.on("before-quit", () => {
  quitting = true;
  sidecar?.kill();
  releaseOwnedStoreLock();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && quitting) {
    app.quit();
  }
});
