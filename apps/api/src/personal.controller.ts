import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  forwardRef,
} from "@nestjs/common";
import type { Request } from "express";
import { PersonalApiGuard } from "./personal-api.guard";
import { requestLocale } from "./request-locale";
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
  PersonalForwardService,
  type ForwardInput,
} from "./personal-forward.service";
import {
  PersonalReplyService,
  type ReplyInput,
} from "./personal-reply.service";
import { PersonalPluginService } from "./personal-plugin.service";
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
    @Inject(forwardRef(() => PersonalInboxService))
    private readonly inbox: PersonalInboxService,
    @Inject(PersonalConnectorService)
    private readonly connectors: PersonalConnectorService,
    @Inject(PersonalReplyService)
    private readonly replies: PersonalReplyService,
    @Inject(PersonalForwardService)
    private readonly forwards: PersonalForwardService,
    @Inject(forwardRef(() => PersonalWorkService))
    private readonly work: PersonalWorkService,
    @Inject(forwardRef(() => PersonalExecutorService))
    private readonly executors: PersonalExecutorService,
    @Inject(PersonalWhatsAppImportService)
    private readonly whatsapp: PersonalWhatsAppImportService,
    @Inject(PersonalPluginService)
    private readonly plugins: PersonalPluginService,
  ) {}

  @Get("inbox")
  listInbox(
    @Query("since") since?: string,
    @Query("since_id") sinceId?: string,
    @Query("before") before?: string,
    @Query("before_id") beforeId?: string,
    @Query("heads") heads?: string,
    @Query("live") live?: string,
    @Query("split") split?: string,
    @Query("changed") changed?: string,
    @Query("since_digest") sinceDigest?: string,
    @Query("thread_id") threadId?: string,
    @Query("limit") limit?: string,
    @Query("list") list?: string,
    @Query("membership") membership?: string,
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    const query = {
      since: since?.trim() || undefined,
      since_id: sinceId?.trim() || undefined,
      before: before?.trim() || undefined,
      before_id: beforeId?.trim() || undefined,
      heads: heads === "1" || heads === "true",
      live: live === "1" || live === "true",
      split: split === "1" || split === "true",
      changed: changed === "1" || changed === "true",
      since_digest: sinceDigest?.trim() || undefined,
      thread_id: threadId?.trim() || undefined,
      limit: limit?.trim() ? Number(limit) : undefined,
      list: list?.trim() || membership?.trim() || undefined,
      locale: requestLocale(locale, acceptLanguage),
    };
    return this.guard(async () => {
      if (shouldNoteHumanInbox(query)) {
        noteHumanActivity();
      }
      const local = await this.inbox.listInbox(query);
      if (
        Array.isArray(local) &&
        shouldPullOlderInbox(query) &&
        query.thread_id &&
        local.length === 0
      ) {
        await this.connectors.pullOlderForThread(query.thread_id);
        return this.inbox.listInbox(query);
      }
      if (
        Array.isArray(local) &&
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
  async getInboxItem(
    @Param("event_id") eventId: string,
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    const item = await this.guard(() =>
      this.inbox.getInboxItem(eventId, requestLocale(locale, acceptLanguage)),
    );
    if (!item) {
      throw new NotFoundException({
        error: { code: "not_found", message: "Inbox item not found" },
      });
    }
    return item;
  }

  @Get("engine")
  getEngine(
    @Query("detail") detail?: string,
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    return this.guard(() =>
      this.inbox.getEngine({
        detailed: detail !== "0",
        locale: requestLocale(locale, acceptLanguage),
      }),
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

  @Post("forwards")
  sendForward(@Body() body: ForwardInput) {
    noteHumanActivity();
    return this.guard(() => this.forwards.send(body ?? {}));
  }

  @Post("imports")
  importFile(
    @Body()
    body:
      | { connector_type?: string; content?: string; file_name?: string }
      | undefined,
  ) {
    return this.guard(() => this.whatsapp.importFile(body ?? {}));
  }

  @Post("imports/whatsapp")
  importWhatsApp(@Body() body: { content?: string; file_name?: string } | undefined) {
    return this.guard(() => this.whatsapp.import(body?.content, body?.file_name));
  }

  @Get("plugins")
  listPlugins() {
    return this.guard(async () => this.plugins.list());
  }

  @Post("plugins/reload")
  reloadPlugins() {
    return this.guard(async () => this.plugins.reload());
  }

  @Post("conversations")
  createConversation(
    @Body()
    body:
      | {
          installation_id?: string;
          source?: string;
          text?: string;
          client_request_id?: string;
        }
      | undefined,
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    noteHumanActivity();
    return this.guard(() =>
      this.connectors.createConversation({
        ...(body ?? {}),
        locale: requestLocale(locale, acceptLanguage),
      }),
    );
  }

  @Post("conversations/prefs")
  updateConversationPrefs(
    @Body()
    body:
      | {
          thread_id?: string;
          title?: string | null;
          pinned?: boolean;
          hidden?: boolean;
        }
      | undefined,
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
  listExecutors(
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    return this.guard(() =>
      this.work.listExecutors(requestLocale(locale, acceptLanguage)),
    );
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
  putPrefs(
    @Body()
    body:
      | {
          inbox_sort?: string;
          inbox_list?: string;
          inbox_membership?: string;
        }
      | undefined,
  ) {
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

  @Get("connectors/:id/egress")
  listConnectorEgress(
    @Param("id") id: string,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    return this.guard(() => this.connectors.listEgressQueue(id, { apiKey, origin }));
  }

  @Post("connectors/:id/egress/:commandId/ack")
  ackConnectorEgress(
    @Param("id") id: string,
    @Param("commandId") commandId: string,
    @Headers("x-regenic-live-key") apiKey?: string,
    @Headers("origin") origin?: string,
  ) {
    return this.guard(() =>
      this.connectors.ackEgressQueue(id, commandId, { apiKey, origin }),
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

  @Get("connectors/:id/pairing-code")
  revealConnectorPairingCode(@Param("id") id: string) {
    return this.guard(() => this.connectors.revealPairingCode(id));
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
