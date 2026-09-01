import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  isAllowedPersonalCorsOrigin,
  isPersonalApiEnabled,
} from "@regenic/config";
import { PersonalConnectorService } from "./personal-connector.service";

@Injectable()
export class PersonalApiGuard implements CanActivate {
  constructor(
    @Inject(PersonalConnectorService)
    private readonly connectors: PersonalConnectorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isPersonalApiEnabled()) {
      throw new NotFoundException({
        error: { code: "not_found", message: "Not Found" },
      });
    }
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get("origin");
    if (!origin) {
      return true;
    }
    if (!isAllowedPersonalCorsOrigin(origin)) {
      throw new HttpException(
        { error: { code: "forbidden_origin", message: "Origin is not allowed" } },
        HttpStatus.FORBIDDEN,
      );
    }
    const expected = process.env.REGENIC_PERSONAL_API_KEY?.trim();
    if (!expected) {
      return true;
    }
    const provided = request.get("x-regenic-personal-key")?.trim();
    if (provided && sameSecret(expected, provided)) {
      return true;
    }
    const liveKey = request.get("x-regenic-live-key")?.trim();
    if (
      liveKey &&
      isExtensionOrigin(origin) &&
      await this.connectors.allowsBrowserLiveRequest(request.path, liveKey)
    ) {
      return true;
    }
    throw new HttpException(
      {
        error: {
          code: "personal_api_unauthorized",
          message: "Personal API browser authentication is required",
        },
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

function sameSecret(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
}

function isExtensionOrigin(origin: string): boolean {
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "chrome-extension:" || protocol === "ms-browser-extension:";
  } catch {
    return false;
  }
}
