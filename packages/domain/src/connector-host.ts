import type { Host, HostContext, Plugin } from "@regenic/plugin-host";
import {
  installSecretRef,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorSecrets,
  type KeychainSecretRef,
  type PushIngestAck,
  type PushIngestBatch,
} from "@regenic/connector-contract";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import {
  readInstallSecret,
  writeKeychainSecret,
} from "./keychain";

export type { ConnectorHost, ConnectorSecrets };

const WRAPPED = Symbol("regenic.connectorHost");

type ConnectorPushSubmit = (
  installation: Pick<ConnectorInstallation, "id" | "org_id">,
  batch: PushIngestBatch,
) => Promise<PushIngestAck>;

let pushSubmit: ConnectorPushSubmit | undefined;

type ConnectorWatermarkLookup = (
  installation: Pick<ConnectorInstallation, "id">,
  streamKey: string,
) => Promise<string | undefined>;

let watermarkLookup: ConnectorWatermarkLookup | undefined;

/** API binds the ingest gate. Drivers only see `ConnectorHost.push`. */
export function bindConnectorPush(submit: ConnectorPushSubmit): void {
  pushSubmit = submit;
}

/** API binds the durable watermark read. Drivers resume a tail from it. */
export function bindConnectorWatermark(lookup: ConnectorWatermarkLookup): void {
  watermarkLookup = lookup;
}
const DRIVER_SERVICES = new Set(["connectors", "egress"]);
const KERNEL_SERVICES = new Set([
  "authority",
  "ingest",
  "blobs",
  "executors",
]);

/**
 * What a ChannelDriver may use. Kernel services (authority, ingest, blobs,
 * executors) stay off this surface so extra packages cannot write Events.
 * `plugin()` apply() sees the same narrow `get`.
 */
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
    push(installation, batch) {
      if (!pushSubmit) {
        throw new Error("Connector push is not bound");
      }
      return pushSubmit(installation, batch);
    },
    ackedWatermark(installation, streamKey) {
      if (!watermarkLookup) {
        return Promise.resolve(undefined);
      }
      return watermarkLookup(installation, streamKey);
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

type InstallationScope = Pick<ConnectorInstallation, "id" | "connector_type">;

/**
 * Host a driver may use for one installation. Registry, push, watermark, and
 * credential calls for any other installation fail. Kernel services stay hidden
 * by `asConnectorHost`.
 */
export function scopeConnectorInstallation(
  host: ConnectorHost,
  installation: InstallationScope,
): ConnectorHost {
  return scopeConnectorInstallations(host, [installation]);
}

/** Same boundary for a driver call that already holds several of its own installs. */
export function scopeConnectorInstallations(
  host: ConnectorHost,
  installations: readonly InstallationScope[],
): ConnectorHost {
  const allowed = new Map<string, string>();
  for (const installation of installations) {
    const id = installation.id.trim();
    const type = installation.connector_type.trim();
    if (id && type) {
      allowed.set(id, type);
    }
  }
  if (allowed.size === 0) {
    return host;
  }
  const scoped = {
    [WRAPPED]: true,
    get: ((name: "connectors" | "egress") =>
      scopeRegistry(
        name === "connectors" ? host.get("connectors") : host.get("egress"),
        allowed,
      )) as ConnectorHost["get"],
    plugin(plugin, config) {
      return host.plugin(narrowPluginToInstallations(plugin, allowed), config);
    },
    now: () => host.now(),
    secrets: scopeSecrets(host.secrets, allowed),
    ...(host.push
      ? {
          push: (installation, batch) => {
            assertInstallationId(allowed, installation.id);
            return host.push!(installation, batch);
          },
        }
      : {}),
    ...(host.ackedWatermark
      ? {
          ackedWatermark: (installation, streamKey) => {
            assertInstallationId(allowed, installation.id);
            return host.ackedWatermark!(installation, streamKey);
          },
        }
        : {}),
  } as ConnectorHost;
  return scoped;
}

export function scopeDriverArguments(
  driver: { connector_type: string },
  method: string,
  args: unknown[],
): unknown[] {
  const next = args.slice();
  if (method === "install") {
    const input = asRecord(next[0]);
    if (input && typeof input.id === "string" && isSecrets(input.secrets)) {
      next[0] = {
        ...input,
        secrets: scopeSecrets(input.secrets, new Map([[input.id, driver.connector_type]])),
      };
    }
    return next;
  }
  if (method === "onStoreClear" && Array.isArray(next[0]) && isConnectorHost(next[1])) {
    const owned = next[0].filter(isInstallationScope);
    if (owned.length > 0) {
      next[1] = scopeConnectorInstallations(next[1], owned);
    }
    return next;
  }
  const installation = next.find(isInstallationScope);
  if (!installation) {
    return next;
  }
  const allowed = new Map([[installation.id, installation.connector_type]]);
  for (let index = 0; index < next.length; index += 1) {
    const value = next[index];
    if (isConnectorHost(value)) {
      next[index] = scopeConnectorInstallation(value, installation);
      continue;
    }
    if (isSecrets(value)) {
      next[index] = scopeSecrets(value, allowed);
      continue;
    }
    const record = asRecord(value);
    if (record && isSecrets(record.secrets)) {
      next[index] = {
        ...record,
        secrets: scopeSecrets(record.secrets, allowed),
      };
    }
  }
  return next;
}

function scopeSecrets(
  secrets: ConnectorSecrets,
  allowed: ReadonlyMap<string, string>,
): ConnectorSecrets {
  return {
    read(connectorType, installationId, field) {
      assertInstallation(allowed, installationId, connectorType);
      return secrets.read(connectorType, installationId, field);
    },
    write(ref, secret) {
      assertSecretRef(allowed, ref);
      return secrets.write(ref, secret);
    },
  };
}

function scopeRegistry<T extends object>(
  registry: T,
  allowed: ReadonlyMap<string, string>,
): T {
  return new Proxy(registry, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== "function") {
        return member;
      }
      return (installationId: string, ...args: unknown[]) => {
        assertInstallationId(allowed, installationId);
        return Reflect.apply(member, target, [installationId, ...args]);
      };
    },
  });
}

function narrowPluginToInstallations<C>(
  plugin: Plugin<C>,
  allowed: ReadonlyMap<string, string>,
): Plugin<C> {
  return {
    name: plugin.name,
    inject: plugin.inject,
    apply(ctx, config) {
      const scoped: HostContext = {
        ...ctx,
        get: ((name: string) => {
          const value = ctx.get(name);
          if (name === "connectors" || name === "egress") {
            return scopeRegistry(value as object, allowed);
          }
          return value;
        }) as HostContext["get"],
        plugin(child, input) {
          return ctx.plugin(narrowPluginToInstallations(child, allowed), input);
        },
      };
      return plugin.apply(scoped, config);
    },
  };
}

function assertInstallationId(
  allowed: ReadonlyMap<string, string>,
  installationId: string,
): void {
  if (!allowed.has(installationId.trim())) {
    throw new Error("Connector cannot access another installation");
  }
}

function assertInstallation(
  allowed: ReadonlyMap<string, string>,
  installationId: string,
  connectorType: string,
): void {
  const id = installationId.trim();
  const expected = allowed.get(id);
  if (!expected || (connectorType.trim() && expected !== connectorType.trim())) {
    throw new Error("Connector cannot access another installation");
  }
}

function assertSecretRef(
  allowed: ReadonlyMap<string, string>,
  ref: KeychainSecretRef,
): void {
  for (const [id, type] of allowed) {
    const owned = installSecretRef(type, id, "field");
    const account = ref.account.trim();
    const prefix = `${id}:`;
    if (ref.service.trim() === owned.service && account.startsWith(prefix) && account.length > prefix.length) {
      return;
    }
  }
  throw new Error("Connector cannot access another installation");
}

function isInstallationScope(value: unknown): value is InstallationScope & { org_id: string } {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.id === "string" &&
    record.id.trim() &&
    typeof record.connector_type === "string" &&
    record.connector_type.trim() &&
    typeof record.org_id === "string",
  );
}

function isSecrets(value: unknown): value is ConnectorSecrets {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.read === "function" &&
    typeof record.write === "function" &&
    !("get" in record),
  );
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
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
