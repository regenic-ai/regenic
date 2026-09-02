import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { KernelRuntimeService } from "./kernel-runtime.service";
import { PersonalConnectorService } from "./personal-connector.service";
import { HUMAN_IDLE_MS, isHumanIdle } from "./personal-human-pace";
import { STORE_BUSY_MESSAGE } from "./personal-errors";
import { pullStatus } from "./personal-pull-status";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalWorkService } from "./personal-work.service";

@Injectable()
export class PersonalStoreMaintenanceService implements OnModuleDestroy {
  private maintainTimer: ReturnType<typeof setTimeout> | undefined;
  private maintainFinished = false;

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly kernelRuntime: KernelRuntimeService,
    private readonly connectors: PersonalConnectorService,
    private readonly work: PersonalWorkService,
  ) {}

  startAfterListen(): void {
    this.scheduleStoreMaintenance();
  }

  onModuleDestroy(): void {
    this.maintainFinished = true;
    if (this.maintainTimer) {
      clearTimeout(this.maintainTimer);
      this.maintainTimer = undefined;
    }
  }

  private scheduleStoreMaintenance(): void {
    if (this.maintainFinished || this.maintainTimer || !this.runtime.isReady()) {
      return;
    }
    this.maintainTimer = setTimeout(() => {
      this.maintainTimer = undefined;
      void this.maybeMaintainStore();
    }, HUMAN_IDLE_MS);
  }

  private async maybeMaintainStore(): Promise<void> {
    if (this.maintainFinished || !this.runtime.isReady()) {
      return;
    }
    if (
      !isHumanIdle() ||
      this.kernelRuntime.shouldDeferBackgroundSync() ||
      pullStatus.phase === "pulling"
    ) {
      this.scheduleStoreMaintenance();
      return;
    }
    const authority = this.runtime.requireHost().get("authority") as {
      maintainStore?: () => Promise<{ deleted: number }>;
    };
    if (typeof authority.maintainStore !== "function") {
      this.maintainFinished = true;
      return;
    }
    const databasePath = this.runtime.getOptions()?.database;
    try {
      await this.work.pauseForMaintenance();
      try {
        await this.connectors.pauseForMaintenance();
        try {
          await authority.maintainStore();
        } finally {
          this.connectors.resumeAfterMaintenance();
        }
      } finally {
        this.work.resumeAfterMaintenance();
      }
    } catch (error) {
      if (isStoreMaintenanceBusy(error)) {
        this.scheduleStoreMaintenance();
        return;
      }
      const target = databasePath ? ` (${databasePath})` : "";
      console.warn(`authority store maintenance failed${target}`, error);
    }
    this.scheduleStoreMaintenance();
  }
}

function isStoreMaintenanceBusy(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_BUSY_MESSAGE;
}
