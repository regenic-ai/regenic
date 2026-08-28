import { Module } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
} from "@regenic/domain";
import { cursorAgentDriver } from "@regenic/cursor-connector";
import { dshSessionDriver, dshTaskExecutor } from "@regenic/dsh-connector";
import { feishuChatDriver } from "@regenic/feishu-connector";
import { slackChannelDriver } from "@regenic/slack-connector";
import { extraChannelDrivers, extraTaskExecutors } from "./extra-channel-drivers";
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
          .register(slackChannelDriver)
          .register(dshSessionDriver)
          .register(feishuChatDriver)
          .register(cursorAgentDriver);
        for (const driver of extraChannelDrivers()) {
          if (registry.has(driver.connector_type)) {
            console.warn(
              `regenic extra connector: skip ${driver.connector_type}, already registered`,
            );
            continue;
          }
          registry.register(driver);
        }
        return registry;
      },
    },
    {
      provide: LocalExecutorPluginRegistry,
      useFactory: () => {
        const registry = new LocalExecutorPluginRegistry().register(
          dshTaskExecutor,
        );
        for (const plugin of extraTaskExecutors()) {
          const source = plugin.catalog().source?.trim();
          if (!source || registry.forSource(source)) {
            if (source) {
              console.warn(
                `regenic extra executor: skip ${source}, already registered`,
              );
            }
            continue;
          }
          registry.register(plugin);
        }
        return registry;
      },
    },
  ],
})
export class AppModule {}
