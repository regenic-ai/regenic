import { Module } from "@nestjs/common";
import { ChannelDriverRegistry } from "@regenic/domain";
import { dshSessionDriver } from "@regenic/dsh-connector";
import { slackChannelDriver } from "@regenic/slack-connector";
import { DshApiController } from "./dsh-api.controller";
import { DshApiService } from "./dsh-api.service";
import { HealthController } from "./health.controller";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalController } from "./personal.controller";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalReplyService } from "./personal-reply.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

@Module({
  controllers: [HealthController, DshApiController, PersonalController],
  providers: [
    DshApiService,
    PersonalRuntimeService,
    PersonalInboxService,
    PersonalReplyService,
    PersonalConnectorService,
    {
      provide: ChannelDriverRegistry,
      useFactory: () =>
        new ChannelDriverRegistry()
          .register(dshSessionDriver)
          .register(slackChannelDriver),
    },
  ],
})
export class AppModule {}
