import { Module } from "@nestjs/common";
import { DshApiController } from "./dsh-api.controller";
import { DshApiService } from "./dsh-api.service";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController, DshApiController],
  providers: [DshApiService],
})
export class AppModule {}
