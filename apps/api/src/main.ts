import "reflect-metadata";
import {
  isAllowedPersonalCorsOrigin,
  isPersonalApiEnabled,
  loadEnv,
} from "@regenic/config";
import { createHttpApp } from "./http-app";

async function bootstrap() {
  const env = loadEnv();
  const app = await createHttpApp();
  if (isPersonalApiEnabled(env)) {
    app.enableCors({
      origin: (requestOrigin, callback) => {
        callback(
          null,
          !requestOrigin || isAllowedPersonalCorsOrigin(requestOrigin),
        );
      },
    });
  }
  app.enableShutdownHooks();
  await app.listen(env.PORT, env.LISTEN_HOST);
  console.log(`api listening on ${env.LISTEN_HOST}:${env.PORT}`);
}

void bootstrap();
