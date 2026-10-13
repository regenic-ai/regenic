import { Module } from "@nestjs/common";
import { ConnectivityService } from "./connectivity.service";
import { ContextProjectionService } from "./context-projection.service";
import { DailyDigestService } from "./daily-digest.service";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Module({
  providers: [
    ConnectivityService,
    WorkerRuntimeService,
    ContextProjectionService,
    DailyDigestService,
  ],
})
export class AppModule {}
