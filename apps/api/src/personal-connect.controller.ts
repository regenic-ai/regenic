import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { isPersonalApiEnabled } from "@regenic/config";
import { PersonalApiKeyService } from "./personal-api-key.service";
import { PersonalPairingService } from "./personal-pairing.service";

@Controller("v1/me/connect")
export class PersonalConnectController {
  constructor(
    @Inject(PersonalApiKeyService)
    private readonly keys: PersonalApiKeyService,
    @Inject(PersonalPairingService)
    private readonly pairing: PersonalPairingService,
  ) {}

  @Post("pair")
  async pair(@Body() body: { code?: string } | undefined, @Req() request: Request) {
    if (!isPersonalApiEnabled()) {
      throw new HttpException(
        { error: { code: "not_found", message: "Not Found" } },
        HttpStatus.NOT_FOUND,
      );
    }
    const code = body?.code?.trim() ?? "";
    if (!code) {
      throw new HttpException(
        { error: { code: "invalid_pairing_code", message: "Pairing code is required" } },
        HttpStatus.BAD_REQUEST,
      );
    }
    const remoteIp = request.ip || request.socket.remoteAddress || "unknown";
    const personalApiKey = await this.pairing.redeem(code, remoteIp);
    if (!personalApiKey) {
      throw new HttpException(
        { error: { code: "pairing_failed", message: "Pairing code is invalid or expired" } },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return { personal_api_key: personalApiKey };
  }
}
