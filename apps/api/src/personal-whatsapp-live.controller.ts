import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { isLoopbackListenHost, loadEnv } from "@regenic/config";
import { PersonalApiGuard } from "./personal-api.guard";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalKernelStoppedError } from "./personal-inbox.service";
import {
  PersonalWhatsAppLiveService,
  type WhatsAppLiveMessageInput,
  type WhatsAppLiveSendInput,
} from "./personal-whatsapp-live.service";

@Controller("v1/me/live/whatsapp")
@UseGuards(PersonalApiGuard)
export class PersonalWhatsAppLiveController {
  constructor(private readonly live: PersonalWhatsAppLiveService) {}

  @Get("status")
  getStatus(
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    this.requireLiveAccess(apiKey, origin);
    return this.guard(() => Promise.resolve(this.live.status()));
  }

  @Post("messages")
  receiveMessage(
    @Body() body: WhatsAppLiveMessageInput | undefined,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    this.requireLiveAccess(apiKey, origin);
    return this.guard(() => this.live.receiveMessage(body));
  }

  @Post("send")
  send(
    @Body() body: WhatsAppLiveSendInput | undefined,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    this.requireLiveAccess(apiKey, origin);
    return this.guard(() => Promise.resolve(this.live.enqueueSend(body)));
  }

  @Get("commands")
  listCommands(
    @Query("client_id") clientId?: string,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    this.requireLiveAccess(apiKey, origin);
    return this.guard(() => Promise.resolve(this.live.listCommands(clientId)));
  }

  @Post("commands/:id/ack")
  acknowledgeCommand(
    @Param("id") id: string,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    this.requireLiveAccess(apiKey, origin);
    return this.guard(() => Promise.resolve(this.live.acknowledgeCommand(id)));
  }

  private requireLiveAccess(apiKey: string | undefined, origin: string | undefined): void {
    const env = loadEnv();
    if (!isLoopbackListenHost(env.LISTEN_HOST)) {
      throw new HttpException(
        { error: { code: "forbidden", message: "WhatsApp live connector is loopback-only" } },
        HttpStatus.FORBIDDEN,
      );
    }
    const expected = env.REGENIC_PERSONAL_LIVE_KEY?.trim();
    if (origin?.trim() && !expected) {
      throw new HttpException(
        { error: { code: "unauthorized", message: "Live connector API key is required for browser access" } },
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (expected && apiKey !== expected) {
      throw new HttpException(
        { error: { code: "unauthorized", message: "Invalid live connector API key" } },
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PersonalKernelStoppedError) {
        throw new HttpException(
          {
            error: {
              code: "not_configured",
              message: "REGENIC_DATABASE and REGENIC_BLOB_ROOT are required",
            },
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error instanceof PersonalConnectorError) {
        throw new HttpException(
          { error: { code: error.code, message: error.message } },
          error.httpStatus,
        );
      }
      throw error;
    }
  }
}