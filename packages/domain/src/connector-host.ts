import type { Host, Plugin, PluginHandle } from "@regenic/plugin-host";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import {
  readInstallSecret,
  writeKeychainSecret,
  type KeychainSecretRef,
} from "./keychain";

const WRAPPED = Symbol("regenic.connectorHost");
const DRIVER_SERVICES = new Set(["connectors", "egress"]);

export interface ConnectorSecrets {
  read(connectorType: string, installationId: string, field: string): Promise<string | undefined>;
  write(ref: KeychainSecretRef, secret: string): void;
}

/**
 * What a ChannelDriver may use. Kernel services (authority, ingest, blobs,
 * executors) stay off this surface so extra packages cannot write Events.
 */
export interface ConnectorHost {
  get(name: "connectors"): ConnectorRegistry;
  get(name: "egress"): EgressRegistry;
  plugin<C>(plugin: Plugin<C>, config?: C): Promise<PluginHandle>;
  now(): string;
  secrets: ConnectorSecrets;
}

export function asConnectorHost(host: Host | ConnectorHost): ConnectorHost {
  if (isConnectorHost(host)) {
    return host;
  }
  const kernel = host;
  const wrapped: ConnectorHost & { [WRAPPED]: true } = {
    [WRAPPED]: true,
    get: ((name: "connectors" | "egress") => {
      if (!DRIVER_SERVICES.has(name)) {
        throw new Error(`ConnectorHost: ${name} is not available to drivers`);
      }
      return name === "connectors"
        ? kernel.get("connectors")
        : kernel.get("egress");
    }) as ConnectorHost["get"],
    plugin(plugin, config) {
      return kernel.plugin(plugin, config);
    },
    now() {
      return new Date().toISOString();
    },
    secrets: {
      read: readInstallSecret,
      write: writeKeychainSecret,
    },
  };
  return wrapped;
}

export function isConnectorHost(value: unknown): value is ConnectorHost {
  return Boolean(value && typeof value === "object" && WRAPPED in value);
}
