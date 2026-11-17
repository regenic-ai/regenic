// Node 22 and 24 publish the fetch dispatcher on v1. Node 26 publishes the
// live agent on v2, then a legacy wrapper on v1. v2 is listed first so a
// runtime that has both pins the agent fetch actually uses.
const dispatcherSymbols: symbol[] = [
  Symbol.for("undici.globalDispatcher.2"),
  Symbol.for("undici.globalDispatcher.1"),
];

let installed = false;

/**
 * Undici 8 (Node 26) turns an idle HTTP/2 session into an unhandled `error`
 * on a ClientHttp2Stream (`UND_ERR_INFO` / "socket idle timeout"), which
 * exits the process. That reaper is not in the undici bundled with Node 22
 * or 24. On undici 8, pin `allowH2: false` before the first request and
 * restore `Object.defineProperty` once the dispatcher is installed. On every
 * runtime, ignore the informational timeout if a session is already open.
 */
export function installUndiciProcessGuard(): void {
  if (installed) return;
  installed = true;
  if (bundledUndiciHasHttp2IdleReaper()) {
    const existing = readDispatcher();
    if (existing) pinAllowH2(existing);
    else hookDispatcherInstall();
  }
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

function bundledUndiciHasHttp2IdleReaper(): boolean {
  const major = Number(process.versions.undici?.split(".")[0] ?? "0");
  return Number.isInteger(major) && major >= 8;
}

function readDispatcher(): unknown {
  const globals = globalThis as Record<symbol, unknown>;
  for (const symbol of dispatcherSymbols) {
    if (globals[symbol]) return globals[symbol];
  }
  return undefined;
}

function isDispatcherSymbol(property: PropertyKey): boolean {
  return typeof property === "symbol" && dispatcherSymbols.includes(property);
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
  let restored = false;
  const hooked = function hooked(target: object, property: PropertyKey, descriptor: PropertyDescriptor): object {
    const dispatcher = target === globalThis && isDispatcherSymbol(property) && "value" in descriptor;
    if (dispatcher) pinAllowH2(descriptor.value);
    try {
      return original.call(Object, target, property, descriptor) as object;
    } finally {
      if (dispatcher && !restored) {
        restored = true;
        Object.defineProperty = original;
      }
    }
  };
  Object.defineProperty = hooked as typeof Object.defineProperty;
}
