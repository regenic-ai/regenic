import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { assertCloudWorkerBackend, loadEnv } from "@regenic/config";
import { AppModule } from "./app.module";
import { ConnectivityService } from "./connectivity.service";
import { ContextProjectionService } from "./context-projection.service";
import { DailyDigestService } from "./daily-digest.service";

async function bootstrap() {
  const env = loadEnv();
  assertCloudWorkerBackend(env);
  const app = await NestFactory.createApplicationContext(AppModule);
  app.get(ContextProjectionService).startAfterListen();
  app.get(DailyDigestService).startAfterListen();
  const connectivity = app.get(ConnectivityService);
  try {
    await connectivity.probeAndLog();
  } catch (error) {
    console.warn("worker connectivity probe failed", error);
  }
  console.log("worker running context projection and daily digest");
}

void bootstrap();
