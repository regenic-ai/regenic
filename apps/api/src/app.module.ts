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
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalController } from "./personal.controller";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalForwardService } from "./personal-forward.service";
import { PersonalReplyService } from "./personal-reply.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalPluginService } from "./personal-plugin.service";
import { PersonalWhatsAppImportService } from "./personal-whatsapp-import.service";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalWorkService } from "./personal-work.service";

@Module({
  controllers: [HealthController, DshApiController, PersonalController],
  providers: [
    DshApiService,
    PersonalRuntimeService,
    PersonalInboxService,
    PersonalReplyService,
    PersonalForwardService,
    PersonalWorkService,
    PersonalExecutorService,
    PersonalConnectorService,
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
