import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ChannelDriverRegistry,
  CONNECTOR_PROTOCOL,
  LocalExecutorPluginRegistry,
  isSupportedConnectorProtocol,
  type ChannelDriver,
  type TaskExecutor,
} from "@regenic/domain";

const nodeRequire = createRequire(__filename);
const DEFAULT_CATALOG_ORDER = 1_000;
const successfulExtraSpecs = new Set<string>();
const inventoryBySpec = new Map<string, PluginInventoryItem>();

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
export type PluginLoadStatus = "loaded" | "skipped" | "failed";

export interface PluginInventoryItem {
  id: string;
  spec: string;
  version: string | null;
  display_name: string | null;
  origin: PluginOrigin;
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
): { drivers: string[]; executors: string[] } {
  const addedDrivers: string[] = [];
  const addedExecutors: string[] = [];
  const extra = extraPlugins(env);
  for (const driver of extra.drivers) {
    if (drivers.has(driver.connector_type)) {
      continue;
    }
    drivers.register(driver);
    addedDrivers.push(driver.connector_type);
  }
  for (const plugin of extra.executors) {
    const source = plugin.catalog().source?.trim();
    if (!source || executors.forSource(source)) {
      continue;
    }
    executors.register(plugin);
    addedExecutors.push(source);
  }
  return { drivers: addedDrivers, executors: addedExecutors };
}

export function firstPartyPlugins(
  kernelPackageJson = kernelPackageJsonPath(),
): LoadedPlugins {
  return collectPlugins(firstPartyPluginSpecs(kernelPackageJson), [], {
    required: true,
    origin: "first_party",
  });
}

export function firstPartyPluginSpecs(
  kernelPackageJson = kernelPackageJsonPath(),
): string[] {
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

export function listPluginInventory(): PluginInventoryItem[] {
  return [...inventoryBySpec.values()].sort((left, right) => {
    if (left.origin !== right.origin) {
      return left.origin === "first_party" ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
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
    if (!entry.isDirectory()) {
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
  inventoryBySpec.set(spec, {
    id: meta?.manifest?.id?.trim() || meta?.name?.trim() || spec,
    spec,
    version: meta?.version?.trim() || null,
    display_name: meta?.manifest?.displayName?.trim() || null,
    origin,
    trust: origin === "first_party" ? "core" : "unsigned",
    status: update.status,
    path: meta?.dir ?? (existsSync(spec) ? spec : null),
    drivers: update.drivers ?? [],
    executors: update.executors ?? [],
    error: update.error ?? null,
  });
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
