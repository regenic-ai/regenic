import type { INestApplication } from "@nestjs/common";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalPluginService } from "./personal-plugin.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalContextProjectionService } from "./personal-context-projection.service";
import { PersonalWorkService } from "./personal-work.service";

/** Listen first. Compact, history catch-up, and work ticks wait their own pace. */
export function startPersonalBackgroundWork(app: INestApplication): void {
  app.get(KernelRuntimeService).startAfterListen();
  app.get(PersonalRuntimeService).startAfterListen();
  app.get(PersonalContextProjectionService).startAfterListen();
  app.get(PersonalInboxService).startAfterListen();
  app.get(PersonalConnectorService).startAfterListen();
  app.get(PersonalPluginService).startAfterListen();
  const executors = app.get(PersonalExecutorService);
  void executors.ensureMounted().catch((error) => {
    console.error("executor mount failed", error);
  });
  app.get(PersonalWorkService).startAfterListen();
}
