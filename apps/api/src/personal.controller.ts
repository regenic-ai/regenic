import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PersonalApiGuard } from "./personal-api.guard";
import {
  PersonalConnectorError,
  PersonalConnectorService,
  shouldHydrateOpenedInbox,
  shouldWaitForOpenedHydrate,
} from "./personal-connector.service";
import {
  PersonalInboxService,
  PersonalKernelStoppedError,
} from "./personal-inbox.service";
import {
  PersonalReplyService,
  type ReplyInput,
} from "./personal-reply.service";
import { PersonalWhatsAppImportService } from "./personal-whatsapp-import.service";
import {
  PersonalWorkService,
  type RecipeInput,
} from "./personal-work.service";

@Controller("v1/me")
@UseGuards(PersonalApiGuard)
export class PersonalController {
  constructor(
    private readonly inbox: PersonalInboxService,
    private readonly connectors: PersonalConnectorService,
    private readonly replies: PersonalReplyService,
    private readonly work: PersonalWorkService,
    private readonly whatsapp: PersonalWhatsAppImportService,
  ) {}

  @Get("inbox")
  listInbox(
    @Query("since") since?: string,
    @Query("since_id") sinceId?: string,
    @Query("before") before?: string,
    @Query("before_id") beforeId?: string,
    @Query("heads") heads?: string,
    @Query("thread_id") threadId?: string,
    @Query("limit") limit?: string,
  ) {
    const query = {
      since: since?.trim() || undefined,
      since_id: sinceId?.trim() || undefined,
      before: before?.trim() || undefined,
      before_id: beforeId?.trim() || undefined,
      heads: heads === "1" || heads === "true",
      thread_id: threadId?.trim() || undefined,
      limit: limit?.trim() ? Number(limit) : undefined,
    };
    return this.guard(async () => {
      const local = await this.inbox.listInbox(query);
      if (
        !shouldHydrateOpenedInbox(query) ||
        !query.thread_id ||
        !shouldWaitForOpenedHydrate(local.length)
      ) {
        return local;
      }
      await this.connectors.hydrateOpenedThread(query.thread_id);
      return this.inbox.listInbox(query);
    });
  }

  @Get("inbox/:event_id")
  async getInboxItem(@Param("event_id") eventId: string) {
    const item = await this.guard(() => this.inbox.getInboxItem(eventId));
    if (!item) {
      throw new NotFoundException({
        error: { code: "not_found", message: "Inbox item not found" },
      });
    }
    return item;
  }

  @Get("engine")
  getEngine(@Query("detail") detail?: string) {
    return this.guard(() =>
      this.inbox.getEngine({ detailed: detail !== "0" }),
    );
  }

  @Post("replies")
  sendReply(@Body() body: ReplyInput) {
    return this.guard(() => this.replies.send(body ?? {}));
  }

  @Post("imports/whatsapp")
  importWhatsApp(@Body() body: { content?: string; file_name?: string } | undefined) {
    return this.guard(() => this.whatsapp.import(body?.content, body?.file_name));
  }

  @Post("conversations")
  createConversation(@Body() body: { installation_id?: string } | undefined) {
    return this.guard(() => this.connectors.createConversation(body ?? {}));
  }

  @Post("conversations/prefs")
  updateConversationPrefs(
    @Body()
    body: { thread_id?: string; title?: string | null; pinned?: boolean } | undefined,
  ) {
    return this.guard(() => this.inbox.updateConversationPrefs(body ?? {}));
  }

  @Post("conversations/attention")
  ackConversationAttention(
    @Body()
    body:
      | {
          thread_id?: string;
          last_read_at?: string | null;
          last_read_external_id?: string | null;
        }
      | undefined,
  ) {
    return this.guard(() => this.inbox.ackConversationAttention(body ?? {}));
  }

  @Post("conversations/prompts")
  answerConversationPrompt(
    @Body()
    body:
      | {
          thread_id?: string;
          prompt_id?: string;
          answers?: Array<{ id?: string; selected?: string[]; custom?: string }>;
        }
      | undefined,
  ) {
    return this.guard(() => this.inbox.answerConversationPrompt(body ?? {}));
  }

  @Get("recipes")
  listRecipes() {
    return this.guard(() => this.work.listRecipes());
  }

  @Post("recipes")
  createRecipe(@Body() body: RecipeInput | undefined) {
    return this.guard(() => this.work.putRecipe(body ?? {}));
  }

  @Post("recipes/:id")
  updateRecipe(@Param("id") id: string, @Body() body: RecipeInput | undefined) {
    return this.guard(() => this.work.putRecipe(body ?? {}, id));
  }

  @Delete("recipes/:id")
  deleteRecipe(@Param("id") id: string) {
    return this.guard(() => this.work.deleteRecipe(id));
  }

  @Get("executors")
  listExecutors() {
    return this.guard(() => this.work.listExecutors());
  }

  @Post("work-items/:id/run")
  runWorkItem(@Param("id") id: string) {
    return this.guard(() => this.work.runWorkItem(id));
  }

  @Post("work-items/:id/dismiss")
  dismissWorkItem(@Param("id") id: string) {
    return this.guard(() => this.work.dismissWorkItem(id));
  }

  @Post("work-items/:id/complete")
  completeWorkItem(@Param("id") id: string) {
    return this.guard(() => this.work.dismissWorkItem(id));
  }

  @Get("prefs")
  getPrefs() {
    return this.guard(() => this.work.getPrefs());
  }

  @Post("prefs")
  putPrefs(@Body() body: { inbox_sort?: string } | undefined) {
    return this.guard(() => this.work.putPrefs(body ?? {}));
  }

  @Post("connectors")
  installConnector(
    @Body()
    body: { connector_type?: string; config?: Record<string, unknown> },
  ) {
    const connectorType = body?.connector_type?.trim();
    if (!connectorType) {
      throw new HttpException(
        {
          error: {
            code: "invalid_config",
            message: "connector_type is required",
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.guard(() =>
      this.connectors.install({
        connector_type: connectorType,
        config: body.config,
      }),
    );
  }

  @Post("connectors/:id/config")
  updateConnectorConfig(
    @Param("id") id: string,
    @Body() body: { config?: Record<string, unknown> } | undefined,
  ) {
    return this.guard(() => this.connectors.updateConfig(id, body?.config ?? {}));
  }

  @Delete("connectors/:id")
  uninstallConnector(@Param("id") id: string) {
    return this.guard(() => this.connectors.uninstall(id));
  }

  @Post("connectors/:id/sync")
  syncConnector(
    @Param("id") id: string,
    @Body() body: { max_pages?: number } | undefined,
  ) {
    return this.guard(() => this.connectors.sync(id, body?.max_pages));
  }

  @Post("connectors/:id/enable")
  enableConnector(@Param("id") id: string) {
    return this.guard(() => this.connectors.setStatus(id, "enabled"));
  }

  @Post("connectors/:id/disable")
  disableConnector(@Param("id") id: string) {
    return this.guard(() => this.connectors.setStatus(id, "disabled"));
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
