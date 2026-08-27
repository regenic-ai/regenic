import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ChannelDriver } from "@regenic/domain";

const nodeRequire = createRequire(__filename);

/**
 * Load extra ChannelDrivers from env at process start. The public tree
 * does not know private package names or sibling checkout paths.
 *
 * - REGENIC_CHANNEL_PLUGIN: module id or absolute path to one package
 * - REGENIC_CRM_CONNECTOR: same, kept for existing deploys
 * - REGENIC_PLUGIN_DIR: directory of packages (each child with package.json)
 */
export function extraChannelDrivers(
  env: NodeJS.ProcessEnv = process.env,
): ChannelDriver[] {
  const drivers: ChannelDriver[] = [];
  for (const spec of resolvePluginSpecs(env)) {
    drivers.push(...loadDrivers(spec));
  }
  return uniqueDrivers(drivers);
}

export function resolvePluginSpecs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const specs: string[] = [];
  for (const key of ["REGENIC_CHANNEL_PLUGIN", "REGENIC_CRM_CONNECTOR"]) {
    const spec = env[key]?.trim();
    if (spec) {
      specs.push(spec);
    }
  }
  const pluginDir = env.REGENIC_PLUGIN_DIR?.trim();
  if (pluginDir && existsSync(pluginDir)) {
    for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(pluginDir, entry.name);
      if (existsSync(path.join(child, "package.json"))) {
        specs.push(child);
      }
    }
  }
  return [...new Set(specs)];
}

function loadDrivers(spec: string): ChannelDriver[] {
  try {
    const resolved = resolveSpec(spec);
    if (!resolved) {
      return [];
    }
    return driversFromModule(nodeRequire(resolved));
  } catch {
    return [];
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
  return Object.values(loaded).filter(
    (value): value is ChannelDriver =>
      Boolean(
        value &&
          typeof value === "object" &&
          typeof (value as ChannelDriver).connector_type === "string" &&
          typeof (value as ChannelDriver).source === "string" &&
          typeof (value as ChannelDriver).install === "function",
      ),
  );
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
