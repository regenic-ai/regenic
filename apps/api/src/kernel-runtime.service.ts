import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  SyncProgressSnapshotStore,
  InboxSummarySnapshotStore,
  kernelPressureView,
  type KernelPressureSample,
  type KernelPressureView,
  type SyncProgressSnapshot,
} from "@regenic/domain";
import { processMemoryView } from "./process-memory";
import { pullStatus } from "./personal-pull-status";

const LAG_SAMPLE_MS = 1_000;

@Injectable()
export class KernelRuntimeService implements OnModuleDestroy {
  readonly syncSnapshots = new SyncProgressSnapshotStore();
  readonly inboxSummary = new InboxSummarySnapshotStore();
  private lagTimer: ReturnType<typeof setInterval> | undefined;
  private lastLagAt = 0;
  private eventLoopLagMs = 0;
  private interactiveWaiters = 0;

  startAfterListen(): void {
    if (this.lagTimer) {
      return;
    }
    let expected = Date.now() + LAG_SAMPLE_MS;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.eventLoopLagMs = Math.max(0, now - expected - LAG_SAMPLE_MS);
      expected = now + LAG_SAMPLE_MS;
      this.lastLagAt = now;
    }, LAG_SAMPLE_MS);
  }

  onModuleDestroy(): void {
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = undefined;
    }
  }

  noteInteractiveWaiter(delta: 1 | -1): void {
    this.interactiveWaiters = Math.max(0, this.interactiveWaiters + delta);
  }

  publishSyncSnapshot(snapshot: SyncProgressSnapshot): SyncProgressSnapshot {
    return this.syncSnapshots.publish(snapshot);
  }

  pressureSample(): KernelPressureSample {
    const memory = processMemoryView();
    return {
      rss_bytes: memory.rss_bytes,
      heap_used_bytes: memory.heap_used_bytes,
      event_loop_lag_ms: this.eventLoopLagMs,
      sync_active: pullStatus.phase === "pulling",
      interactive_waiters: this.interactiveWaiters,
    };
  }

  pressureView(): KernelPressureView {
    return kernelPressureView(this.pressureSample());
  }
}
