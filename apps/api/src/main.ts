import "reflect-metadata";
import { loadEnv } from "@regenic/config";
import { createHttpApp, enablePersonalCors, listenHttpApp } from "./http-app";

async function bootstrap() {
  const env = loadEnv();
  const app = await createHttpApp();
  enablePersonalCors(app, env);
  app.enableShutdownHooks();
  await listenHttpApp(app, env.PORT, env.LISTEN_HOST);
  console.log(`api listening on ${env.LISTEN_HOST}:${env.PORT}`);
}

void bootstrap();
