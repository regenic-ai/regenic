import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  reviveStoreError,
  type SqliteWriteRequest,
  type SqliteWriteResponse,
} from "./sqlite-write-rpc";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SqliteWriteClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(private readonly worker: Worker) {
    this.worker.on("message", (message: SqliteWriteResponse) => {
      if (!message || typeof message.id !== "number") {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
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

  static async open(path: string): Promise<SqliteWriteClient> {
    const worker = new Worker(resolveWorkerPath(), {
      workerData: { path },
    });
    await waitForReady(worker);
    return new SqliteWriteClient(worker);
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
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

  private failAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) {
      call.reject(error);
    }
  }
}

function resolveWorkerPath(): string {
  const here = join(__dirname, "sqlite-write-worker.js");
  if (existsSync(here)) {
    return here;
  }
  const built = join(__dirname, "..", "dist", "sqlite-write-worker.js");
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
