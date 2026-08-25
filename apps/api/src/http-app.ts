import { NestFactory, NestApplication } from "@nestjs/core";
import { AppModule } from "./app.module";
import { startPersonalBackgroundWork } from "./personal-background";

/** 8 attachments × 8 MiB × 4/3 base64, plus envelope. */
export const JSON_BODY_LIMIT = "96mb";

export async function createHttpApp(
  options: { logger?: false } = {},
): Promise<NestApplication> {
  const app = await NestFactory.create<NestApplication>(AppModule, {
    logger: options.logger,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  app.useBodyParser("urlencoded", { limit: JSON_BODY_LIMIT, extended: true });
  return app;
}

/** Bind the port first, then start connector/work ticks. */
export async function listenHttpApp(
  app: NestApplication,
  port: number,
  host: string,
): Promise<void> {
  await app.listen(port, host);
  startPersonalBackgroundWork(app);
}
