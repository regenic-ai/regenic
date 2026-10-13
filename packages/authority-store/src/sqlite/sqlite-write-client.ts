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
    // One transaction per page. A preempted lease must not roll back the
    // other chats that landed in the same 20ms batch.
    for (const page of pages) {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, {
        method: "commitSyncPage",
        startedAt: page.startedAt,
        resolve: page.resolve,
        reject: page.reject,
      });
      const request: SqliteWriteRequest = {
        id,
        method: "commitSyncPage",
        args: [page.input],
      };
      this.worker.postMessage(request);
    }
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
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      settle();
    };
    const onMessage = (message: { type?: string; message?: string; code?: string }) => {
      if (message?.type === "ready") {
        finish(() => resolve());
        return;
      }
      if (message?.type === "fatal") {
        finish(() => {
          worker.terminate();
          reject(fatalWorkerError(message));
        });
      }
    };
    const onError = (error: unknown) => {
      finish(() => reject(describeWorkerError(error)));
    };
    const onExit = (code: number) => {
      finish(() => reject(new Error(`Authority write worker exited before ready (${code})`)));
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

function fatalWorkerError(message: { message?: string; code?: string }): Error {
  const text =
    message.message?.trim() ||
    (message.code
      ? `Authority database failed to open (${message.code})`
      : "Authority database failed to open");
  const error = new Error(text);
  if (message.code) {
    (error as Error & { code?: string }).code = message.code;
  }
  return error;
}

function describeWorkerError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.trim().length > 0 &&
    !error.message.includes("[object Object]")
  ) {
    return error;
  }
  const record =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : undefined;
  const code = typeof record?.code === "string" ? record.code : undefined;
  const message =
    typeof record?.message === "string" && record.message.trim().length > 0
      ? record.message
      : code
        ? `Authority write worker failed (${code})`
        : "Authority write worker failed";
  const wrapped = new Error(message);
  if (code) {
    (wrapped as Error & { code?: string }).code = code;
  }
  return wrapped;
}
