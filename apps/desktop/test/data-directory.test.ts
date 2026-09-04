import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertDataDirectoryAction,
  copyStore,
  cleanupIncomingStaging,
  inspectDataDirectory,
  isForbiddenDataRoot,
  isRemoteOrRemovablePath,
  kernelDatabaseMatches,
  looksLikeSqliteDatabase,
  materializeDataRoot,
  nestVolumeRoot,
  nestDataRoot,
  parseDataRoot,
  resolveDataPaths,
  STORE_FOLDER,
  storeFootprintBytes,
  storeHasData,
  storeLayoutSplit,
  storePaths,
  wipeStoreFiles,
  wipeStorePayload,
} from "../src/main/data-directory.ts";
import {
  applyStoreRelocation,
  followStoreRelocation,
  inspectSourceRetention,
  prepareDestinationStore,
  readStoreIdentity,
  readStoreRelocation,
  reclaimStoreIfRelocated,
  sealSourceStore,
  writeStoreIdentity,
  writeStoreRelocation,
} from "../src/main/store-identity.ts";
import {
  acquireStoreLock,
  inspectStoreLock,
  releaseStoreLock,
  STORE_LOCK_NAME,
  storeLockHeldByOther,
  storeLockPath,
} from "../src/main/store-lock.ts";
import {
  loadDesktopPreference,
  saveDataRootPreference,
  saveDesktopPreference,
  saveKernelPreference,
  savePreviousDataRootPreference,
} from "../src/main/kernel-settings.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "regenic-data-dir-"));
}

describe("resolveDataPaths", () => {
  it("defaults to ~/.regenic when nothing else is set", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      exists: () => false,
    });
    assert.equal(resolved.source, "default");
    assert.equal(resolved.dataRoot, join("/home/ada", ".regenic"));
    assert.equal(resolved.productRoot, join("/home/ada", ".regenic"));
    assert.equal(resolved.checkoutRoot, undefined);
    assert.equal(resolved.database, join("/home/ada", ".regenic", "regenic.db"));
    assert.equal(resolved.blobRoot, join("/home/ada", ".regenic", "blobs"));
    assert.equal(resolved.envOverride, false);
  });

  it("uses the repo store when a checkout already has regenic.db", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      exists: (path) => path === join("/repo", "regenic.db"),
    });
    assert.equal(resolved.source, "repo");
    assert.equal(resolved.dataRoot, "/repo");
    assert.equal(resolved.productRoot, join("/home/ada", ".regenic"));
    assert.equal(resolved.checkoutRoot, "/repo");
    assert.equal(resolved.database, join("/repo", "regenic.db"));
    assert.equal(resolved.blobRoot, join("/repo", "blobs"));
  });

  it("does not use the repo store when allowRepo is false", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      allowRepo: false,
      exists: (path) => path === join("/repo", "regenic.db"),
    });
    assert.equal(resolved.source, "default");
    assert.equal(resolved.dataRoot, join("/home/ada", ".regenic"));
    assert.equal(resolved.checkoutRoot, undefined);
  });

  it("prefers a saved dataRoot over a repo checkout", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      exists: (path) => path === join("/repo", "regenic.db"),
    });
    assert.equal(resolved.source, "settings");
    assert.equal(resolved.dataRoot, parseDataRoot("/data/regenic"));
    assert.equal(resolved.database, join(parseDataRoot("/data/regenic"), "regenic.db"));
    assert.equal(resolved.blobRoot, join(parseDataRoot("/data/regenic"), "blobs"));
  });

  it("lets environment variables win and marks the override", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      env: {
        REGENIC_DATABASE: "/env/custom.db",
        REGENIC_BLOB_ROOT: "/env/blobs",
      },
      exists: () => false,
    });
    assert.equal(resolved.source, "env");
    assert.equal(resolved.envOverride, true);
    assert.equal(resolved.database, "/env/custom.db");
    assert.equal(resolved.blobRoot, "/env/blobs");
    assert.equal(storeLayoutSplit(resolved), true);
  });

  it("can override only the database path", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      env: { REGENIC_DATABASE: "/env/custom.db" },
      exists: () => false,
    });
    assert.equal(resolved.envOverride, true);
    assert.equal(resolved.database, "/env/custom.db");
    assert.equal(resolved.blobRoot, join(parseDataRoot("/data/regenic"), "blobs"));
    assert.equal(storeLayoutSplit(resolved), true);
  });

  it("keeps a single-root layout when nothing is split", () => {
    const resolved = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      exists: () => false,
    });
    assert.equal(storeLayoutSplit(resolved), false);
  });
});

describe("parseDataRoot", () => {
  it("rejects relative paths", () => {
    assert.throws(() => parseDataRoot("data"), /settings.dataDirReasonAbs/);
    assert.throws(() => parseDataRoot("   "), /settings.dataDirReasonAbs/);
  });

  it("normalizes an absolute folder", () => {
    const parsed = parseDataRoot(join("/data", "regenic", ".", "store"));
    assert.equal(parsed, parseDataRoot(join("/data", "regenic", "store")));
  });
});

describe("inspectDataDirectory", () => {
  it("rejects a folder nested inside the current store", () => {
    const current = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      exists: () => false,
    });
    const plan = inspectDataDirectory(join("/data/regenic", "nested"), current, () => false);
    assert.equal(plan.canChange, false);
    assert.equal(plan.reason, "settings.dataDirReasonNested");
  });

  it("rejects an environment-variable override", () => {
    const current = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      env: { REGENIC_DATABASE: "/env/custom.db" },
      exists: () => false,
    });
    const plan = inspectDataDirectory("/data/other", current, () => false);
    assert.equal(plan.canChange, false);
    assert.equal(plan.reason, "settings.dataDirEnv");
  });

  it("detects an existing destination store", () => {
    const root = tempDir();
    const dest = join(root, "dest");
    const currentRoot = join(root, "current");
    try {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "regenic.db"), "old");
      const current = resolveDataPaths({
        repoRoot: "/repo",
        homeDir: "/home/ada",
        dataRoot: currentRoot,
        exists: () => false,
      });
      const plan = inspectDataDirectory(dest, current);
      assert.equal(plan.destHasData, true);
      assert.equal(plan.destLooksLikeStore, false);
      assert.equal(plan.canChange, true);
      assert.equal(plan.sameAsCurrent, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a system folder", () => {
    const current = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      exists: () => false,
    });
    const plan = inspectDataDirectory("/etc/regenic", current, () => false);
    assert.equal(plan.canChange, false);
    assert.equal(plan.reason, "settings.dataDirReasonSystem");
  });

  it("treats the current folder as a no-op", () => {
    const current = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/data/regenic",
      exists: () => false,
    });
    const plan = inspectDataDirectory("/data/regenic", current, () => false);
    assert.equal(plan.sameAsCurrent, true);
    assert.equal(plan.canChange, true);
  });

  it("creates a Regenic folder under a picked location", () => {
    const current = resolveDataPaths({
      repoRoot: "/repo",
      homeDir: "/home/ada",
      dataRoot: "/home/ada/.regenic",
      exists: () => false,
    });
    const plan = inspectDataDirectory("/data/projects", current, () => false);
    assert.equal(plan.path, parseDataRoot(join("/data/projects", STORE_FOLDER)));
    assert.equal(plan.pickedPath, parseDataRoot("/data/projects"));
    assert.equal(plan.canChange, true);
    assert.equal(plan.destHasData, false);
  });
});

describe("data directory actions", () => {
  it("copies a directory reached through a symlink", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = storePaths(join(root, "dest"));
      const real = join(root, "real-nested");
      mkdirSync(from.blobRoot, { recursive: true });
      mkdirSync(real, { recursive: true });
      writeFileSync(from.database, "db");
      writeFileSync(join(real, "file.bin"), "via-link");
      try {
        symlinkSync(real, join(from.blobRoot, "linked"), "dir");
      } catch {
        return;
      }
      copyStore(from, dest.dataRoot);
      assert.equal(
        readFileSync(join(dest.blobRoot, "linked", "file.bin"), "utf8"),
        "via-link",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears leftover incoming staging but keeps a parked replace folder", () => {
    const root = tempDir();
    try {
      const dest = storePaths(join(root, "dest"));
      const leftover = join(dest.dataRoot, ".regenic-incoming-1");
      const parked = join(dest.dataRoot, ".regenic-replaced-1");
      mkdirSync(leftover, { recursive: true });
      mkdirSync(parked, { recursive: true });
      writeFileSync(join(leftover, "junk"), "x");
      writeFileSync(join(parked, "keep"), "y");
      cleanupIncomingStaging(dest.dataRoot);
      assert.equal(existsSync(leftover), false);
      assert.equal(readFileSync(join(parked, "keep"), "utf8"), "y");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies authority and lexical databases, WAL files, and blobs", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = join(root, "dest");
      mkdirSync(join(from.blobRoot, "a"), { recursive: true });
      writeFileSync(from.database, "db");
      writeFileSync(`${from.database}-wal`, "wal");
      writeFileSync(`${from.database}.lexical.db`, "fts");
      writeFileSync(`${from.database}.lexical.db-wal`, "fts-wal");
      writeFileSync(join(from.blobRoot, "a", "file.bin"), "blob");
      copyStore(from, dest);
      const copied = storePaths(dest);
      assert.equal(readFileSync(copied.database, "utf8"), "db");
      assert.equal(readFileSync(`${copied.database}-wal`, "utf8"), "wal");
      assert.equal(readFileSync(`${copied.database}.lexical.db`, "utf8"), "fts");
      assert.equal(readFileSync(`${copied.database}.lexical.db-wal`, "utf8"), "fts-wal");
      assert.equal(readFileSync(join(copied.blobRoot, "a", "file.bin"), "utf8"), "blob");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces a destination store and restores it if promote fails", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = storePaths(join(root, "dest"));
      mkdirSync(from.blobRoot, { recursive: true });
      mkdirSync(dest.blobRoot, { recursive: true });
      writeFileSync(from.database, "new");
      writeFileSync(`${from.database}.lexical.db`, "new-index");
      writeFileSync(join(from.blobRoot, "n.txt"), "n");
      writeFileSync(dest.database, "old");
      writeFileSync(`${dest.database}.lexical.db`, "old-index");
      writeFileSync(join(dest.blobRoot, "o.txt"), "o");
      materializeDataRoot("replace", from, dest.dataRoot);
      assert.equal(readFileSync(dest.database, "utf8"), "new");
      assert.equal(readFileSync(`${dest.database}.lexical.db`, "utf8"), "new-index");
      assert.equal(readFileSync(join(dest.blobRoot, "n.txt"), "utf8"), "n");
      assert.equal(storeHasData(dest), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves destination files in place for adopt and empty", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = storePaths(join(root, "dest"));
      mkdirSync(from.dataRoot, { recursive: true });
      mkdirSync(dest.dataRoot, { recursive: true });
      writeFileSync(from.database, "src");
      writeFileSync(dest.database, "kept");
      materializeDataRoot("adopt", from, dest.dataRoot);
      assert.equal(readFileSync(dest.database, "utf8"), "kept");
      materializeDataRoot("empty", from, dest.dataRoot);
      assert.equal(readFileSync(dest.database, "utf8"), "kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates through a staging folder and leaves no leftover staging", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = storePaths(join(root, "dest"));
      mkdirSync(from.blobRoot, { recursive: true });
      writeFileSync(from.database, "db");
      writeFileSync(join(from.blobRoot, "a.bin"), "blob");
      mkdirSync(dest.dataRoot, { recursive: true });
      writeFileSync(join(dest.dataRoot, "keep.txt"), "other");
      materializeDataRoot("migrate", from, dest.dataRoot);
      assert.equal(readFileSync(dest.database, "utf8"), "db");
      assert.equal(readFileSync(join(dest.blobRoot, "a.bin"), "utf8"), "blob");
      assert.equal(readFileSync(join(dest.dataRoot, "keep.txt"), "utf8"), "other");
      assert.equal(
        readdirSync(dest.dataRoot).some((name) => name.startsWith(".regenic-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wipes a partial destination if migrate fails", () => {
    const root = tempDir();
    try {
      const from = storePaths(join(root, "from"));
      const dest = storePaths(join(root, "dest"));
      mkdirSync(from.dataRoot, { recursive: true });
      mkdirSync(dest.dataRoot, { recursive: true });
      writeFileSync(from.database, "db");
      writeFileSync(from.blobRoot, "not-a-directory");
      assert.throws(() => materializeDataRoot("migrate", from, dest.dataRoot));
      assert.equal(existsSync(dest.database), false);
      assert.equal(existsSync(dest.blobRoot), false);
      assert.equal(
        readdirSync(dest.dataRoot).some((name) => name.startsWith(".regenic-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wipes only store files", () => {
    const root = tempDir();
    try {
      const dest = storePaths(join(root, "dest"));
      mkdirSync(dest.blobRoot, { recursive: true });
      writeFileSync(dest.database, "db");
      writeFileSync(join(dest.blobRoot, "a.bin"), "blob");
      writeFileSync(join(dest.dataRoot, "notes.txt"), "keep");
      writeFileSync(join(dest.dataRoot, "regenic.store.json"), "{}");
      writeFileSync(join(dest.dataRoot, "regenic.relocated.json"), "{}");
      wipeStoreFiles(dest.dataRoot);
      assert.equal(existsSync(dest.database), false);
      assert.equal(existsSync(dest.blobRoot), false);
      assert.equal(existsSync(join(dest.dataRoot, "regenic.store.json")), false);
      assert.equal(existsSync(join(dest.dataRoot, "regenic.relocated.json")), false);
      assert.equal(readFileSync(join(dest.dataRoot, "notes.txt"), "utf8"), "keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wipes the store payload but keeps the relocation tombstone", () => {
    const root = tempDir();
    try {
      const dest = storePaths(join(root, "dest"));
      mkdirSync(dest.blobRoot, { recursive: true });
      writeFileSync(dest.database, "db");
      writeFileSync(`${dest.database}-wal`, "wal");
      writeFileSync(`${dest.database}.lexical.db`, "fts");
      writeFileSync(`${dest.database}.lexical.db-shm`, "fts-shm");
      writeFileSync(join(dest.blobRoot, "a.bin"), "blob");
      writeFileSync(join(dest.dataRoot, "notes.txt"), "keep");
      writeFileSync(join(dest.dataRoot, "regenic.store.json"), "{}");
      writeFileSync(join(dest.dataRoot, "regenic.store.lock"), "{}");
      writeFileSync(join(dest.dataRoot, "regenic.relocated.json"), '{"to":"/new"}');
      wipeStorePayload(dest.dataRoot);
      assert.equal(existsSync(dest.database), false);
      assert.equal(existsSync(`${dest.database}-wal`), false);
      assert.equal(existsSync(`${dest.database}.lexical.db`), false);
      assert.equal(existsSync(`${dest.database}.lexical.db-shm`), false);
      assert.equal(existsSync(dest.blobRoot), false);
      assert.equal(existsSync(join(dest.dataRoot, "regenic.store.json")), false);
      assert.equal(existsSync(join(dest.dataRoot, "regenic.store.lock")), false);
      assert.equal(
        readFileSync(join(dest.dataRoot, "regenic.relocated.json"), "utf8"),
        '{"to":"/new"}',
      );
      assert.equal(readFileSync(join(dest.dataRoot, "notes.txt"), "utf8"), "keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts authority and lexical database sidecars plus attachments", () => {
    const root = tempDir();
    try {
      const dest = storePaths(join(root, "dest"));
      mkdirSync(dest.blobRoot, { recursive: true });
      writeFileSync(dest.database, "12345");
      writeFileSync(`${dest.database}-wal`, "ww");
      writeFileSync(`${dest.database}.lexical.db`, "fts");
      writeFileSync(`${dest.database}.lexical.db-wal`, "w");
      writeFileSync(join(dest.blobRoot, "a.bin"), "blob");
      writeFileSync(join(dest.dataRoot, "notes.txt"), "ignored");
      assert.equal(storeFootprintBytes(dest.dataRoot), 5 + 2 + 3 + 1 + 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a migrate onto an existing store", () => {
    const plan = {
      path: "/data/other",
      currentRoot: "/data/regenic",
      sameAsCurrent: false,
      sourceHasData: true,
      destHasData: true,
      destLooksLikeStore: true,
      remoteWarning: false,
      canChange: true,
    };
    assert.throws(
      () => assertDataDirectoryAction("migrate", plan),
      /settings.dataDirDestExists/,
    );
    assert.doesNotThrow(() => assertDataDirectoryAction("adopt", plan));
  });

  it("rejects adopt when the destination file is not SQLite", () => {
    const plan = {
      path: "/data/other",
      currentRoot: "/data/regenic",
      sameAsCurrent: false,
      sourceHasData: true,
      destHasData: true,
      destLooksLikeStore: false,
      remoteWarning: false,
      canChange: true,
    };
    assert.throws(
      () => assertDataDirectoryAction("adopt", plan),
      /settings.dataDirReasonNotStore/,
    );
    assert.doesNotThrow(() => assertDataDirectoryAction("replace", plan));
  });
});

describe("desktop-settings dataRoot", () => {
  it("round-trips a saved dataRoot and keeps it when the kernel address changes", () => {
    const root = tempDir();
    const file = join(root, "desktop-settings.json");
    try {
      const saved = saveDataRootPreference(file, join(root, "store"));
      const loaded = loadDesktopPreference(file);
      assert.equal(loaded.dataRoot, saved);
      saveKernelPreference(file, {
        mode: "custom",
        origin: "http://127.0.0.1:4371",
      });
      const next = loadDesktopPreference(file);
      assert.equal(next.mode, "custom");
      assert.equal(next.dataRoot, saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps previousDataRoot when the live dataRoot or kernel changes", () => {
    const root = tempDir();
    const file = join(root, "desktop-settings.json");
    try {
      saveDataRootPreference(file, join(root, "store"));
      const previous = savePreviousDataRootPreference(file, join(root, "old"));
      saveDataRootPreference(file, join(root, "next"));
      saveKernelPreference(file, {
        mode: "custom",
        origin: "http://127.0.0.1:4371",
      });
      const loaded = loadDesktopPreference(file);
      assert.equal(loaded.dataRoot, parseDataRoot(join(root, "next")));
      assert.equal(loaded.previousDataRoot, previous);
      savePreviousDataRootPreference(file, null);
      assert.equal(loadDesktopPreference(file).previousDataRoot, undefined);
      assert.equal(
        loadDesktopPreference(file).dataRoot,
        parseDataRoot(join(root, "next")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can clear a saved dataRoot", () => {
    const root = tempDir();
    const file = join(root, "desktop-settings.json");
    try {
      saveDataRootPreference(file, join(root, "store"));
      saveDataRootPreference(file, null);
      assert.equal(loadDesktopPreference(file).dataRoot, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a relative dataRoot left in the file", () => {
    const root = tempDir();
    const file = join(root, "desktop-settings.json");
    try {
      saveDesktopPreference(file, { mode: "local", locale: "en" });
      writeFileSync(
        file,
        `${JSON.stringify({ mode: "local", locale: "en", dataRoot: "relative" }, null, 2)}\n`,
      );
      const loaded = loadDesktopPreference(file);
      assert.equal(loaded.dataRoot, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kernel database match", () => {
  it("requires a reported path and compares it as a filesystem path", () => {
    assert.equal(kernelDatabaseMatches("/data/regenic.db", null), false);
    assert.equal(kernelDatabaseMatches("/data/regenic.db", "  "), false);
    assert.equal(
      kernelDatabaseMatches("/data/regenic.db", join("/data", "regenic.db")),
      true,
    );
    assert.equal(kernelDatabaseMatches("/data/a.db", "/data/b.db"), false);
  });
});

describe("remote volume hint", () => {
  it("flags UNC and typical mount roots", () => {
    assert.equal(isRemoteOrRemovablePath("\\\\server\\share\\regenic"), true);
    assert.equal(isRemoteOrRemovablePath("/Volumes/USB/regenic"), true);
    assert.equal(isRemoteOrRemovablePath("/home/ada/.regenic"), false);
  });

  it("flags Windows removable and network drives from the volume kind", () => {
    assert.equal(
      isRemoteOrRemovablePath("E:\\regenic", () => "removable"),
      true,
    );
    assert.equal(
      isRemoteOrRemovablePath("Z:\\share\\regenic", () => "remote"),
      true,
    );
    assert.equal(
      isRemoteOrRemovablePath("D:\\regenic", () => "fixed"),
      false,
    );
  });
});

describe("forbidden data roots", () => {
  it("blocks unix system folders but not a home store", () => {
    assert.equal(isForbiddenDataRoot("/"), true);
    assert.equal(isForbiddenDataRoot("/etc/regenic"), true);
    assert.equal(isForbiddenDataRoot("/usr/local/regenic"), true);
    assert.equal(isForbiddenDataRoot("/home/ada/.regenic"), false);
    assert.equal(isForbiddenDataRoot("/data/regenic"), false);
  });

  it("blocks the Windows system drive and OS folders, not D:", () => {
    const windows = { platform: "win32" as const, systemRoot: "C:\\Windows" };
    assert.equal(isForbiddenDataRoot("C:\\", windows), true);
    assert.equal(isForbiddenDataRoot("C:\\Windows\\System32", windows), true);
    assert.equal(isForbiddenDataRoot("C:\\Program Files\\Regenic", windows), true);
    assert.equal(isForbiddenDataRoot("C:\\Users\\ada\\.regenic", windows), false);
    assert.equal(isForbiddenDataRoot("D:\\regenic", windows), false);
    assert.equal(isForbiddenDataRoot("D:\\", windows), false);
  });
});

describe("volume root nesting", () => {
  it("puts a Windows drive root under Regenic", () => {
    assert.equal(nestVolumeRoot("D:\\", "win32"), `D:\\${STORE_FOLDER}`);
    assert.equal(nestVolumeRoot("D:", "win32"), `D:\\${STORE_FOLDER}`);
    assert.equal(nestVolumeRoot("D:\\data", "win32"), "D:\\data");
    assert.equal(nestVolumeRoot("/data/regenic", "darwin"), "/data/regenic");
  });

  it("nests a picked location unless it is already a store folder", () => {
    assert.equal(
      nestDataRoot("/data/projects", { exists: () => false }),
      parseDataRoot(join("/data/projects", STORE_FOLDER)),
    );
    assert.equal(
      nestDataRoot("/data/Regenic", { exists: () => false }),
      parseDataRoot("/data/Regenic"),
    );
    assert.equal(
      nestDataRoot("/home/ada/.regenic", { exists: () => false }),
      parseDataRoot("/home/ada/.regenic"),
    );
    assert.equal(
      nestDataRoot("/", { exists: () => false }),
      parseDataRoot("/"),
    );
  });

  it("does not nest when the picked folder already has a store", () => {
    const root = tempDir();
    try {
      writeFileSync(join(root, "regenic.db"), "db");
      assert.equal(nestDataRoot(root), parseDataRoot(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sqlite store sniff", () => {
  it("accepts the SQLite header and rejects a random file", () => {
    const root = tempDir();
    try {
      const good = join(root, "good.db");
      const bad = join(root, "bad.db");
      writeFileSync(
        good,
        Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from("x")]),
      );
      writeFileSync(bad, "old");
      assert.equal(looksLikeSqliteDatabase(good), true);
      assert.equal(looksLikeSqliteDatabase(bad), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("store lock", () => {
  it("treats a live foreign pid as held and a dead pid as stale", () => {
    const root = tempDir();
    try {
      mkdirSync(root, { recursive: true });
      const live = acquireStoreLock(
        root,
        { pid: 11, origin: "http://127.0.0.1:4370" },
        { isAlive: (pid) => pid === 11 },
      );
      assert.equal(live.pid, 11);
      assert.equal(
        inspectStoreLock(root, 22, { isAlive: (pid) => pid === 11 }).state,
        "held",
      );
      assert.equal(
        storeLockHeldByOther(root, 22, { isAlive: (pid) => pid === 11 }),
        true,
      );
      assert.equal(
        inspectStoreLock(root, 22, { isAlive: () => false }).state,
        "stale",
      );
      acquireStoreLock(root, { pid: 22 }, { isAlive: () => false });
      assert.equal(
        inspectStoreLock(root, 22, { isAlive: (pid) => pid === 22 }).state,
        "ours",
      );
      releaseStoreLock(root, 22);
      assert.equal(existsSync(storeLockPath(root)), false);
      assert.equal(STORE_LOCK_NAME, "regenic.store.lock");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a second holder overwrite a live lock", () => {
    const root = tempDir();
    try {
      mkdirSync(root, { recursive: true });
      acquireStoreLock(root, { pid: 11 }, { isAlive: (pid) => pid === 11 });
      assert.throws(
        () => acquireStoreLock(root, { pid: 22 }, { isAlive: (pid) => pid === 11 }),
        /settings.dataDirReasonHeld/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("store identity", () => {
  it("follows a relocation when the destination still has the same store id", () => {
    const root = tempDir();
    try {
      const home = join(root, "home");
      const from = join(home, ".regenic");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "regenic.db"), "db");
      writeStoreIdentity(to, { id: "store-1" });
      writeStoreRelocation(from, to, "store-1");
      assert.equal(followStoreRelocation(from), to);
      const resolved = applyStoreRelocation(
        resolveDataPaths({
          repoRoot: "/repo",
          homeDir: home,
          exists: () => false,
        }),
      );
      assert.equal(resolved.source, "relocated");
      assert.equal(resolved.dataRoot, parseDataRoot(to));
      assert.equal(resolved.relocatedFrom, parseDataRoot(from));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow when the destination store id no longer matches", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "regenic.db"), "db");
      writeStoreIdentity(to, { id: "other" });
      writeStoreRelocation(from, to, "store-1");
      assert.equal(followStoreRelocation(from), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a saved dataRoot even if that folder has a relocation", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "regenic.db"), "db");
      writeStoreIdentity(to, { id: "store-1" });
      writeStoreRelocation(from, to, "store-1");
      const resolved = applyStoreRelocation(
        resolveDataPaths({
          repoRoot: "/repo",
          homeDir: "/home/ada",
          dataRoot: from,
          exists: () => false,
        }),
      );
      assert.equal(resolved.source, "settings");
      assert.equal(resolved.dataRoot, parseDataRoot(from));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("seals the source after migrate and treats a return as a new store", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      const identity = prepareDestinationStore(to, "migrate", from, {
        randomId: () => "store-1",
      });
      assert.equal(identity.id, "store-1");
      assert.equal(readStoreIdentity(from)?.id, "store-1");
      assert.equal(readStoreIdentity(to)?.id, "store-1");
      sealSourceStore(from, to, "migrate", identity);
      assert.equal(readStoreRelocation(from)?.to, parseDataRoot(to));
      assert.equal(reclaimStoreIfRelocated(from, { randomId: () => "fork-2" }), true);
      assert.equal(readStoreRelocation(from), null);
      assert.equal(readStoreIdentity(from)?.id, "fork-2");
      assert.equal(readStoreIdentity(to)?.id, "store-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers to discard a sealed leftover that still points at the live store", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(from, "regenic.db"), "old-db");
      writeFileSync(join(to, "regenic.db"), "new-db");
      writeStoreIdentity(to, { id: "store-1" });
      writeStoreRelocation(from, to, "store-1");
      const retention = inspectSourceRetention(from, { dataRoot: to });
      assert.equal(retention?.path, parseDataRoot(from));
      assert.equal(retention?.canDelete, true);
      assert.equal(retention?.bytes, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not offer discard for a checkout root or a mismatched tombstone", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(from, "regenic.db"), "old-db");
      writeFileSync(join(to, "regenic.db"), "new-db");
      writeStoreIdentity(to, { id: "store-1" });
      writeStoreRelocation(from, to, "store-1");
      assert.equal(
        inspectSourceRetention(from, { dataRoot: to }, { repoRoot: from }),
        null,
      );
      writeStoreIdentity(to, { id: "other" });
      assert.equal(inspectSourceRetention(from, { dataRoot: to }), null);
      writeStoreIdentity(to, { id: "store-1" });
      writeStoreRelocation(from, join(root, "elsewhere"), "store-1");
      assert.equal(inspectSourceRetention(from, { dataRoot: to }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts a relocated folder as a new store id", () => {
    const root = tempDir();
    try {
      const from = join(root, "from");
      const to = join(root, "to");
      mkdirSync(from, { recursive: true });
      writeStoreRelocation(from, to, "store-1");
      const next = prepareDestinationStore(from, "adopt", "/unused", {
        randomId: () => "adopt-9",
      });
      assert.equal(next.id, "adopt-9");
      assert.equal(readStoreRelocation(from), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
