const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");

let installed = false;

/**
 * Node 26's bundled undici turns an idle HTTP/2 session into an unhandled
 * `error` on a ClientHttp2Stream (`UND_ERR_INFO` / "socket idle timeout"),
 * which exits the process. HTTPS fetch negotiates HTTP/2 unless the global
 * dispatcher was created with `allowH2: false`. Pin that before the first
 * request, and ignore the informational timeout if a session is already open.
 */
export function installUndiciProcessGuard(): void {
  if (installed) return;
  installed = true;
  if (!pinAllowH2(readDispatcher())) hookDispatcherInstall();
  process.on("uncaughtException", onUncaughtException);
}

export function isUndiciSocketIdleTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "UND_ERR_INFO" && value.message === "socket idle timeout";
}

function onUncaughtException(error: unknown): void {
  if (isUndiciSocketIdleTimeout(error)) {
    console.warn("ignored undici http2 idle timeout");
    return;
  }
  console.error(error);
  process.exit(1);
}

function readDispatcher(): unknown {
  return (globalThis as Record<symbol, unknown>)[dispatcherSymbol];
}

function pinAllowH2(agent: unknown): boolean {
  const options = dispatcherOptions(agent);
  if (!options) return false;
  options.allowH2 = false;
  return true;
}

function dispatcherOptions(agent: unknown): { allowH2?: boolean } | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  for (const symbol of Object.getOwnPropertySymbols(agent)) {
    if (symbol.description !== "options") continue;
    const value = (agent as Record<symbol, unknown>)[symbol];
    if (value && typeof value === "object" && "maxOrigins" in (value as object)) {
      return value as { allowH2?: boolean };
    }
  }
  return undefined;
}

function hookDispatcherInstall(): void {
  const original = Object.defineProperty;
  const hooked = function hooked(target: object, property: PropertyKey, descriptor: PropertyDescriptor): object {
    if (target === globalThis && property === dispatcherSymbol && "value" in descriptor) {
      pinAllowH2(descriptor.value);
      try {
        return original.call(Object, target, property, descriptor) as object;
      } finally {
        Object.defineProperty = original;
      }
    }
    return original.call(Object, target, property, descriptor) as object;
  };
  Object.defineProperty = hooked as typeof Object.defineProperty;
}
