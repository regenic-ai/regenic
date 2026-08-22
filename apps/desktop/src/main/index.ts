import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from "electron";
import appIconPng from "../brand/app-icon.png?asset";
import trayPng from "../brand/tray-mark.png?asset";

const TRAY_SIZE = { width: 360, height: 480 };
const DEFAULT_PORT = Number(process.env.REGENIC_DESKTOP_API_PORT ?? 4370);

let mainWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let sidecar: ChildProcess | null = null;
let apiOrigin = `http://127.0.0.1:${DEFAULT_PORT}`;
let quitting = false;
let lastInboxCount: number | null = null;

function repoRoot(): string {
  return process.env.REGENIC_REPO_ROOT ?? join(app.getAppPath(), "../..");
}

function resolveDataPaths(): { database: string; blobRoot: string } {
  const root = repoRoot();
  const repoDb = join(root, "regenic.db");
  const repoBlobs = join(root, "blobs");
  const homeDir = join(homedir(), ".regenic");
  const database =
    process.env.REGENIC_DATABASE ??
    (existsSync(repoDb) ? repoDb : join(homeDir, "regenic.db"));
  const blobRoot =
    process.env.REGENIC_BLOB_ROOT ??
    (existsSync(repoDb) || existsSync(repoBlobs)
      ? repoBlobs
      : join(homeDir, "blobs"));
  return { database, blobRoot };
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
    const colon = event.external_id.lastIndexOf(":");
    ids.add(
      colon > 0
        ? `${event.source}:${event.external_id.slice(0, colon)}`
        : `${event.source}:${event.id}`,
    );
  }
  return ids.size;
}

async function probe(origin: string): Promise<"personal" | "other" | "none"> {
  try {
    const response = await fetch(`${origin}/health`);
    const body = (await response.json()) as { mode?: string };
    return body.mode === "personal" ? "personal" : "other";
  } catch {
    return "none";
  }
}

async function waitForPersonal(origin: string, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await probe(origin)) === "personal") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Personal kernel did not become ready");
}

async function pickKernelPort(): Promise<{ reuse: string } | { port: number; origin: string }> {
  for (let offset = 0; offset < 10; offset += 1) {
    const port = DEFAULT_PORT + offset;
    const origin = `http://127.0.0.1:${port}`;
    const existing = await probe(origin);
    if (existing === "personal") {
      return { reuse: origin };
    }
    if (existing === "none") {
      return { port, origin };
    }
  }
  throw new Error("No free local port for the personal kernel");
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
  delete env.REGENIC_PERSONAL_API;
  return env;
}

function spawnSidecar(port: number): void {
  const { database, blobRoot } = resolveDataPaths();
  const apiEntry = join(repoRoot(), "apps/api/dist/main.js");
  if (!existsSync(apiEntry)) {
    throw new Error(`API sidecar is not built: ${apiEntry}`);
  }
  sidecar = spawn(nodeBinary(), [apiEntry], {
    env: sidecarEnv(port, database, blobRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function startKernel(): Promise<void> {
  const picked = await pickKernelPort();
  if ("reuse" in picked) {
    apiOrigin = picked.reuse;
    return;
  }
  apiOrigin = picked.origin;
  spawnSidecar(picked.port);
  try {
    await waitForPersonal(apiOrigin);
  } catch (error) {
    sidecar?.kill();
    sidecar = null;
    throw error;
  }
}

function applyAppIcon(): void {
  const image = nativeImage.createFromPath(appIconPng);
  if (image.isEmpty()) {
    return;
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
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
    icon: appIconPng,
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
  void loadSurface(window, "console");
  applyAppIcon();
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
  void loadSurface(window, "tray");
  return window;
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
    const menu = Menu.buildFromTemplate([
      { label: "Open console", click: () => showConsole() },
      { type: "separator" },
      {
        label: "Quit",
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
    const response = await fetch(`${apiOrigin}/v1/me/inbox`);
    if (!response.ok) {
      return;
    }
    const items = (await response.json()) as Array<{
      event?: { id?: string; source?: string; external_id?: string };
    }>;
    const count = Array.isArray(items) ? countWorkThreads(items) : 0;
    if (lastInboxCount !== null && count > lastInboxCount && Notification.isSupported()) {
      new Notification({
        title: "Regenic",
        body: `${count} current work`,
      }).show();
    }
    lastInboxCount = count;
  } catch {
    // Kernel may be restarting; tray surface will show Stopped.
  }
}

app.whenReady().then(async () => {
  applyAppIcon();
  ipcMain.handle("regenic:show-console", async () => {
    showConsole();
  });
  ipcMain.handle("regenic:quit", async () => {
    quitting = true;
    app.quit();
  });

  try {
    await startKernel();
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && quitting) {
    app.quit();
  }
});
