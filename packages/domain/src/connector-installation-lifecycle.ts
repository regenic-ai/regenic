import type { HostContext, Plugin } from "@regenic/plugin-host";
import { setMaxListeners } from "node:events";
import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorPollOptions,
  type ConnectorStopReason,
} from "@regenic/connector-contract";
import { withDeadline } from "./deadline";

interface Activation {
  blocked: boolean;
  active: Set<Promise<unknown>>;
  starting?: Promise<void>;
  ready: boolean;
  stopping?: Promise<void>;
  pendingStop?: Promise<void>;
  stopped: boolean;
  abort: AbortController;
  disposers: Set<() => void>;
  resources: WeakMap<object, object>;
}

const RUNTIME_PORTS = new Set([
  "resolveStreams", "resolveThreadStream", "bindSyncSource", "bindEgress",
  "createThread", "bindWebhook", "listEgressQueue", "ackEgressQueue",
  "resolveConversationLabels", "listPrompts", "answerPrompt", "readAttention",
  "ackAttention", "readReceipts", "readPairingCode", "authorizeLiveAccess",
  "waitThread",
]);
const RESOURCE_PORTS = new Set([
  "poll", "listDirectory", "send", "verifyWebhook", "handleWebhook",
]);

/** Admission and draining are opt-in: legacy drivers keep their exact behavior. */
export class ConnectorInstallationLifecycle {
  private readonly activations = new Map<string, Activation>();
  private readonly revisions = new Map<string, string>();
  private closed = false;
  private changes: Promise<unknown> = Promise.resolve();

  change<T>(work: () => Promise<T>): Promise<T> {
    const result = this.changes.then(work);
    this.changes = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
    for (const activation of this.activations.values()) activation.abort.abort();
  }

  resume(id: string, updatedAt?: string): void {
    this.assertRestartable(id);
    if (updatedAt) this.revisions.set(id, updatedAt);
    if (!this.activations.get(id)?.blocked) return;
    this.activations.delete(id);
  }

  assertRestartable(id: string): void {
    const activation = this.activations.get(id);
    if (this.closed || (activation?.blocked && (
      !activation.stopped || activation.stopping || activation.pendingStop || activation.active.size
    ))) {
      throw new ChannelDriverError("sync_failed", "Connector teardown has not completed; retry stopping first", "lifecycle_failed");
    }
  }

  guard(driver: ChannelDriver): ChannelDriver {
    if (!driver.stopInstallation) return driver;
    return new Proxy(driver, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        if (typeof key !== "string" || !RUNTIME_PORTS.has(key) || typeof method !== "function") {
          return typeof method === "function" ? method.bind(target) : method;
        }
        return (installation: ConnectorInstallation, ...args: unknown[]) => {
          const activation = this.activation(installation.id);
          this.assertOpen(activation, installation);
          const invoke = () => {
            const scopedArgs = args.map((arg) => this.isHost(arg)
              ? this.scopeHost(arg, activation, installation)
              : arg);
            return Reflect.apply(method, target, [installation, ...scopedArgs]);
          };
          // These existing ports are synchronous and must stay synchronous.
          if (key === "waitThread" || key === "listEgressQueue" || key === "ackEgressQueue") {
            if (key === "waitThread" && driver.startInstallation && !activation.ready) return undefined;
            const result = invoke();
            if (key === "waitThread" && typeof result === "function") {
              return this.disposer(activation, () => { result(); });
            }
            return result;
          }
          return this.run(activation, installation, async () => {
            if (!activation.starting) {
              const host = args.find((arg): arg is ConnectorHost => this.isHost(arg));
              await this.start(driver, installation, activation, host);
            } else {
              await activation.starting;
            }
            this.assertOpen(activation, installation);
            return this.resource(await invoke(), activation, installation);
          });
        };
      },
    });
  }

  private host: ConnectorHost | (() => ConnectorHost) | undefined;

  setHost(host: ConnectorHost | (() => ConnectorHost)): void {
    this.host = host;
  }

  runInstallation<T>(installation: ConnectorInstallation, work: () => Promise<T>): Promise<T> {
    return this.run(this.activation(installation.id), installation, work);
  }

  async stop(
    driver: ChannelDriver | undefined,
    installation: ConnectorInstallation,
    host: ConnectorHost,
    reason: ConnectorStopReason,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (!driver?.stopInstallation) return;
    const activation = this.activation(installation.id);
    activation.blocked = true;
    activation.abort.abort();
    if (activation.stopped) return;
    if (activation.stopping) return activation.stopping;
    const abort = new AbortController();
    const started = Date.now();
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const work = (async () => {
      if (activation.pendingStop) {
        await withDeadline(activation.pendingStop, remaining() / 2, "previous connector stop");
      }
      // On drain timeout still attempt teardown, so an owned child can be killed.
      let drainError: unknown;
      try {
        await withDeadline(Promise.allSettled([...activation.active]), remaining() / 2, "connector drain");
      } catch (error) {
        drainError = error;
      }
      const hook = Promise.resolve().then(() => driver.stopInstallation!(installation, host, { reason, signal: abort.signal }));
      activation.pendingStop = hook;
      const finished = () => {
        if (activation.pendingStop === hook) activation.pendingStop = undefined;
      };
      void hook.then(finished, finished);
      await withDeadline(
        hook,
        remaining(),
        "connector stop",
      );
      if (drainError) throw drainError;
      for (const dispose of activation.disposers) dispose();
      activation.stopped = true;
    })();
    activation.stopping = work;
    try {
      await work;
    } finally {
      abort.abort();
      clearTimeout(timer);
      activation.stopping = undefined;
    }
  }

  private activation(id: string): Activation {
    let activation = this.activations.get(id);
    if (!activation) {
      const abort = new AbortController();
      setMaxListeners(0, abort.signal);
      activation = {
        blocked: false, stopped: false, ready: false, active: new Set(),
        abort, disposers: new Set(),
        resources: new WeakMap(),
      };
      this.activations.set(id, activation);
    }
    return activation;
  }

  private assertOpen(activation: Activation, installation: ConnectorInstallation): void {
    const revision = this.revisions.get(installation.id);
    if (this.closed || activation.blocked || installation.status !== "enabled" ||
      (revision && revision !== installation.updated_at)) {
      throw new ChannelDriverError("sync_failed", "Connector installation is stopped", "disabled");
    }
  }

  private start(
    driver: ChannelDriver,
    installation: ConnectorInstallation,
    activation: Activation,
    host?: ConnectorHost,
  ): Promise<void> {
    if (!driver.startInstallation) {
      activation.ready = true;
      activation.starting = Promise.resolve();
      return activation.starting;
    }
    host ??= typeof this.host === "function" ? this.host() : this.host;
    if (!host) {
      throw new ChannelDriverError("sync_failed", "Connector lifecycle host is unavailable", "lifecycle_failed");
    }
    const scopedHost = this.scopeHost(host, activation, installation);
    activation.starting = Promise.resolve()
      .then(() => {
        this.assertOpen(activation, installation);
        return driver.startInstallation?.(installation, scopedHost);
      })
      .then(() => { activation.ready = true; })
      .catch((error: unknown) => {
        if (error instanceof ChannelDriverError) throw error;
        throw new ChannelDriverError("sync_failed",
          error instanceof Error ? error.message : "Connector start failed",
          "lifecycle_failed");
      });
    return activation.starting;
  }

  private run<T>(activation: Activation, installation: ConnectorInstallation, work: () => T | Promise<T>): Promise<T> {
    this.assertOpen(activation, installation);
    const pending = Promise.resolve().then(() => {
      this.assertOpen(activation, installation);
      return work();
    });
    activation.active.add(pending);
    void pending.then(
      () => activation.active.delete(pending),
      () => activation.active.delete(pending),
    );
    return pending;
  }

  private resource<T>(value: T, activation: Activation, installation: ConnectorInstallation): T {
    if (Array.isArray(value)) {
      const items = value.map((item) => this.resource(item, activation, installation));
      return items.every((item, index) => item === value[index]) ? value : items as T;
    }
    if (!value || typeof value !== "object") return value;
    const cached = activation.resources.get(value);
    if (cached) return cached as T;
    if (!("connector" in value) && ![...RESOURCE_PORTS].some((key) =>
      typeof Reflect.get(value, key) === "function")) return value;
    const guarded = new Proxy(value, {
      get: (target, key) => {
        const member = Reflect.get(target, key);
        if (key === "connector") return this.resource(member, activation, installation);
        if (typeof member !== "function") return member;
        if (typeof key === "string" && RESOURCE_PORTS.has(key)) {
          return (...args: unknown[]) => this.run(activation, installation, async () => {
            if (key === "poll") {
              const [cursor, options] = args as [unknown, ConnectorPollOptions | undefined];
              const abort = new AbortController();
              const signals = options?.signal
                ? [options.signal, activation.abort.signal]
                : [activation.abort.signal];
              const cancel = () => abort.abort();
              for (const signal of signals) {
                if (signal.aborted) cancel();
                else signal.addEventListener("abort", cancel, { once: true });
              }
              try {
                return await Reflect.apply(member, target, [cursor, { ...options, signal: abort.signal }]);
              } finally {
                for (const signal of signals) signal.removeEventListener("abort", cancel);
              }
            }
            return Reflect.apply(member, target, args);
          });
        }
        return member.bind(target);
      },
    });
    activation.resources.set(value, guarded);
    activation.resources.set(guarded, guarded);
    return guarded;
  }

  private isHost(value: unknown): value is ConnectorHost {
    return Boolean(value && typeof value === "object" && "get" in value && "plugin" in value && "secrets" in value);
  }

  private disposer(activation: Activation, release: () => void): () => void {
    const dispose = () => {
      if (!activation.disposers.has(dispose)) return;
      release();
      activation.disposers.delete(dispose);
    };
    activation.disposers.add(dispose);
    return dispose;
  }

  private scopeHost(host: ConnectorHost, activation: Activation, installation: ConnectorInstallation): ConnectorHost {
    const scopeRegistry = (registry: object) => new Proxy(registry, {
      get: (target, key) => {
        const member = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        if (key === "register") {
          return (id: string, value: unknown, ...args: unknown[]) => {
            this.assertOpen(activation, installation);
            if (id !== installation.id) throw new Error("Cannot register a resource for another installation");
            const release: () => void = Reflect.apply(member, target, [id, this.resource(value, activation, installation), ...args]);
            return this.disposer(activation, release);
          };
        }
        return (...args: unknown[]) => {
          if (this.activations.get(installation.id) !== activation) {
            throw new ChannelDriverError("sync_failed", "Connector activation is stale", "disabled");
          }
          return Reflect.apply(member, target, args);
        };
      },
    });
    const scopePlugin = <C>(plugin: Plugin<C>): Plugin<C> => ({
      ...plugin,
      apply: (ctx, config) => {
        const scoped: HostContext = {
          ...ctx,
          get: ((name: string) => {
            const value = ctx.get(name);
            return name === "connectors" || name === "egress" ? scopeRegistry(value as object) : value;
          }) as HostContext["get"],
          plugin: (child, input) => ctx.plugin(scopePlugin(child), input),
        };
        this.assertOpen(activation, installation);
        return plugin.apply(scoped, config);
      },
    });
    return {
      ...host,
      get: ((name: "connectors" | "egress") => scopeRegistry(
        name === "connectors" ? host.get("connectors") : host.get("egress"),
      )) as ConnectorHost["get"],
      plugin: (plugin, config) => {
        this.assertOpen(activation, installation);
        return host.plugin(scopePlugin(plugin), config);
      },
    };
  }
}
