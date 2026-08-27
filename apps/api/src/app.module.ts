import { Module } from "@nestjs/common";
import { ChannelDriverRegistry } from "@regenic/domain";
import { dshSessionDriver } from "@regenic/dsh-connector";
import { feishuChatDriver } from "@regenic/feishu-connector";
import { slackChannelDriver } from "@regenic/slack-connector";
import { DshApiController } from "./dsh-api.controller";
import { DshApiService } from "./dsh-api.service";
import { HealthController } from "./health.controller";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalController } from "./personal.controller";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalReplyService } from "./personal-reply.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
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
    PersonalWorkService,
    PersonalExecutorService,
    PersonalConnectorService,
    PersonalWhatsAppImportService,
    {
      provide: ChannelDriverRegistry,
      useFactory: () =>
        new ChannelDriverRegistry()
          .register(dshSessionDriver)
          .register(slackChannelDriver)
          .register(feishuChatDriver),
    },
  ],
})
export class AppModule {}
