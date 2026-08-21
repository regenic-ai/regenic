import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnv } from "@regenic/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.PORT, env.LISTEN_HOST);
  console.log(`api listening on ${env.LISTEN_HOST}:${env.PORT}`);
}

void bootstrap();
