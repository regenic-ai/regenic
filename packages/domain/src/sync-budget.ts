import { AsyncLocalStorage } from "node:async_hooks";
import type { SyncLane } from "./sync-contracts";
import { SYNC_LANES } from "./sync-contracts";

const laneContext = new AsyncLocalStorage<SyncLane>();

export function runInSyncLane<T>(lane: SyncLane, work: () => T): T {
  return laneContext.run(lane, work);
}

export function currentSyncLane(): SyncLane {
  return laneContext.getStore() ?? "live";
}

/** Yield the Node event loop so interactive HTTP handlers can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export interface SyncSlotPoolOptions {
  total: number;
  reserved?: Partial<Record<SyncLane, number>>;
}

/**
 * Process-wide concurrency gate with reserved slots per lane.
 * Interactive can take a reserved slot that backfill / media cannot.
 */
export class SyncSlotPool {
  private active = 0;
  private readonly byLane = new Map<SyncLane, number>();
  private readonly waiters: Array<{
    lane: SyncLane;
    resolve: () => void;
  }> = [];

  constructor(private readonly options: SyncSlotPoolOptions) {
    if (!Number.isInteger(options.total) || options.total < 1) {
      throw new Error("SyncSlotPool total must be a positive integer");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  tryAcquire(lane: SyncLane): boolean {
    if (!this.canAcquire(lane)) {
      return false;
    }
    this.active += 1;
    this.byLane.set(lane, (this.byLane.get(lane) ?? 0) + 1);
    return true;
  }

  async acquire(lane: SyncLane): Promise<void> {
    if (this.tryAcquire(lane)) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ lane, resolve });
    });
  }

  release(lane: SyncLane): void {
    this.active = Math.max(0, this.active - 1);
    const count = this.byLane.get(lane) ?? 0;
    if (count <= 1) {
      this.byLane.delete(lane);
    } else {
      this.byLane.set(lane, count - 1);
    }
    this.flushWaiters();
  }

  async withSlot<T>(lane: SyncLane, work: () => Promise<T>): Promise<T> {
    await this.acquire(lane);
    try {
      return await work();
    } finally {
      this.release(lane);
    }
  }

  reset(): void {
    this.active = 0;
    this.byLane.clear();
    this.waiters.length = 0;
  }

  private reservedFor(lane: SyncLane): number {
    return Math.max(0, this.options.reserved?.[lane] ?? 0);
  }

  private canAcquire(lane: SyncLane): boolean {
    if (this.active >= this.options.total) {
      return false;
    }
    // Keep each lane's unused reservation free. A reserved lane must not
    // spend interactive or live slots just because it has a reservation.
    let protectedOthers = 0;
    for (const other of SYNC_LANES) {
      if (other === lane) {
        continue;
      }
      const reserved = this.reservedFor(other);
      const used = this.byLane.get(other) ?? 0;
      protectedOthers += Math.max(0, reserved - used);
    }
    return this.active + protectedOthers < this.options.total;
  }

  private flushWaiters(): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index];
      if (!waiter || !this.canAcquire(waiter.lane)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      this.tryAcquire(waiter.lane);
      waiter.resolve();
    }
  }
}
