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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { PersonalApiGuard } from "./personal-api.guard";
import {
  PersonalConnectorError,
  PersonalConnectorService,
  shouldHydrateOpenedInbox,
  shouldNoteHumanInbox,
  shouldPullOlderInbox,
  shouldWaitForOpenedHydrate,
} from "./personal-connector.service";
import { noteHumanActivity } from "./personal-human-pace";
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
  PersonalExecutorService,
  type ExecutorInput,
} from "./personal-executor.service";
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
    private readonly executors: PersonalExecutorService,
    private readonly whatsapp: PersonalWhatsAppImportService,
  ) {}

  @Get("inbox")
  listInbox(
    @Query("since") since?: string,
    @Query("since_id") sinceId?: string,
    @Query("before") before?: string,
    @Query("before_id") beforeId?: string,
    @Query("heads") heads?: string,
    @Query("live") live?: string,
    @Query("thread_id") threadId?: string,
    @Query("limit") limit?: string,
  ) {
    const query = {
      since: since?.trim() || undefined,
      since_id: sinceId?.trim() || undefined,
      before: before?.trim() || undefined,
      before_id: beforeId?.trim() || undefined,
      heads: heads === "1" || heads === "true",
      live: live === "1" || live === "true",
      thread_id: threadId?.trim() || undefined,
      limit: limit?.trim() ? Number(limit) : undefined,
    };
    return this.guard(async () => {
      if (shouldNoteHumanInbox(query)) {
        noteHumanActivity();
      }
      const local = await this.inbox.listInbox(query);
      if (
        shouldPullOlderInbox(query) &&
        query.thread_id &&
        local.length === 0
      ) {
        await this.connectors.pullOlderForThread(query.thread_id);
        return this.inbox.listInbox(query);
      }
      if (
        shouldHydrateOpenedInbox(query) &&
        query.thread_id &&
        shouldWaitForOpenedHydrate(local.length)
      ) {
        void this.connectors.hydrateOpenedThread(query.thread_id);
      }
      return local;
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

  @Get("store")
  getStore() {
    return this.guard(() => this.inbox.getStore());
  }

  @Post("store/clear")
  async clearStore() {
    return this.guard(async () => {
      await this.work.pauseForMaintenance();
      try {
        await this.connectors.pauseForMaintenance();
        try {
          return await this.inbox.clearStore();
        } finally {
          this.connectors.resumeAfterMaintenance();
        }
      } finally {
        this.work.resumeAfterMaintenance();
      }
    });
  }

  @Post("replies")
  sendReply(@Body() body: ReplyInput) {
    noteHumanActivity();
    return this.guard(() => this.replies.send(body ?? {}));
  }

  @Post("imports/whatsapp")
  importWhatsApp(@Body() body: { content?: string; file_name?: string } | undefined) {
    return this.guard(() => this.whatsapp.import(body?.content, body?.file_name));
  }

  @Post("conversations")
  createConversation(@Body() body: { installation_id?: string } | undefined) {
    noteHumanActivity();
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
    noteHumanActivity();
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
    noteHumanActivity();
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

  @Post("executors")
  installExecutor(@Body() body: ExecutorInput | undefined) {
    return this.guard(() => this.executors.install(body ?? {}));
  }

  @Post("executors/:id/config")
  updateExecutor(@Param("id") id: string, @Body() body: ExecutorInput | undefined) {
    return this.guard(() => this.executors.update(id, body ?? {}));
  }

  @Post("executors/:id/enable")
  enableExecutor(@Param("id") id: string) {
    return this.guard(() => this.executors.setStatus(id, "enabled"));
  }

  @Post("executors/:id/disable")
  disableExecutor(@Param("id") id: string) {
    return this.guard(() => this.executors.setStatus(id, "disabled"));
  }

  @Delete("executors/:id")
  uninstallExecutor(@Param("id") id: string) {
    return this.guard(() => this.executors.uninstall(id));
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
    noteHumanActivity();
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
    noteHumanActivity();
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
    noteHumanActivity();
    return this.guard(() =>
      this.connectors.sync(id, body?.max_pages, { discover: true }),
    );
  }

  @Post("connectors/:id/webhook")
  ingestConnectorWebhook(@Param("id") id: string, @Req() req: Request) {
    return this.guard(() =>
      this.connectors.ingestWebhook(id, {
        headers: webhookHeaders(req.headers),
        body: webhookBody(req),
        received_at: new Date().toISOString(),
      }),
    );
  }

  @Post("connectors/:id/enable")
  enableConnector(@Param("id") id: string) {
    noteHumanActivity();
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

function webhookHeaders(
  headers: Request["headers"],
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value;
  }
  return out;
}

function webhookBody(req: Request): Uint8Array {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw) {
    return new Uint8Array(raw);
  }
  if (Buffer.isBuffer(req.body)) {
    return new Uint8Array(req.body);
  }
  if (typeof req.body === "string") {
    return new Uint8Array(Buffer.from(req.body));
  }
  return new Uint8Array(Buffer.from(JSON.stringify(req.body ?? {})));
}
