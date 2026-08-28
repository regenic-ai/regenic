import { NestFactory, NestApplication } from "@nestjs/core";
import { AppModule } from "./app.module";
import { startPersonalBackgroundWork } from "./personal-background";

/** 8 attachments × 8 MiB × 4/3 base64, plus envelope. */
export const JSON_BODY_LIMIT = "96mb";

/**
 * Node's default keepAliveTimeout is 5s. Istio/Envoy pools idle upstream
 * connections longer than that, then reuses a socket Node already closed and
 * returns 503 "upstream connect error ... connection termination".
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;

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
  const server = app.getHttpServer() as {
    keepAliveTimeout: number;
    headersTimeout: number;
  };
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  startPersonalBackgroundWork(app);
}
