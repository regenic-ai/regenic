import { Module } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
} from "@regenic/domain";
import {
  createChannelDriverRegistry,
  createExecutorPluginRegistry,
} from "./channel-plugins";
import { DshApiController } from "./dsh-api.controller";
import { DshApiService } from "./dsh-api.service";
import { HealthController } from "./health.controller";
import { PersonalApiKeyService } from "./personal-api-key.service";
import { PersonalConnectController } from "./personal-connect.controller";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalApiGuard } from "./personal-api.guard";
import { PersonalPairingService } from "./personal-pairing.service";
import { PersonalContextController } from "./personal-context.controller";
import { PersonalContextService } from "./personal-context.service";
import { PersonalContextProjectionService } from "./personal-context-projection.service";
import { PersonalController } from "./personal.controller";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalForwardService } from "./personal-forward.service";
import { PersonalReplyService } from "./personal-reply.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalPluginService } from "./personal-plugin.service";
import { PersonalWhatsAppImportService } from "./personal-whatsapp-import.service";
import { PersonalEventsService } from "./personal-events.service";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalWorkService } from "./personal-work.service";
import { PersonalStoreMaintenanceService } from "./personal-store-maintenance.service";

@Module({
  controllers: [
    HealthController,
    PersonalConnectController,
    DshApiController,
    PersonalController,
    PersonalContextController,
  ],
  providers: [
    DshApiService,
    PersonalApiKeyService,
    PersonalPairingService,
    KernelRuntimeService,
    PersonalRuntimeService,
    PersonalContextService,
    PersonalContextProjectionService,
    PersonalInboxService,
    PersonalReplyService,
    PersonalForwardService,
    PersonalWorkService,
    PersonalStoreMaintenanceService,
    PersonalExecutorService,
    PersonalConnectorService,
    PersonalEventsService,
    PersonalApiGuard,
    PersonalWhatsAppImportService,
    PersonalPluginService,
    {
      provide: ChannelDriverRegistry,
      useFactory: () => createChannelDriverRegistry(),
    },
    {
      provide: LocalExecutorPluginRegistry,
      useFactory: () => createExecutorPluginRegistry(),
    },
  ],
})
export class AppModule {}
