import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  isAllowedPersonalCorsOrigin,
  isPersonalApiEnabled,
  loadEnv,
} from "@regenic/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
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
