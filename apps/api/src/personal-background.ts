import type { INestApplication } from "@nestjs/common";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalWorkService } from "./personal-work.service";

/** Listen first. Compact, history catch-up, and work ticks wait their own pace. */
export function startPersonalBackgroundWork(app: INestApplication): void {
  app.get(PersonalRuntimeService).startAfterListen();
  app.get(PersonalConnectorService).startAfterListen();
  app.get(PersonalWorkService).startAfterListen();
}
