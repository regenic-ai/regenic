import type { Host, HostContext, Plugin, PluginHandle } from "@regenic/plugin-host";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import {
  readInstallSecret,
  writeKeychainSecret,
  type KeychainSecretRef,
} from "./keychain";

const WRAPPED = Symbol("regenic.connectorHost");
const DRIVER_SERVICES = new Set(["connectors", "egress"]);
const KERNEL_SERVICES = new Set([
  "authority",
  "ingest",
  "blobs",
  "executors",
]);

export interface ConnectorSecrets {
  read(connectorType: string, installationId: string, field: string): Promise<string | undefined>;
  write(ref: KeychainSecretRef, secret: string): void;
}

/**
 * What a ChannelDriver may use. Kernel services (authority, ingest, blobs,
 * executors) stay off this surface so extra packages cannot write Events.
 * `plugin()` apply() sees the same narrow `get`.
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
      return kernel.plugin(narrowDriverPlugin(plugin), config);
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

function narrowDriverPlugin<C>(plugin: Plugin<C>): Plugin<C> {
  return {
    name: plugin.name,
    inject: plugin.inject,
    apply(ctx, config) {
      return plugin.apply(asDriverPluginContext(ctx), config);
    },
  };
}

function asDriverPluginContext(ctx: HostContext): HostContext {
  return {
    provide(name: string, value: unknown) {
      if (KERNEL_SERVICES.has(name) || DRIVER_SERVICES.has(name)) {
        throw new Error(`ConnectorHost: cannot provide ${name}`);
      }
      return ctx.provide(name, value);
    },
    get(name: string) {
      if (!DRIVER_SERVICES.has(name)) {
        throw new Error(`ConnectorHost: ${name} is not available to drivers`);
      }
      return ctx.get(name);
    },
    plugin(plugin, config) {
      return ctx.plugin(narrowDriverPlugin(plugin), config);
    },
    effect(setup) {
      return ctx.effect(setup);
    },
    on(event, handler) {
      return ctx.on(event, handler);
    },
    emit(event, ...args) {
      return ctx.emit(event, ...args);
    },
  };
}
