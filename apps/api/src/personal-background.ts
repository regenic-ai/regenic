import type { INestApplication } from "@nestjs/common";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalWorkService } from "./personal-work.service";

/** First pull and work ticks are Jobs. Start them only after listen(). */
export function startPersonalBackgroundWork(app: INestApplication): void {
  app.get(PersonalConnectorService).startAfterListen();
  app.get(PersonalWorkService).startAfterListen();
}
