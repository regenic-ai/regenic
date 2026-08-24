import { parentPort, workerData } from "node:worker_threads";
import { SqliteAuthorityStore } from "./sqlite-authority-store";
import {
  isAuthorityWriteMethod,
  serializeStoreError,
  type SqliteWriteRequest,
  type SqliteWriteResponse,
} from "./sqlite-write-rpc";

if (!parentPort) {
  throw new Error("sqlite write worker must run in a worker thread");
}

const store = new SqliteAuthorityStore(String(workerData.path));
parentPort.postMessage({ type: "ready" });

parentPort.on("message", async (message: SqliteWriteRequest) => {
  const reply = (response: SqliteWriteResponse) => {
    parentPort?.postMessage(response);
  };
  try {
    if (message.method === "close") {
      store.close();
      reply({ id: message.id, ok: true, result: null });
      return;
    }
    if (message.method === "__sleep") {
      const ms = Number(message.args[0] ?? 0);
      await delay(Number.isFinite(ms) ? Math.max(0, ms) : 0);
      reply({ id: message.id, ok: true, result: null });
      return;
    }
    if (!isAuthorityWriteMethod(message.method)) {
      throw new Error(`Unsupported authority write method: ${message.method}`);
    }
    const method = store[message.method] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const result = await method.apply(store, message.args);
    reply({ id: message.id, ok: true, result });
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      error: serializeStoreError(error),
    });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
