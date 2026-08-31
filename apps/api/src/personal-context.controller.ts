import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PersonalApiGuard } from "./personal-api.guard";
import {
  PersonalContextError,
  PersonalContextService,
} from "./personal-context.service";
import { PersonalKernelStoppedError } from "./personal-runtime.service";

@Controller("v1/me/context")
@UseGuards(PersonalApiGuard)
export class PersonalContextController {
  constructor(
    @Inject(PersonalContextService)
    private readonly context: PersonalContextService,
  ) {}

  @Post("assemble")
  assemble(@Body() body: unknown) {
    return this.guard(() => this.context.assemble(body));
  }

  @Get("snapshots/:snapshotId")
  getSnapshot(@Param("snapshotId") snapshotId: string) {
    return this.guard(() => this.context.getSnapshot(snapshotId));
  }

  @Post("replay")
  replay(@Body() body: unknown) {
    return this.guard(() => this.context.replay(body));
  }

  @Post("ask")
  ask(@Body() body: unknown) {
    return this.guard(() => this.context.ask(body));
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
      if (error instanceof PersonalContextError) {
        throw new HttpException(
          { error: { code: error.code, message: error.message } },
          error.httpStatus,
        );
      }
      throw error;
    }
  }
}
