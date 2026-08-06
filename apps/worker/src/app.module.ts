import { Module } from "@nestjs/common";
import { ConnectivityService } from "./connectivity.service";

@Module({
  providers: [ConnectivityService],
})
export class AppModule {}
