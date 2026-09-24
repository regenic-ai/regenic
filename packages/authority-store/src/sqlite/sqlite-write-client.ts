import {
  currentSyncLane,
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
  pages?: QueuedPage[];
}

const PAGE_BATCH_MAX = 8;
const PAGE_BATCH_MS = 20;

interface QueuedPage {
  input: unknown;
  startedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SqliteWriteClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly pageBatch: QueuedPage[] = [];
  private pageTimer: ReturnType<typeof setTimeout> | undefined;
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
      if (pending.pages) {
        this.settlePageBatch(pending, message);
        return;
      }
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
    if (
      method === "commitSyncPage" &&
      currentSyncLane() !== "interactive" &&
      args.length === 1
    ) {
      return new Promise<T>((resolve, reject) => {
        this.pageBatch.push({
          input: args[0],
          startedAt: Date.now(),
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (this.pageBatch.length >= PAGE_BATCH_MAX) {
          this.flushPageBatch();
          return;
        }
        if (!this.pageTimer) {
          this.pageTimer = setTimeout(() => this.flushPageBatch(), PAGE_BATCH_MS);
        }
      });
    }
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
      if (method === "commitSyncPage") {
        this.flushPageBatch();
      }
    });
  }

  private flushPageBatch(): void {
    if (this.pageTimer) {
      clearTimeout(this.pageTimer);
      this.pageTimer = undefined;
    }
    const pages = this.pageBatch.splice(0);
    if (pages.length === 0) {
      return;
    }
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, {
      method: "commitSyncPages",
      startedAt: pages[0]?.startedAt ?? Date.now(),
      resolve: () => undefined,
      reject: () => undefined,
      pages,
    });
    const request: SqliteWriteRequest = {
      id,
      method: pages.length === 1 ? "commitSyncPage" : "commitSyncPages",
      args: pages.length === 1 ? [pages[0]?.input] : [pages.map((page) => page.input)],
    };
    this.worker.postMessage(request);
  }

  private settlePageBatch(pending: PendingCall, message: SqliteWriteResponse): void {
    const pages = pending.pages ?? [];
    if (!message.ok) {
      const error = message.error
        ? reviveStoreError(message.error)
        : new Error("Authority write worker failed");
      for (const page of pages) {
        page.reject(error);
      }
      return;
    }
    if (pages.length === 1) {
      pages[0]?.resolve(message.result);
      return;
    }
    const results = Array.isArray(message.result) ? message.result : [];
    pages.forEach((page, index) => {
      page.resolve(results[index]);
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
      for (const page of call.pages ?? []) {
        page.reject(error);
      }
    }
    const queued = this.pageBatch.splice(0);
    for (const page of queued) {
      page.reject(error);
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
