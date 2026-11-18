import { Module } from "@nestjs/common";
import { ConnectivityService } from "./connectivity.service";
import { ContextProjectionService } from "./context-projection.service";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Module({
  providers: [
    ConnectivityService,
    WorkerRuntimeService,
    ContextProjectionService,
  ],
})
export class AppModule {}
