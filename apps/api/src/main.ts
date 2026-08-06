import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnv } from "@regenic/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.PORT);
  console.log(`api listening on :${env.PORT}`);
}

void bootstrap();
