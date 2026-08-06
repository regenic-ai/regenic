import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ConnectivityService } from "./connectivity.service";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const connectivity = app.get(ConnectivityService);
  await connectivity.probeAndLog();
  // Keep process alive for Compose; no product jobs yet.
  console.log("worker idle (spike — connectivity only)");
}

void bootstrap();
