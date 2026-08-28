import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  isSupportedConnectorProtocol,
  type ChannelDriver,
  type TaskExecutor,
} from "@regenic/domain";

const nodeRequire = createRequire(__filename);

/**
 * Load extra ChannelDrivers and TaskExecutors from env at process start.
 * The public tree does not know private package names or sibling paths.
 *
 * - REGENIC_CHANNEL_PLUGIN: module id or absolute path to one package
 * - REGENIC_CRM_CONNECTOR: same, kept for existing deploys
 * - REGENIC_PLUGIN_DIR: directory of packages (each child with package.json)
 *
 * One package may export both an L0 driver and an L6 executor. Local
 * plugins stay in-process; only HTTP executors leave the kernel process.
 */
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
): { drivers: ChannelDriver[]; executors: TaskExecutor[] } {
  const drivers: ChannelDriver[] = [];
  const executors: TaskExecutor[] = [];
  for (const spec of explicitPluginSpecs(env)) {
    const loaded = loadPlugin(spec, { warnIfEmpty: true });
    drivers.push(...loaded.drivers);
    executors.push(...loaded.executors);
  }
  for (const spec of pluginDirSpecs(env)) {
    const loaded = loadPlugin(spec, { warnIfEmpty: false });
    drivers.push(...loaded.drivers);
    executors.push(...loaded.executors);
  }
  return {
    drivers: uniqueDrivers(drivers),
    executors: uniqueExecutors(executors),
  };
}

export function resolvePluginSpecs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set([...explicitPluginSpecs(env), ...pluginDirSpecs(env)])];
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
  const pluginDir = env.REGENIC_PLUGIN_DIR?.trim();
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
  options: { warnIfEmpty: boolean },
): { drivers: ChannelDriver[]; executors: TaskExecutor[] } {
  try {
    const resolved = resolveSpec(spec);
    if (!resolved) {
      console.warn(`regenic extra connector: cannot resolve ${spec}`);
      return { drivers: [], executors: [] };
    }
    const loaded = nodeRequire(resolved);
    const drivers = driversFromModule(loaded);
    const executors = executorsFromModule(loaded);
    if (drivers.length === 0 && executors.length === 0 && options.warnIfEmpty) {
      console.warn(
        `regenic extra connector: ${spec} exported no ChannelDriver or TaskExecutor`,
      );
    }
    return { drivers, executors };
  } catch (error) {
    console.warn(`regenic extra connector: failed to load ${spec}`, error);
    return { drivers: [], executors: [] };
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

function driversFromModule(loaded: unknown): ChannelDriver[] {
  if (!loaded || typeof loaded !== "object") {
    return [];
  }
  return Object.values(loaded).filter((value): value is ChannelDriver => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as ChannelDriver).connector_type !== "string" ||
      typeof (value as ChannelDriver).source !== "string" ||
      typeof (value as ChannelDriver).install !== "function"
    ) {
      return false;
    }
    const driver = value as ChannelDriver;
    if (!isSupportedConnectorProtocol(driver.connector_protocol)) {
      console.warn(
        `regenic extra connector: skip ${driver.connector_type} unsupported protocol ${String(driver.connector_protocol)}`,
      );
      return false;
    }
    return true;
  });
}

function executorsFromModule(loaded: unknown): TaskExecutor[] {
  if (!loaded || typeof loaded !== "object") {
    return [];
  }
  return Object.values(loaded).filter((value): value is TaskExecutor => {
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
  });
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
