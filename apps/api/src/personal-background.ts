import type { INestApplication } from "@nestjs/common";
import {
  requiresBackgroundLeader,
  resolveAuthorityBackend,
  shouldRunInProcessContextJobs,
  shouldStartBackgroundWork,
} from "@regenic/config";
import {
  BACKGROUND_LEADER_RETRY_MS,
  createPostgresAdvisoryLease,
  watchBackgroundLeader,
  type BackgroundLeaderController,
  type BackgroundLeaderLease,
} from "./background-leader";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalPluginService } from "./personal-plugin.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalContextProjectionService } from "./personal-context-projection.service";
import { PersonalDailyDigestService } from "./personal-daily-digest.service";
import { PersonalStoreMaintenanceService } from "./personal-store-maintenance.service";
import { PersonalWorkService } from "./personal-work.service";
import { markBackgroundListen } from "./personal-interactive-gate";

export interface StartPersonalBackgroundOptions {
  lease?: BackgroundLeaderLease;
  /** Zero skips the poll interval so tests can drive ticks. */
  leaderRetryMs?: number;
}

/** Listen first. Compact, history catch-up, and work ticks wait their own pace. */
export function startPersonalBackgroundWork(
  app: INestApplication,
  options: StartPersonalBackgroundOptions = {},
): BackgroundLeaderController {
  markBackgroundListen();
  app.get(KernelRuntimeService).startAfterListen();
  app.get(PersonalRuntimeService).startAfterListen();
  if (!shouldStartBackgroundWork()) {
    return idleLeader();
  }
  if (!requiresBackgroundLeader()) {
    startBackgroundTimers(app);
    return idleLeader();
  }
  const backend = resolveAuthorityBackend();
  const lease =
    options.lease ??
    createPostgresAdvisoryLease(
      backend.driver === "postgres" ? backend.url : "",
    );
  return watchBackgroundLeader({
    lease,
    retryMs: options.leaderRetryMs ?? BACKGROUND_LEADER_RETRY_MS,
    start: () => startBackgroundTimers(app),
    stop: () => stopBackgroundTimers(app),
  });
}

function idleLeader(): BackgroundLeaderController {
  return {
    async tick() {},
    async stop() {},
  };
}

function startBackgroundTimers(app: INestApplication): void {
  app.get(PersonalStoreMaintenanceService).startAfterListen();
  if (shouldRunInProcessContextJobs()) {
    app.get(PersonalContextProjectionService).startAfterListen();
    app.get(PersonalDailyDigestService).startAfterListen();
  }
  app.get(PersonalInboxService).startAfterListen();
  app.get(PersonalConnectorService).startAfterListen();
  app.get(PersonalPluginService).startAfterListen();
  const executors = app.get(PersonalExecutorService);
  void executors.ensureMounted().catch((error) => {
    console.error("executor mount failed", error);
  });
  app.get(PersonalWorkService).startAfterListen();
}

function stopBackgroundTimers(app: INestApplication): void {
  stopOne(app, PersonalStoreMaintenanceService);
  stopOne(app, PersonalContextProjectionService);
  stopOne(app, PersonalDailyDigestService);
  stopOne(app, PersonalConnectorService);
  stopOne(app, PersonalPluginService);
  stopOne(app, PersonalWorkService);
}

function stopOne(app: INestApplication, token: object): void {
  const service = app.get(token as never) as { stopBackground?: () => void };
  service.stopBackground?.();
}
