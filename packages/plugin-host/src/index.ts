/**
 * The only package allowed to import `cordis`.
 * Capability plugins depend on this API, never on Cordis types.
 */
import type { Context as CordisContext, Fiber } from "cordis";

export type Disposer = () => void | Promise<void>;

export interface Services {}

export interface Plugin<C = unknown> {
  name: string;
  inject?: readonly string[];
  apply(ctx: HostContext, config: C): void | Promise<void> | Disposer;
}

export interface PluginHandle {
  /** May resolve before apply() if inject is still unmet. Safe to await again. */
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

export interface HostContext {
  provide<K extends keyof Services>(name: K, value: Services[K]): Disposer;
  provide(name: string, value: unknown): Disposer;
  get<K extends keyof Services>(name: K): Services[K];
  get(name: string): unknown;
  /**
   * Mounts a plugin and waits on ready() once. If inject is still unmet,
   * that wait can finish before apply(); await the handle again after
   * providing the missing services.
   */
  plugin<C>(plugin: Plugin<C>, config?: C): Promise<PluginHandle>;
  effect(setup: () => Disposer | void): void;
  on(event: string, handler: (...args: unknown[]) => unknown): Disposer;
  emit(event: string, ...args: unknown[]): void;
}

export interface Host extends HostContext {
  dispose(): Promise<void>;
}

export function definePlugin<C>(plugin: Plugin<C>): Plugin<C> {
  return plugin;
}

export async function createHost(): Promise<Host> {
  const { Context } = await loadCordis();
  const raw = new Context();
  const topLevel: PluginHandle[] = [];
  const ctx = wrapContext(raw, (handle) => {
    topLevel.push(handle);
  });
  return {
    ...ctx,
    async dispose() {
      for (const handle of topLevel.splice(0).reverse()) {
        await handle.dispose();
      }
    },
  };
}

function wrapContext(
  raw: CordisContext,
  track?: (handle: PluginHandle) => void,
): HostContext {
  return {
    provide(name: string, value: unknown): Disposer {
      return asDisposer(raw.provide(name, value));
    },
    get(name: string): unknown {
      const value = raw.get(name, false);
      if (value === undefined) {
        throw new Error(`Service is not available: ${name}`);
      }
      return value;
    },
    async plugin<C>(plugin: Plugin<C>, config?: C) {
      const fiber = (raw.plugin as (plugin: unknown, config?: unknown) => Fiber)(
        toCordisPlugin(plugin),
        config,
      );
      const handle = toHandle(fiber);
      track?.(handle);
      await handle.ready();
      return handle;
    },
    effect(setup) {
      raw.effect(() => {
        const dispose = setup();
        return typeof dispose === "function" ? dispose : () => undefined;
      });
    },
    on(event, handler) {
      return asDisposer(
        (raw.on as (name: string, listener: (...args: unknown[]) => unknown) => unknown)(
          event,
          handler,
        ),
      );
    },
    emit(event, ...args) {
      (raw.emit as (name: string, ...args: unknown[]) => void)(event, ...args);
    },
  };
}

function toCordisPlugin<C>(plugin: Plugin<C>) {
  return {
    name: plugin.name,
    inject: plugin.inject ? [...plugin.inject] : undefined,
    apply(ctx: CordisContext, config: C) {
      return plugin.apply(wrapContext(ctx), config);
    },
  };
}

function toHandle(fiber: Fiber): PluginHandle {
  return {
    async ready() {
      await fiber.await();
    },
    async dispose() {
      await fiber.dispose();
    },
  };
}

function loadCordis(): Promise<typeof import("cordis")> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<typeof import("cordis")>;
  return dynamicImport("cordis");
}

function asDisposer(dispose: unknown): Disposer {
  return () => {
    if (typeof dispose === "function") {
      return dispose();
    }
  };
}
