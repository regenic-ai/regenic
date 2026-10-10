import { processSyncMetrics, syncMetricDeltas } from "@regenic/domain";
import { parentPort, workerData } from "node:worker_threads";
import { SqliteAuthorityStore } from "./sqlite-authority-store";
import {
  isAuthorityReadMethod,
  isAuthorityWriteMethod,
  serializeStoreError,
  type SqliteWriteRequest,
  type SqliteWriteResponse,
} from "./sqlite-write-rpc";

if (!parentPort) {
  throw new Error("sqlite write worker must run in a worker thread");
}

const readonly = workerData?.readonly === true;
let store: SqliteAuthorityStore | undefined;
try {
  store = new SqliteAuthorityStore(String(workerData.path), {
    readonly,
  });
} catch (error) {
  const failure = describeOpenFailure(error);
  console.error(failure.message);
  parentPort.postMessage({ type: "fatal", ...failure });
  // Let the fatal message flush before the thread exits. Do not rethrow:
  // a native SQLite error loses its message when it crosses the thread.
  setImmediate(() => {
    process.exit(1);
  });
}
if (store) {
  startWorker(store);
}

function startWorker(openStore: SqliteAuthorityStore): void {
  parentPort!.postMessage({ type: "ready" });
  let chain: Promise<void> = Promise.resolve();
  parentPort!.on("message", (message: SqliteWriteRequest) => {
    chain = chain.then(() => handleWrite(openStore, message)).catch(() => undefined);
  });
}

async function handleWrite(
  openStore: SqliteAuthorityStore,
  message: SqliteWriteRequest,
): Promise<void> {
  const before = processSyncMetrics.snapshot();
  const execStarted = Date.now();
  const reply = (response: SqliteWriteResponse) => {
    parentPort?.postMessage({
      ...response,
      exec_ms: Math.max(0, Date.now() - execStarted),
      metrics: syncMetricDeltas(before, processSyncMetrics.snapshot()),
    });
  };
  try {
    if (message.method === "close") {
      openStore.close();
      reply({ id: message.id, ok: true, result: null });
      return;
    }
    if (message.method === "__sleep") {
      const ms = Number(message.args[0] ?? 0);
      await delay(Number.isFinite(ms) ? Math.max(0, ms) : 0);
      reply({ id: message.id, ok: true, result: null });
      return;
    }
    const allowed = readonly
      ? isAuthorityReadMethod(message.method)
      : isAuthorityWriteMethod(message.method);
    if (!allowed) {
      throw new Error(`Unsupported authority method: ${message.method}`);
    }
    const method = openStore[message.method as keyof SqliteAuthorityStore] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const result = await method.apply(openStore, message.args);
    reply({ id: message.id, ok: true, result });
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      error: serializeStoreError(error),
    });
  }
}

function describeOpenFailure(error: unknown): { message: string; code?: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : code
        ? `Authority database failed to open (${code})`
        : "Authority database failed to open";
  return code ? { message, code } : { message };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
