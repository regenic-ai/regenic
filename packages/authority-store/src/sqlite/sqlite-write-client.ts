import {
  processSyncMetrics,
  type SyncMetricPoint,
} from "@regenic/domain";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  reviveStoreError,
  type SqliteWriteRequest,
  type SqliteWriteResponse,
} from "./sqlite-write-rpc";

interface PendingCall {
  method: string;
  startedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SqliteWriteClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly recordWait: boolean;

  private constructor(
    private readonly worker: Worker,
    options: { recordWait?: boolean } = {},
  ) {
    this.recordWait = options.recordWait === true;
    this.worker.on("message", (message: SqliteWriteResponse) => {
      if (!message || typeof message.id !== "number") {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      this.recordCallMetrics(pending, message);
      if (message.ok) {
        pending.resolve(message.result);
        return;
      }
      pending.reject(
        message.error
          ? reviveStoreError(message.error)
          : new Error("Authority write worker failed"),
      );
    });
    this.worker.on("error", (error) => {
      this.failAll(error);
    });
    this.worker.on("exit", (code) => {
      if (this.pending.size === 0) {
        return;
      }
      this.failAll(new Error(`Authority write worker exited (${code})`));
    });
  }

  static async open(
    path: string,
    options: { readonly?: boolean } = {},
  ): Promise<SqliteWriteClient> {
    const worker = new Worker(resolveWorkerPath(), {
      workerData: { path, readonly: options.readonly === true },
    });
    await waitForReady(worker);
    return new SqliteWriteClient(worker, {
      recordWait: options.readonly !== true,
    });
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const startedAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        startedAt,
        resolve: (value) => resolve(value as T),
        reject,
      });
      const request: SqliteWriteRequest = { id, method, args };
      this.worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    try {
      await this.call("close");
    } finally {
      this.failAll(new Error("Authority write worker closed"));
      await this.worker.terminate();
    }
  }

  private recordCallMetrics(
    pending: PendingCall,
    message: SqliteWriteResponse,
  ): void {
    if (
      this.recordWait &&
      pending.method !== "close" &&
      pending.method !== "__sleep"
    ) {
      const total = Math.max(0, Date.now() - pending.startedAt);
      const exec = Number.isFinite(message.exec_ms)
        ? Math.max(0, Math.min(message.exec_ms ?? 0, total))
        : 0;
      processSyncMetrics.record({
        name: "writer_wait_ms",
        value: total - exec,
        labels: { operation: pending.method },
      });
    }
    for (const point of message.metrics ?? []) {
      if (!isSyncMetricPoint(point)) {
        continue;
      }
      processSyncMetrics.record(point);
    }
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) {
      call.reject(error);
    }
  }
}

function isSyncMetricPoint(value: SyncMetricPoint): boolean {
  return (
    !!value &&
    typeof value.name === "string" &&
    Number.isFinite(value.value)
  );
}

function resolveWorkerPath(): string {
  const here = join(__dirname, "sqlite-write-worker.js");
  if (existsSync(here)) {
    return here;
  }
  const built = join(
    __dirname,
    "..",
    "..",
    "dist",
    "sqlite",
    "sqlite-write-worker.js",
  );
  if (existsSync(built)) {
    return built;
  }
  throw new Error("Authority write worker is not built");
}

function waitForReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { type?: string }) => {
      if (message?.type !== "ready") {
        return;
      }
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Authority write worker exited before ready (${code})`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}
