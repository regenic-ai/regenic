import { Module } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
} from "@regenic/domain";
import { dshSessionDriver, dshTaskExecutor } from "@regenic/dsh-connector";
import { feishuChatDriver } from "@regenic/feishu-connector";
import { slackChannelDriver } from "@regenic/slack-connector";
import { optionalCrmDrivers } from "./optional-crm-drivers";
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
      useFactory: () => {
        const registry = new ChannelDriverRegistry()
          .register(dshSessionDriver)
          .register(slackChannelDriver)
          .register(feishuChatDriver);
        for (const driver of optionalCrmDrivers()) {
          registry.register(driver);
        }
        return registry;
      },
    },
    {
      provide: LocalExecutorPluginRegistry,
      useFactory: () =>
        new LocalExecutorPluginRegistry().register(dshTaskExecutor),
    },
  ],
})
export class AppModule {}
