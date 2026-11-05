import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ChannelDriverRegistry,
  CONNECTOR_PROTOCOL,
  LocalExecutorPluginRegistry,
  isSupportedConnectorProtocol,
  type ChannelDriver,
  type TaskExecutor,
} from "@regenic/domain";
import {
  BUILTIN_CONNECTOR_SPECS,
  builtinChannelDrivers,
  builtinTaskExecutors,
} from "@regenic/connector-host";

const nodeRequire = createRequire(__filename);
const DEFAULT_CATALOG_ORDER = 1_000;
const MARKET_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const MARKET_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const successfulExtraSpecs = new Set<string>();
const inventoryBySpec = new Map<string, PluginInventoryItem>();
const extraDriverOwnerByType = new Map<string, string>();
const extraDriverSpecByObject = new WeakMap<ChannelDriver, string>();

interface RegenicPluginManifest {
  plugin?: boolean;
  catalogOrder?: number;
  id?: string;
  displayName?: string;
  engines?: { regenic?: string };
  contributes?: {
    drivers?: string[];
    executors?: string[];
  };
}

interface PluginPackage {
  name?: string;
  version?: string;
  dir: string;
  manifest?: RegenicPluginManifest;
}

interface PluginContributes {
  drivers: string[];
  executors: string[];
}

interface LoadedPlugins {
  drivers: ChannelDriver[];
  executors: TaskExecutor[];
}

export type PluginOrigin = "first_party" | "extra";
export type PluginTrust = "core" | "unsigned";
export type PluginLoadStatus = "loaded" | "skipped" | "failed" | "uninstall_pending" | "update_pending";
export type PluginInstallSource = "built_in" | "market" | "local";
export type MarketVersionChange = {
  package_name: string;
  from_version: string;
  to_version: string;
  operation: "update" | "rollback";
  stage_directory: string | null;
  previous_directory: string;
  target_directory: string | null;
};

export interface PluginInventoryItem {
  id: string;
  spec: string;
  package_name: string | null;
  version: string | null;
  display_name: string | null;
  origin: PluginOrigin;
  install_source: PluginInstallSource;
  previous_version: string | null;
  pending_version: string | null;
  pending_operation: "update" | "rollback" | null;
  trust: PluginTrust;
  status: PluginLoadStatus;
  path: string | null;
  drivers: string[];
  executors: string[];
  error: string | null;
}

/**
 * Discover ChannelDrivers and TaskExecutors from package.json contributes.
 *
 * First-party packages declare `regenic.plugin` plus `contributes`. The kernel
 * scans its own dependencies; Nest does not import driver symbols.
 *
 * Extra packages still load from env. New extra types can appear later via
 * `loadNewExtraPlugins` (watch + POST /v1/me/plugins/reload). Already
 * registered connector_type / executor source stay as first loaded.
 *
 * - REGENIC_CHANNEL_PLUGIN: module id or absolute path to one package
 * - REGENIC_CRM_CONNECTOR: same, kept for existing deploys
 * - REGENIC_PLUGIN_DIR: directory of packages (each child with package.json)
 */
export function createChannelDriverRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ChannelDriverRegistry {
  completePendingMarketRemovals(env);
  completePendingMarketVersionChanges(env);
  const registry = new ChannelDriverRegistry();
  for (const driver of firstPartyChannelDrivers()) {
    registry.register(driver);
  }
  for (const driver of extraChannelDrivers(env)) {
    if (registry.has(driver.connector_type)) {
      console.warn(
        `regenic extra connector: skip ${driver.connector_type}, already registered`,
      );
      continue;
    }
    registry.register(driver);
    const spec = extraDriverSpecByObject.get(driver);
    if (spec) {
      extraDriverOwnerByType.set(driver.connector_type, spec);
    }
  }
  return registry;
}

export function createExecutorPluginRegistry(
  env: NodeJS.ProcessEnv = process.env,
): LocalExecutorPluginRegistry {
  const registry = new LocalExecutorPluginRegistry();
  for (const plugin of firstPartyTaskExecutors()) {
    registry.register(plugin);
  }
  for (const plugin of extraTaskExecutors(env)) {
    const source = plugin.catalog().source?.trim();
    if (!source || registry.forSource(source)) {
      if (source) {
        console.warn(
          `regenic extra executor: skip ${source}, already registered`,
        );
      }
      continue;
    }
    registry.register(plugin);
  }
  return registry;
}

export function firstPartyChannelDrivers(): ChannelDriver[] {
  return firstPartyPlugins().drivers;
}

export function firstPartyTaskExecutors(): TaskExecutor[] {
  return firstPartyPlugins().executors;
}

export function extraChannelDrivers(
  env: NodeJS.ProcessEnv = process.env,
): ChannelDriver[] {
  return extraPlugins(env).drivers;
}

export function extraTaskExecutors(
  env: NodeJS.ProcessEnv = process.env,
): TaskExecutor[] {
  return extraPlugins(env).executors;
}

export function extraPlugins(
  env: NodeJS.ProcessEnv = process.env,
): LoadedPlugins {
  const specs = [...new Set([...explicitPluginSpecs(env), ...pluginDirSpecs(env)])];
  const drivers: ChannelDriver[] = [];
  const executors: TaskExecutor[] = [];
  for (const spec of specs) {
    if (!successfulExtraSpecs.has(spec)) {
      forgetResolvedModule(spec);
    }
    const loaded = loadPlugin(spec, {
      warnIfEmpty: false,
      required: false,
      origin: "extra",
    });
    if (loaded.drivers.length > 0 || loaded.executors.length > 0) {
      successfulExtraSpecs.add(spec);
    }
    for (const driver of loaded.drivers) {
      extraDriverSpecByObject.set(driver, spec);
    }
    drivers.push(...loaded.drivers);
    executors.push(...loaded.executors);
  }
  return {
    drivers: uniqueDrivers(drivers),
    executors: uniqueExecutors(executors),
  };
}

/**
 * Discover extra packages that appeared after process start.
 * Registers only new connector_type / executor source values.
 * Does not unload or replace a driver that is already in the registry.
 */
export function loadNewExtraPlugins(
  drivers: ChannelDriverRegistry,
  executors: LocalExecutorPluginRegistry,
  env: NodeJS.ProcessEnv = process.env,
): { drivers: string[]; executors: string[]; registeredDrivers: string[] } {
  const addedDrivers: string[] = [];
  const addedExecutors: string[] = [];
  const registeredDrivers: string[] = [];
  const extra = extraPlugins(env);
  for (const driver of extra.drivers) {
    const spec = extraDriverSpecByObject.get(driver);
    if (!spec) continue;
    if (drivers.has(driver.connector_type)) {
      if (extraDriverOwnerByType.get(driver.connector_type) === spec) {
        registeredDrivers.push(driver.connector_type);
      }
      continue;
    }
    drivers.register(driver);
    extraDriverOwnerByType.set(driver.connector_type, spec);
    addedDrivers.push(driver.connector_type);
    registeredDrivers.push(driver.connector_type);
  }
  for (const plugin of extra.executors) {
    const source = plugin.catalog().source?.trim();
    if (!source || executors.forSource(source)) {
      continue;
    }
    executors.register(plugin);
    addedExecutors.push(source);
  }
  return {
    drivers: addedDrivers,
    executors: addedExecutors,
    registeredDrivers,
  };
}

export function retryMarketPluginRegistration(
  packageName: string,
  drivers: ChannelDriverRegistry,
  executors: LocalExecutorPluginRegistry,
  env: NodeJS.ProcessEnv = process.env,
): { driverTypes: string[]; registeredDriverTypes: string[] } | undefined {
  const spec = pluginDirSpecs(env).find((candidate) => {
    const meta = readPluginPackage(candidate);
    return meta?.name === packageName &&
      pluginInstallSource(meta, candidate, "extra") === "market";
  });
  if (!spec) return undefined;
  if (!successfulExtraSpecs.has(spec)) forgetResolvedModule(spec);
  const loaded = loadPlugin(spec, {
    warnIfEmpty: true,
    required: false,
    origin: "extra",
  });
  const registeredDriverTypes: string[] = [];
  for (const driver of loaded.drivers) {
    extraDriverSpecByObject.set(driver, spec);
    if (drivers.has(driver.connector_type)) {
      if (extraDriverOwnerByType.get(driver.connector_type) === spec) {
        registeredDriverTypes.push(driver.connector_type);
      }
      continue;
    }
    drivers.register(driver);
    extraDriverOwnerByType.set(driver.connector_type, spec);
    registeredDriverTypes.push(driver.connector_type);
  }
  for (const executor of loaded.executors) {
    const source = executor.catalog().source?.trim();
    if (source && !executors.forSource(source)) executors.register(executor);
  }
  return {
    driverTypes: loaded.drivers.map((driver) => driver.connector_type),
    registeredDriverTypes,
  };
}

export function firstPartyPlugins(
  kernelPackageJson?: string,
): LoadedPlugins {
  if (!kernelPackageJson) {
    const drivers = builtinChannelDrivers();
    const executors = builtinTaskExecutors();
    for (let index = 0; index < BUILTIN_CONNECTOR_SPECS.length; index += 1) {
      const spec = BUILTIN_CONNECTOR_SPECS[index]!;
      const driver = drivers[index];
      recordInventory(spec, undefined, "first_party", {
        status: "loaded",
        drivers: driver ? [driver.connector_type] : [],
        executors:
          spec === "@regenic/dsh-connector"
            ? executors.flatMap((executor) => {
                const source = executor.catalog().source?.trim();
                return source ? [source] : [];
              })
            : [],
      });
    }
    return { drivers, executors };
  }
  return collectPlugins(firstPartyPluginSpecs(kernelPackageJson), [], {
    required: true,
    origin: "first_party",
  });
}

export function firstPartyPluginSpecs(
  kernelPackageJson?: string,
): string[] {
  if (!kernelPackageJson) {
    return [...BUILTIN_CONNECTOR_SPECS];
  }
  const pkg = nodeRequire(kernelPackageJson) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const names = Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  });
  const found: Array<{ spec: string; order: number }> = [];
  for (const name of names) {
    const meta = readPluginPackage(name);
    if (!meta?.manifest?.plugin) {
      continue;
    }
    const order = Number(meta.manifest.catalogOrder);
    found.push({
      spec: name,
      order: Number.isFinite(order) ? order : DEFAULT_CATALOG_ORDER,
    });
  }
  found.sort((left, right) => left.order - right.order || left.spec.localeCompare(right.spec));
  return found.map((item) => item.spec);
}

export function resolvePluginSpecs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set([...explicitPluginSpecs(env), ...pluginDirSpecs(env)])];
}

export function defaultPluginDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    return null;
  }
  return path.join(home, ".regenic", "plugins");
}

export function resolvePluginDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.REGENIC_PLUGIN_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return defaultPluginDirectory(env);
}

export function ensurePluginDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = resolvePluginDirectory(env);
  if (!dir) {
    return null;
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function completePendingMarketRemovals(env: NodeJS.ProcessEnv): void {
  const pluginDir = resolvePluginDirectory(env);
  if (!pluginDir || !existsSync(pluginDir)) return;
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    removePendingMarketInstall(path.join(pluginDir, entry.name));
  }
}

export function completePendingMarketVersionChanges(env: NodeJS.ProcessEnv = process.env): void {
  const pluginDir = resolvePluginDirectory(env);
  if (!pluginDir || !existsSync(pluginDir)) return;
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(".regenic-market-transaction-")) continue;
    const transactionPath = path.join(pluginDir, entry.name);
    try {
      const change = JSON.parse(readFileSync(transactionPath, "utf8")) as MarketVersionChange;
      if (!isSafeTransaction(change, pluginDir) ||
        entry.name !== path.basename(marketTransactionPath(pluginDir, change.package_name))) {
        continue;
      }
      const currentPath = path.join(pluginDir, marketPackageDirectory(change.package_name));
      const versionDirectory = marketVersionsDirectory(pluginDir, change.package_name);
      const previousPath = path.join(versionDirectory, change.previous_directory);
      const targetPath = change.operation === "update"
        ? path.join(pluginDir, change.stage_directory!)
        : path.join(versionDirectory, change.target_directory!);
      const currentVersion = installedMarketVersion(currentPath, change.package_name);
      if (currentVersion === change.to_version) {
        rmSync(transactionPath, { force: true });
        continue;
      }
      if (currentVersion && currentVersion !== change.from_version) {
        throw new Error("Installed market package version changed during pending update");
      }
      mkdirSync(path.dirname(previousPath), { recursive: true });
      if (existsSync(currentPath) && !existsSync(previousPath)) {
        renameSync(currentPath, previousPath);
      }
      if (!existsSync(currentPath)) {
        if (installedMarketVersion(targetPath, change.package_name) !== change.to_version) {
          if (existsSync(previousPath)) renameSync(previousPath, currentPath);
          throw new Error("Pending market package version is missing or invalid");
        }
        renameSync(targetPath, currentPath);
      }
      if (installedMarketVersion(currentPath, change.package_name) !== change.to_version) {
        throw new Error("Market package version switch did not complete");
      }
      rmSync(transactionPath, { force: true });
      pruneMarketVersionHistory(pluginDir, change.package_name);
    } catch (error) {
      console.warn("regenic connector market: pending version change could not be completed", error);
    }
  }
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".regenic-market-stage-")) continue;
    const packageHash = entry.name.slice(".regenic-market-stage-".length);
    if (!/^[0-9a-f]{24}$/u.test(packageHash)) continue;
    const transactionPath = path.join(
      pluginDir,
      `.regenic-market-transaction-${packageHash}.json`,
    );
    if (!existsSync(transactionPath)) {
      rmSync(path.join(pluginDir, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      /^\.regenic-market-[A-Za-z0-9_-]{6}$/u.test(entry.name)
    ) {
      rmSync(path.join(pluginDir, entry.name), { recursive: true, force: true });
    }
  }
}

export function listPluginInventory(): PluginInventoryItem[] {
  return [...inventoryBySpec.values()].sort((left, right) => {
    if (left.origin !== right.origin) {
      return left.origin === "first_party" ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export function markMarketPluginRemovalPending(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pluginDirectory = resolvePluginDirectory(env);
  const item = [...inventoryBySpec.values()].find(
    (candidate) =>
      candidate.origin === "extra" &&
      candidate.install_source === "market" &&
      candidate.package_name === packageName &&
      candidate.path,
  );
  if (
    !item?.path ||
    !pluginDirectory ||
    path.resolve(path.dirname(item.path)) !== path.resolve(pluginDirectory) ||
    !isMarketInstallPath(item.path, packageName) ||
    existsSync(path.join(item.path, ".regenic-market-uninstall.json"))
  ) {
    throw new Error("Market-managed connector package directory was not found");
  }
  const uninstallPath = path.join(item.path, ".regenic-market-uninstall.json");
  if (!existsSync(uninstallPath)) {
    writeFileSync(
      uninstallPath,
      JSON.stringify({ package_name: packageName, requested_at: new Date().toISOString() }),
      { flag: "wx" },
    );
  }
  inventoryBySpec.set(item.spec, {
    ...item,
    status: "uninstall_pending",
    error: "Package removal is pending; restart the API to complete it.",
  });
  return [...item.drivers];
}

export function marketVersionHistory(packageName: string, pluginDirectory?: string): Array<{
  version: string;
  directory: string;
  installed_at: string;
}> {
  const root = pluginDirectory ?? resolvePluginDirectory(process.env);
  if (!root || !MARKET_PACKAGE_NAME.test(packageName)) return [];
  const archiveRoot = marketVersionsDirectory(root, packageName);
  if (!existsSync(archiveRoot)) return [];
  return readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/u.test(entry.name))
    .flatMap((entry) => {
      const directory = path.join(archiveRoot, entry.name);
      try {
        const marker = JSON.parse(
          readFileSync(path.join(directory, ".regenic-market-install.json"), "utf8"),
        ) as { package_name?: unknown; version?: unknown; installed_at?: unknown };
        if (
          marker.package_name !== packageName ||
          typeof marker.version !== "string" ||
          typeof marker.installed_at !== "string"
        ) return [];
        return [{ version: marker.version, directory, installed_at: marker.installed_at }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => Date.parse(right.installed_at) - Date.parse(left.installed_at));
}

export function beginMarketVersionChange(
  change: MarketVersionChange,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const item = [...inventoryBySpec.values()].find(
    (candidate) =>
      candidate.package_name === change.package_name &&
      candidate.install_source === "market" &&
      candidate.path,
  );
  const pluginDirectory = resolvePluginDirectory(env);
  if (
    !item?.path ||
    !pluginDirectory ||
    path.resolve(path.dirname(item.path)) !== path.resolve(pluginDirectory) ||
    !isMarketInstallPath(item.path, change.package_name) ||
    item.status === "uninstall_pending" ||
    existsSync(path.join(item.path, ".regenic-market-uninstall.json")) ||
    change.from_version !== item.version ||
    !isVersion(change.to_version) ||
    !isSafeTransaction(change, pluginDirectory)
  ) {
    throw new Error("Market connector version change could not be validated");
  }
  const transactionPath = marketTransactionPath(pluginDirectory, change.package_name);
  if (existsSync(transactionPath)) {
    throw new Error("A market connector version change is already pending");
  }
  const temporaryPath = `${transactionPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(change), { flag: "wx" });
    renameSync(temporaryPath, transactionPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  inventoryBySpec.set(item.spec, {
    ...item,
    status: "update_pending",
    pending_version: change.to_version,
    pending_operation: change.operation,
    error: `Version change to ${change.to_version} is pending; restart the API to apply it.`,
  });
}

export function markMarketVersionChangePending(
  packageName: string,
  version: string,
  operation: "update" | "rollback",
): void {
  const item = [...inventoryBySpec.values()].find(
    (candidate) =>
      candidate.package_name === packageName &&
      candidate.install_source === "market",
  );
  if (!item) return;
  inventoryBySpec.set(item.spec, {
    ...item,
    status: "update_pending",
    pending_version: version,
    pending_operation: operation,
    error: `Version change to ${version} is pending; restart the API to apply it.`,
  });
}

function collectPlugins(
  requiredSpecs: string[],
  optionalSpecs: string[],
  options: { required: boolean; origin: PluginOrigin },
): LoadedPlugins {
  const drivers: ChannelDriver[] = [];
  const executors: TaskExecutor[] = [];
  for (const spec of requiredSpecs) {
    const loaded = loadPlugin(spec, {
      warnIfEmpty: true,
      required: options.required,
      origin: options.origin,
    });
    drivers.push(...loaded.drivers);
    executors.push(...loaded.executors);
  }
  for (const spec of optionalSpecs) {
    const loaded = loadPlugin(spec, {
      warnIfEmpty: false,
      required: false,
      origin: options.origin,
    });
    drivers.push(...loaded.drivers);
    executors.push(...loaded.executors);
  }
  return {
    drivers: uniqueDrivers(drivers),
    executors: uniqueExecutors(executors),
  };
}

function kernelPackageJsonPath(): string {
  return path.join(__dirname, "..", "package.json");
}

function readPluginPackage(spec: string): PluginPackage | undefined {
  try {
    let dir = existsSync(path.join(spec, "package.json"))
      ? spec
      : path.dirname(nodeRequire.resolve(spec));
    for (let hop = 0; hop < 6; hop += 1) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = nodeRequire(candidate) as {
          name?: string;
          version?: string;
          regenic?: RegenicPluginManifest;
        };
        return {
          name: pkg.name,
          version: pkg.version,
          dir,
          manifest: pkg.regenic,
        };
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function explicitPluginSpecs(env: NodeJS.ProcessEnv): string[] {
  const specs: string[] = [];
  for (const key of ["REGENIC_CHANNEL_PLUGIN", "REGENIC_CRM_CONNECTOR"]) {
    const spec = env[key]?.trim();
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

function pluginDirSpecs(env: NodeJS.ProcessEnv): string[] {
  const pluginDir = resolvePluginDirectory(env);
  if (!pluginDir || !existsSync(pluginDir)) {
    return [];
  }
  const specs: string[] = [];
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const child = path.join(pluginDir, entry.name);
    if (existsSync(path.join(child, "package.json"))) {
      specs.push(child);
    }
  }
  return specs;
}

function loadPlugin(
  spec: string,
  options: { warnIfEmpty: boolean; required: boolean; origin: PluginOrigin },
): LoadedPlugins {
  const meta = readPluginPackage(spec);
  const resolved = resolveSpec(spec);
  if (!resolved && !meta) {
    const message = `regenic extra connector: cannot resolve ${spec}`;
    recordInventory(spec, meta, options.origin, {
      status: "failed",
      error: message,
    });
    if (options.required) {
      throw new Error(message);
    }
    console.warn(message);
    return { drivers: [], executors: [] };
  }
  const engine = meta?.manifest?.engines?.regenic?.trim();
  if (engine && engine !== CONNECTOR_PROTOCOL) {
    const message = `regenic extra connector: ${spec} needs engines.regenic ${CONNECTOR_PROTOCOL}, got ${engine}`;
    recordInventory(spec, meta, options.origin, {
      status: "skipped",
      error: message,
    });
    if (options.required) {
      throw new Error(message);
    }
    console.warn(message);
    return { drivers: [], executors: [] };
  }
  const contributes = normalizeContributes(meta?.manifest?.contributes);
  if (!contributes) {
    const message = `regenic extra connector: ${spec} missing regenic.contributes`;
    recordInventory(spec, meta, options.origin, {
      status: "failed",
      error: message,
    });
    if (options.required) {
      throw new Error(message);
    }
    console.warn(message);
    return { drivers: [], executors: [] };
  }
  try {
    const loaded = nodeRequire(resolved ?? spec);
    const extracted = exportsFromContributes(loaded, contributes, spec);
    if (
      extracted.drivers.length === 0 &&
      extracted.executors.length === 0 &&
      options.warnIfEmpty
    ) {
      const message =
        extracted.error ??
        `regenic extra connector: ${spec} exported no ChannelDriver or TaskExecutor`;
      recordInventory(spec, meta, options.origin, {
        status: "failed",
        error: message,
        drivers: extracted.driverTypes,
        executors: extracted.executorSources,
      });
      if (options.required) {
        throw new Error(message);
      }
      console.warn(message);
      return { drivers: [], executors: [] };
    }
    if (extracted.error) {
      console.warn(extracted.error);
    }
    const ok = extracted.drivers.length > 0 || extracted.executors.length > 0;
    recordInventory(spec, meta, options.origin, {
      status: ok ? "loaded" : "failed",
      error: ok ? extracted.error : extracted.error ?? `regenic extra connector: ${spec} contributed nothing usable`,
      drivers: extracted.driverTypes,
      executors: extracted.executorSources,
    });
    return { drivers: extracted.drivers, executors: extracted.executors };
  } catch (error) {
    if (options.required) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : `failed to load ${spec}`;
    console.warn(`regenic extra connector: failed to load ${spec}`, error);
    recordInventory(spec, meta, options.origin, {
      status: "failed",
      error: message,
    });
    return { drivers: [], executors: [] };
  }
}

function exportsFromContributes(
  loaded: unknown,
  contributes: PluginContributes,
  spec: string,
): {
  drivers: ChannelDriver[];
  executors: TaskExecutor[];
  driverTypes: string[];
  executorSources: string[];
  error: string | null;
} {
  const drivers: ChannelDriver[] = [];
  const executors: TaskExecutor[] = [];
  const driverTypes: string[] = [];
  const executorSources: string[] = [];
  const errors: string[] = [];
  for (const name of contributes.drivers) {
    const value = exportByName(loaded, name);
    if (!isDriverShape(value)) {
      errors.push(`${spec} contribute ${name} is not a ChannelDriver`);
      continue;
    }
    if (!isSupportedConnectorProtocol(value.connector_protocol)) {
      errors.push(
        `regenic extra connector: skip ${value.connector_type} unsupported protocol ${String(value.connector_protocol)}`,
      );
      continue;
    }
    drivers.push(value);
    driverTypes.push(value.connector_type);
  }
  for (const name of contributes.executors) {
    const value = exportByName(loaded, name);
    if (!isExecutorShape(value)) {
      errors.push(`${spec} contribute ${name} is not a TaskExecutor`);
      continue;
    }
    const source = value.catalog().source?.trim();
    if (!source) {
      errors.push(`${spec} contribute ${name} has no catalog source`);
      continue;
    }
    executors.push(value);
    executorSources.push(source);
  }
  return {
    drivers,
    executors,
    driverTypes,
    executorSources,
    error: errors[0] ?? null,
  };
}

function exportByName(loaded: unknown, name: string): unknown {
  if (!loaded || typeof loaded !== "object") {
    return undefined;
  }
  return (loaded as Record<string, unknown>)[name];
}

function normalizeContributes(
  value: RegenicPluginManifest["contributes"],
): PluginContributes | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const drivers = stringList(value.drivers);
  const executors = stringList(value.executors);
  if (drivers.length === 0 && executors.length === 0) {
    return undefined;
  }
  return { drivers, executors };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

function recordInventory(
  spec: string,
  meta: PluginPackage | undefined,
  origin: PluginOrigin,
  update: {
    status: PluginLoadStatus;
    error?: string | null;
    drivers?: string[];
    executors?: string[];
  },
): void {
  const packageName = meta?.name?.trim();
  const packageDirectory = meta?.dir ?? spec;
  const pendingChange = packageName
    ? pendingMarketVersion(packageDirectory, packageName)
    : undefined;
  inventoryBySpec.set(spec, {
    id: meta?.manifest?.id?.trim() || meta?.name?.trim() || spec,
    spec,
    package_name: meta?.name?.trim() || null,
    version: meta?.version?.trim() || null,
    display_name: meta?.manifest?.displayName?.trim() || null,
    origin,
    install_source: pluginInstallSource(meta, spec, origin),
    previous_version: packageName
      ? marketVersionHistory(packageName, path.dirname(packageDirectory))[0]?.version ?? null
      : null,
    pending_version: pendingChange?.to_version ?? null,
    pending_operation: pendingChange?.operation ?? null,
    trust: origin === "first_party" ? "core" : "unsigned",
    status: pendingChange && update.status === "loaded" ? "update_pending" : update.status,
    path: meta?.dir ?? (existsSync(spec) ? spec : null),
    drivers: update.drivers ?? [],
    executors: update.executors ?? [],
    error: pendingChange
      ? `Version change to ${pendingChange.to_version} is pending; restart the API to apply it.`
      : update.error ?? null,
  });
}

function pendingMarketVersion(directory: string, packageName: string): MarketVersionChange | undefined {
  try {
    const pluginDirectory = path.dirname(directory);
    const value = JSON.parse(
      readFileSync(marketTransactionPath(pluginDirectory, packageName), "utf8"),
    ) as MarketVersionChange;
    return isSafeTransaction(value, pluginDirectory) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isSafeTransaction(value: MarketVersionChange, pluginDirectory: string): boolean {
  if (
    !value ||
    !MARKET_PACKAGE_NAME.test(value.package_name) ||
    !isVersion(value.from_version) ||
    !isVersion(value.to_version) ||
    !["update", "rollback"].includes(value.operation) ||
    !/^[0-9a-f-]{36}$/u.test(value.previous_directory)
  ) return false;
  if (value.operation === "update") {
    return value.stage_directory === marketStageDirectory(value.package_name) &&
      value.target_directory === null;
  }
  const target = value.target_directory;
  return value.stage_directory === null &&
    typeof target === "string" &&
    /^[0-9a-f-]{36}$/u.test(target);
}

function isVersion(value: string): boolean {
  return typeof value === "string" && MARKET_VERSION.test(value);
}

function marketPackageDirectory(packageName: string): string {
  return `market-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
}

function marketStageDirectory(packageName: string): string {
  return `.regenic-market-stage-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
}

function marketVersionsDirectoryName(packageName: string): string {
  return `.regenic-market-versions-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
}

function marketVersionsDirectory(pluginDirectory: string, packageName: string): string {
  return path.join(pluginDirectory, marketVersionsDirectoryName(packageName));
}

function marketTransactionPath(pluginDirectory: string, packageName: string): string {
  return path.join(
    pluginDirectory,
    `.regenic-market-transaction-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}.json`,
  );
}

function installedMarketVersion(directory: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    const marker = JSON.parse(
      readFileSync(path.join(directory, ".regenic-market-install.json"), "utf8"),
    ) as { package_name?: unknown; version?: unknown };
    if (
      manifest.name === packageName &&
      typeof manifest.version === "string" &&
      marker.package_name === packageName &&
      marker.version === manifest.version
    ) return manifest.version;
  } catch {
    return undefined;
  }
  return undefined;
}

function pruneMarketVersionHistory(pluginDirectory: string, packageName: string): void {
  const history = marketVersionHistory(packageName, pluginDirectory);
  for (const old of history.slice(3)) {
    rmSync(old.directory, { recursive: true, force: true });
  }
}

function pluginInstallSource(
  meta: PluginPackage | undefined,
  spec: string,
  origin: PluginOrigin,
): PluginInstallSource {
  if (origin === "first_party") return "built_in";
  const directory = meta?.dir ?? spec;
  if (!meta?.name || !isMarketInstallPath(directory, meta.name)) return "local";
  try {
    const marker = JSON.parse(
      readFileSync(path.join(directory, ".regenic-market-install.json"), "utf8"),
    ) as { package_name?: unknown };
    return marker.package_name === meta.name ? "market" : "local";
  } catch {
    return "local";
  }
}

function isMarketInstallPath(directory: string, packageName: string): boolean {
  const expected = `market-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
  return path.basename(directory) === expected;
}

function removePendingMarketInstall(directory: string): boolean {
  const removalPath = path.join(directory, ".regenic-market-uninstall.json");
  if (!existsSync(removalPath)) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    const install = JSON.parse(
      readFileSync(path.join(directory, ".regenic-market-install.json"), "utf8"),
    ) as { package_name?: unknown };
    const removal = JSON.parse(readFileSync(removalPath, "utf8")) as {
      package_name?: unknown;
    };
    if (
      typeof manifest.name !== "string" ||
      install.package_name !== manifest.name ||
      removal.package_name !== manifest.name ||
      !isMarketInstallPath(directory, manifest.name)
    ) {
      return false;
    }
    rmSync(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn("regenic connector market: could not finish pending package removal", error);
    return false;
  }
}

function forgetResolvedModule(spec: string): void {
  try {
    const resolved = resolveSpec(spec);
    if (!resolved) {
      return;
    }
    const id = nodeRequire.resolve(resolved);
    delete nodeRequire.cache[id];
  } catch {
    // Spec is not in the require cache yet.
  }
}

function resolveSpec(spec: string): string | undefined {
  try {
    return nodeRequire.resolve(spec);
  } catch {
    if (existsSync(path.join(spec, "package.json"))) {
      return spec;
    }
    return undefined;
  }
}

function isDriverShape(value: unknown): value is ChannelDriver {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ChannelDriver).connector_type === "string" &&
      typeof (value as ChannelDriver).source === "string" &&
      typeof (value as ChannelDriver).install === "function",
  );
}

function isExecutorShape(value: unknown): value is TaskExecutor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const executor = value as TaskExecutor;
  if (
    typeof executor.executor_type !== "string" ||
    typeof executor.capabilities !== "function" ||
    typeof executor.catalog !== "function" ||
    typeof executor.start !== "function" ||
    typeof executor.resume !== "function" ||
    typeof executor.status !== "function"
  ) {
    return false;
  }
  try {
    return Boolean(executor.catalog().source?.trim());
  } catch {
    return false;
  }
}

function uniqueDrivers(drivers: ChannelDriver[]): ChannelDriver[] {
  const seen = new Set<string>();
  return drivers.filter((driver) => {
    if (seen.has(driver.connector_type)) {
      return false;
    }
    seen.add(driver.connector_type);
    return true;
  });
}

function uniqueExecutors(executors: TaskExecutor[]): TaskExecutor[] {
  const seen = new Set<string>();
  return executors.filter((executor) => {
    const source = executor.catalog().source?.trim();
    if (!source || seen.has(source)) {
      return false;
    }
    seen.add(source);
    return true;
  });
}
