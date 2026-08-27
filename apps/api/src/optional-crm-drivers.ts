import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ChannelDriver } from "@regenic/domain";

const nodeRequire = createRequire(__filename);

/**
 * Load extra drivers from env only. The public tree does not know
 * internal package names or sibling checkout paths.
 *
 * - REGENIC_CRM_CONNECTOR: module id or absolute path to one package
 * - REGENIC_PLUGIN_DIR: directory of packages (each child with package.json)
 */
export function optionalCrmDrivers(): ChannelDriver[] {
  const drivers: ChannelDriver[] = [];
  for (const spec of resolvePluginSpecs()) {
    drivers.push(...loadDrivers(spec));
  }
  return uniqueDrivers(drivers);
}

export function registerOptionalCrmDrivers(registry: {
  has(type: string): boolean;
  register(driver: ChannelDriver): unknown;
}): ChannelDriver[] {
  const loaded = optionalCrmDrivers();
  for (const driver of loaded) {
    if (!registry.has(driver.connector_type)) {
      registry.register(driver);
    }
  }
  return loaded;
}

export function loadedPrivateConnectorServices(registry: {
  has(type: string): boolean;
}): Record<string, { ready: boolean; hint: string }> {
  if (registry.has("crm-ops-review") || registry.has("crm-order-review")) {
    return {
      "crm-connector": {
        ready: true,
        hint: "Private connector is loaded.",
      },
    };
  }
  return {};
}

export function resolvePluginSpecs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const specs: string[] = [];
  const connector = env.REGENIC_CRM_CONNECTOR?.trim();
  if (connector) {
    specs.push(connector);
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
  return specs;
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
          typeof (value as ChannelDriver).source === "string",
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
