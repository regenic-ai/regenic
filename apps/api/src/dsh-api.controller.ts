import { Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { DshApiService } from "./dsh-api.service";

@Controller("v1/dsh/api")
export class DshApiController {
  constructor(private readonly dshApi: DshApiService) {}

  @Post("session.history")
  history(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.dispatch("session.history", request, response);
  }

  @Post("session.prompt")
  prompt(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.dispatch("session.prompt", request, response);
  }

  @Post("session.list")
  list(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.dispatch("session.list", request, response);
  }

  private async dispatch(
    method: string,
    request: Request,
    response: Response,
  ): Promise<void> {
    const result = await this.dshApi.handle(method, {
      contentType: headerValue(request.headers["content-type"]),
      authorization: headerValue(request.headers.authorization),
      body: request.body,
    });
    response.status(result.status).json(result.body);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
