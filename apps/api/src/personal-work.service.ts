import { randomUUID } from "node:crypto";
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  ChannelDriverRegistry,
  INGEST_SCHEMA_VERSION,
  INBOX_SORT_PREF_KEY,
  channelRecord,
  conversationId,
  formatWorkEvidence,
  hiddenExecutorThreadIds,
  isActiveWorkStatus,
  isRecordClass,
  isThreadFacet,
  normalizeInboxSort,
  openOrUpdateWorkItem,
  parseConversationThread,
  recipeSpecificity,
  selectRecipeForSubject,
  toReplyParts,
  workFaceOf,
  workStatusFromHandle,
  workSubjectFromEvent,
  type ArrangementDecision,
  type AttentionClass,
  type ConnectorInstallation,
  type ContentPart,
  type ConversationThread,
  type EventRecord,
  type ExecutorContext,
  type ExecutorRunHandle,
  type InboxSortMode,
  type JsonValue,
  type PromptAnswer,
  type Recipe,
  type RecipeMatch,
  type RecordClass,
  type TaskExecutor,
  type ThreadFacet,
  type ThreadPrompt,
  type WorkFace,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { resolveInboxBodies, type InboxBody } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";

const WORK_TICK_MS = 3_000;

export interface RecipeInput {
  id?: string;
  name?: string;
  match?: RecipeMatch;
  executor_type?: string;
  executor_config?: Record<string, JsonValue>;
  can_write_back?: boolean;
  enabled?: boolean;
}

export interface UiPrefsView {
  inbox_sort: InboxSortMode;
}

export interface WorkInboxFace {
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  attention: AttentionClass;
  work?: WorkFace;
  agent_thread_id?: string;
  extra_prompts?: ThreadPrompt[];
}

export interface WorkRunView {
  work_item: WorkItem;
  run?: WorkRun;
}

@Injectable()
export class PersonalWorkService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.timer = setInterval(() => {
      void this.afterConnectorTick();
    }, WORK_TICK_MS);
    void this.afterConnectorTick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async afterConnectorTick(): Promise<void> {
    if (this.ticking || !this.runtime.isReady()) {
      return;
    }
    this.ticking = true;
    try {
      await this.reconcileInbox();
      await this.refreshRuns();
    } catch {
      // A work tick must not take down connector pull.
    } finally {
      this.ticking = false;
    }
  }

  async listRecipes(): Promise<Recipe[]> {
    const host = this.runtime.requireHost();
    return host.get("authority").listRecipes(this.runtime.orgId());
  }

  async listExecutors() {
    return this.runtime.requireHost().get("executors").catalog();
  }

  async putRecipe(input: RecipeInput, id?: string): Promise<Recipe> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const now = new Date().toISOString();
    const existing = id
      ? await host.get("authority").getRecipe(orgId, id)
      : null;
    if (id && !existing) {
      throw new PersonalConnectorError("not_found", "Recipe not found", 404);
    }
    const recipe = normalizeRecipe(input, orgId, now, existing ?? undefined);
    const executor = host.get("executors").get(recipe.executor_type);
    if (!executor) {
      throw new PersonalConnectorError(
        "invalid_config",
        `Unknown executor: ${recipe.executor_type}`,
        400,
      );
    }
    void executor;
    const saved = await host.get("authority").putRecipe(recipe);
    void this.afterConnectorTick();
    return saved;
  }

  async deleteRecipe(id: string): Promise<{ id: string; removed: true }> {
    const host = this.runtime.requireHost();
    const removed = await host.get("authority").deleteRecipe(this.runtime.orgId(), id);
    if (!removed) {
      throw new PersonalConnectorError("not_found", "Recipe not found", 404);
    }
    return { id, removed: true };
  }

  async getPrefs(): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const raw = await host
      .get("authority")
      .getUiPref(this.runtime.orgId(), INBOX_SORT_PREF_KEY);
    return { inbox_sort: normalizeInboxSort(raw) };
  }

  async putPrefs(input: { inbox_sort?: string }): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const inbox_sort = normalizeInboxSort(input.inbox_sort);
    await host.get("authority").putUiPref(
      this.runtime.orgId(),
      INBOX_SORT_PREF_KEY,
      inbox_sort,
      new Date().toISOString(),
    );
    return { inbox_sort };
  }

  async inboxFaces(
    threadIds: string[],
    extraPrompts: ReadonlyMap<string, ThreadPrompt[]> = new Map(),
  ): Promise<Map<string, WorkInboxFace>> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [items, runs, recipes] = await Promise.all([
      authority.listWorkItems(orgId),
      authority.listWorkRuns(orgId),
      authority.listRecipes(orgId),
    ]);
    const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const itemsByThread = new Map(items.map((item) => [item.thread_id, item]));
    const runsByItem = latestRunsByItem(runs);
    const wanted = new Set(threadIds);
    const faces = new Map<string, WorkInboxFace>();
    for (const threadId of wanted) {
      const item = itemsByThread.get(threadId);
      if (!item) {
        continue;
      }
      const recipe = item.recipe_id ? recipesById.get(item.recipe_id) : undefined;
      const run = runsByItem.get(item.id);
      const work = workFaceOf(item, recipe, run);
      faces.set(threadId, {
        record_class: item.record_class,
        thread_facet: item.thread_facet,
        attention: attentionForWork(work, extraPrompts.get(threadId)?.length ?? 0),
        work,
        agent_thread_id: run?.agent_thread_id,
      });
    }
    return faces;
  }

  async hiddenThreadIds(): Promise<Set<string>> {
    if (!this.runtime.isReady()) {
      return new Set();
    }
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const [items, runs] = await Promise.all([
      host.get("authority").listWorkItems(orgId),
      host.get("authority").listWorkRuns(orgId),
    ]);
    return hiddenExecutorThreadIds(items, runs);
  }

  async boundPromptThreads(): Promise<Map<string, string>> {
    const hidden = await this.hiddenThreadIds();
    if (hidden.size === 0) {
      return new Map();
    }
    const host = this.runtime.requireHost();
    const runs = await host.get("authority").listWorkRuns(this.runtime.orgId());
    const items = await host.get("authority").listWorkItems(this.runtime.orgId());
    const itemById = new Map(items.map((item) => [item.id, item]));
    const bound = new Map<string, string>();
    for (const run of runs) {
      if (!run.agent_thread_id || !hidden.has(run.agent_thread_id)) {
        continue;
      }
      const item = itemById.get(run.work_item_id);
      if (item) {
        bound.set(item.thread_id, run.agent_thread_id);
      }
    }
    return bound;
  }

  async promptTargetThread(
    threadId: string,
    promptId: string,
    sourceHasPrompt: boolean,
  ): Promise<ConversationThread> {
    if (sourceHasPrompt) {
      return parseConversationThread(threadId);
    }
    const faces = await this.inboxFaces([threadId]);
    const agentId = faces.get(threadId)?.agent_thread_id;
    return parseConversationThread(agentId || threadId);
  }

  async afterPrompt(threadId: string, answer?: PromptAnswer): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const item = await host.get("authority").getWorkItemByThread(orgId, threadId);
    if (!item) {
      return;
    }
    const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (!run) {
      return;
    }
    const recipe = item.recipe_id
      ? await host.get("authority").getRecipe(orgId, item.recipe_id)
      : null;
    const executor = host.get("executors").get(run.executor_type);
    if (!recipe || !executor) {
      return;
    }
    const handle = await executor.resume(
      { run, work_item: item, recipe, answer },
      this.contextFor(executor),
    );
    await this.applyHandle(item, recipe, run, handle);
  }

  async ackDoneThread(threadId: string): Promise<void> {
    const host = this.runtime.requireHost();
    const item = await host
      .get("authority")
      .getWorkItemByThread(this.runtime.orgId(), threadId);
    if (!item || isActiveWorkStatus(item.status) || !item.head_event_id) {
      return;
    }
    const event = await host.get("authority").getEvent(item.org_id, item.head_event_id);
    if (!event) {
      return;
    }
    await forceDisposition(
      host.get("authority"),
      event,
      "outside_current_work",
      "work_acked",
      new Date().toISOString(),
    );
  }

  async runWorkItem(id: string): Promise<WorkRunView> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const item = await host.get("authority").getWorkItem(orgId, id);
    if (!item) {
      throw new PersonalConnectorError("not_found", "Work item not found", 404);
    }
    const recipe = item.recipe_id
      ? await host.get("authority").getRecipe(orgId, item.recipe_id)
      : null;
    if (!recipe) {
      throw new PersonalConnectorError(
        "invalid_config",
        "This work item has no recipe",
        400,
      );
    }
    const active = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (active) {
      await this.refreshOne(item, recipe, active);
      return {
        work_item: (await host.get("authority").getWorkItem(orgId, item.id)) ?? item,
        run: (await host.get("authority").getActiveWorkRun(orgId, item.id)) ?? active,
      };
    }
    const opened =
      item.status === "open"
        ? item
        : await host.get("authority").putWorkItem({
            ...item,
            status: "open",
            updated_at: new Date().toISOString(),
          });
    const run = await this.startItem(opened, recipe);
    return {
      work_item: (await host.get("authority").getWorkItem(orgId, opened.id)) ?? opened,
      run,
    };
  }

  private async reconcileInbox(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [recipes, items, runs, heads] = await Promise.all([
      authority.listRecipes(orgId),
      authority.listWorkItems(orgId),
      authority.listWorkRuns(orgId),
      authority.listInbox(orgId, { heads: true }),
    ]);
    if (heads.length === 0 && items.length === 0) {
      return;
    }
    const hidden = hiddenExecutorThreadIds(items, runs);
    const bodies = await resolveInboxBodies(
      authority,
      host.get("blobs"),
      heads.map((row) => row.event.content_hash),
      "meta",
    );
    const installations = await authority.listInstallations(orgId);
    const seen = new Set<string>();
    for (const row of heads) {
      const threadId = conversationId(row.event.source, row.event.external_id, row.event.id);
      if (hidden.has(threadId) || seen.has(threadId)) {
        continue;
      }
      seen.add(threadId);
      const body = row.event.content_hash
        ? (bodies.get(row.event.content_hash) ?? {})
        : {};
      await this.observeHead({
        event: row.event,
        threadId,
        body,
        recipes,
        installations,
      });
    }
    for (const item of items) {
      if (seen.has(item.thread_id) || hidden.has(item.thread_id)) {
        continue;
      }
      if (!isActiveWorkStatus(item.status) || !item.head_event_id) {
        continue;
      }
      const event = await authority.getEvent(orgId, item.head_event_id);
      if (!event) {
        continue;
      }
      const body = await resolveInboxBodies(
        authority,
        host.get("blobs"),
        [event.content_hash],
        "meta",
      );
      await this.observeHead({
        event,
        threadId: item.thread_id,
        body: event.content_hash ? (body.get(event.content_hash) ?? {}) : {},
        recipes,
        installations,
      });
    }
  }

  private async observeHead(input: {
    event: EventRecord;
    threadId: string;
    body: InboxBody;
    recipes: Recipe[];
    installations: ConnectorInstallation[];
  }): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    let thread: ConversationThread;
    try {
      thread = parseConversationThread(input.threadId);
    } catch {
      return;
    }
    const existing = await authority.getWorkItemByThread(orgId, input.threadId);
    const surface = input.body.surface;
    const subject = workSubjectFromEvent({
      type: surface?.type,
      source: input.event.source,
      thread_id: input.threadId,
      await_reply: this.drivers.awaitReply(input.installations, thread),
      prompts: this.drivers.canPrompt(input.installations, thread),
      hint: surface?.thread_facet,
      prior_facet: existing?.thread_facet,
    });
    if (!subject) {
      return;
    }
    const recipe = selectRecipeForSubject(input.recipes, subject);
    const next = openOrUpdateWorkItem({
      existing,
      org_id: orgId,
      subject,
      head_event_id: input.event.id,
      recipe,
      now: new Date().toISOString(),
    });
    if (!next) {
      return;
    }
    const saved = await authority.putWorkItem(next);
    if (isActiveWorkStatus(saved.status)) {
      const current = await authority.getDisposition(input.event.id);
      if (current?.disposition !== "current_work") {
        await forceDisposition(
          authority,
          input.event,
          "current_work",
          "work_item",
          saved.updated_at,
        );
      }
    }
    if (saved.status === "open" && recipe) {
      const active = await authority.getActiveWorkRun(orgId, saved.id);
      if (!active) {
        await this.startItem(saved, recipe, input.body.body_text);
      }
    }
  }

  private async startItem(
    item: WorkItem,
    recipe: Recipe,
    evidenceText?: string,
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(recipe.executor_type);
    if (!executor) {
      await host.get("authority").putWorkItem({
        ...item,
        status: "failed",
        updated_at: new Date().toISOString(),
      });
      return undefined;
    }
    const now = new Date().toISOString();
    const text =
      evidenceText ??
      (await this.evidenceText(item.thread_id, item.head_event_id));
    const handle = await executor.start(
      {
        work_item: item,
        recipe,
        evidence_text: formatWorkEvidence({
          thread_id: item.thread_id,
          record_class: item.record_class,
          thread_facet: item.thread_facet,
          source: item.thread_id.split(":")[0] ?? "",
          text,
        }),
      },
      this.contextFor(executor),
    );
    const run: WorkRun = {
      id: `run-${randomUUID()}`,
      org_id: item.org_id,
      work_item_id: item.id,
      recipe_id: recipe.id,
      executor_type: executor.executor_type,
      external_run_id: handle.external_run_id,
      agent_thread_id: handle.agent_thread_id,
      status: handle.status === "completed" ? "completed" : handle.status === "failed" ? "failed" : handle.status === "waiting_human" ? "waiting_human" : "running",
      result: handle.result,
      created_at: now,
      updated_at: now,
    };
    await this.applyHandle(item, recipe, run, handle);
    return (
      (await host.get("authority").getActiveWorkRun(item.org_id, item.id)) ?? run
    );
  }

  private async refreshRuns(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const items = await host.get("authority").listWorkItems(orgId);
    for (const item of items) {
      if (item.status !== "running" && item.status !== "waiting_human") {
        continue;
      }
      const recipe = item.recipe_id
        ? await host.get("authority").getRecipe(orgId, item.recipe_id)
        : null;
      const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
      if (!recipe || !run) {
        continue;
      }
      await this.refreshOne(item, recipe, run);
    }
  }

  private async refreshOne(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(run.executor_type);
    if (!executor) {
      return;
    }
    const handle = await executor.status(run, this.contextFor(executor));
    await this.applyHandle(item, recipe, run, handle);
  }

  private async applyHandle(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
    handle: ExecutorRunHandle,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const now = new Date().toISOString();
    const nextRun: WorkRun = {
      ...run,
      external_run_id: handle.external_run_id,
      agent_thread_id: handle.agent_thread_id ?? run.agent_thread_id,
      status:
        handle.status === "completed"
          ? "completed"
          : handle.status === "failed"
            ? "failed"
            : handle.status === "waiting_human"
              ? "waiting_human"
              : "running",
      result: handle.result ?? run.result,
      updated_at: now,
    };
    await host.get("authority").putWorkRun(nextRun);
    let status = workStatusFromHandle(handle);
    if (handle.status === "completed" && recipe.can_write_back && handle.result) {
      try {
        await this.writeBack(item, handle.result.summary, handle.result.content);
      } catch {
        status = "failed";
      }
    }
    const saved = await host.get("authority").putWorkItem({
      ...item,
      status,
      updated_at: now,
    });
    if (
      saved.head_event_id &&
      saved.status === "done" &&
      recipe.can_write_back
    ) {
      const event = await host
        .get("authority")
        .getEvent(saved.org_id, saved.head_event_id);
      if (event) {
        await forceDisposition(
          host.get("authority"),
          event,
          "outside_current_work",
          "work_done",
          now,
        );
      }
    }
  }

  private contextFor(executor: TaskExecutor): ExecutorContext {
    return {
      org_id: this.runtime.orgId(),
      env: process.env,
      createThread: async () => {
        const host = this.runtime.requireHost();
        const installations = await host
          .get("authority")
          .listInstallations(this.runtime.orgId());
        const found = this.drivers.findCreatable(
          installations,
          executor.catalog().source,
        );
        if (!found) {
          throw new PersonalConnectorError(
            "unsupported_channel",
            "No enabled connector can create an executor session",
            501,
          );
        }
        return found.driver.createThread(
          found.installation,
          host,
          process.env,
        );
      },
      sendText: async (thread, text) => {
        await this.sendText(thread, text);
      },
      listPrompts: async (thread) => {
        const host = this.runtime.requireHost();
        const installations = await host
          .get("authority")
          .listInstallations(this.runtime.orgId());
        return this.drivers.listPrompts(installations, thread, host);
      },
      latestVisible: async (threadId) => this.latestVisible(threadId),
    };
  }

  private async sendText(
    thread: ConversationThread,
    text: string,
    options?: { writeBack?: boolean },
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    const found = this.drivers.findForThread(installations, thread);
    if (!found || !found.driver.canReply(found.installation)) {
      throw new PersonalConnectorError(
        "no_sender",
        "No enabled connector can send in this conversation",
        404,
      );
    }
    const content = toReplyParts({ text });
    const egress = await found.driver.bindEgress(
      found.installation,
      thread,
      host,
      process.env,
    );
    const receipt = await egress.send({
      installation_id: found.installation.id,
      target: { scope_id: thread.target },
      content,
    });
    const now = new Date().toISOString();
    await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: found.installation.id,
      org_id: this.runtime.orgId(),
      delivery_id: `${options?.writeBack ? "work-back" : "work-exec"}:${randomUUID()}`,
      received_at: now,
      records: [
        channelRecord({
          channel: found.driver.source,
          kind: "user",
          direction: "outbound",
          external_id: found.driver.outboundId(thread, receipt),
          occurred_at: now,
          actor_id: "local-owner",
          scope_id: thread.target,
          content,
        }),
      ],
    });
  }

  private async writeBack(
    item: WorkItem,
    summary: string,
    content?: ContentPart[],
  ): Promise<void> {
    const recipe = item.recipe_id
      ? await this.runtime
          .requireHost()
          .get("authority")
          .getRecipe(item.org_id, item.recipe_id)
      : null;
    if (!recipe?.can_write_back) {
      return;
    }
    const thread = parseConversationThread(item.thread_id);
    const text =
      content
        ?.map((part) => ("text" in part && part.text ? part.text : ""))
        .find((part) => part.trim())
        ?.trim() ?? summary;
    if (!text.trim()) {
      return;
    }
    await this.sendText(thread, text, { writeBack: true });
  }

  private async latestVisible(
    threadId: string,
  ): Promise<{
    kind: import("@regenic/domain").MessageKind;
    text?: string;
    activity?: string;
  } | null> {
    const host = this.runtime.requireHost();
    const items = await host.get("authority").listInbox(this.runtime.orgId(), {
      thread_ids: [threadId],
      siblings: true,
    });
    const live = [...items].reverse().find((row) => row.event.operation !== "tombstone");
    if (!live) {
      return null;
    }
    const hashes = [live.event.content_hash];
    const visible = items
      .slice()
      .reverse()
      .find((row) => {
        const codes = row.decision.reason_codes;
        return !codes.includes("thread_status") && row.event.operation !== "tombstone";
      });
    if (visible && visible.event.id !== live.event.id) {
      hashes.push(visible.event.content_hash);
    }
    const bodies = await resolveInboxBodies(
      host.get("authority"),
      host.get("blobs"),
      hashes,
      "meta",
    );
    const liveBody = live.event.content_hash
      ? (bodies.get(live.event.content_hash) ?? {})
      : {};
    if (
      liveBody.surface?.activity === "working" ||
      liveBody.surface?.type === "thread_status" ||
      live.decision.reason_codes.includes("thread_status")
    ) {
      return {
        kind: liveBody.surface?.kind ?? "system",
        activity: "working",
      };
    }
    const body = visible?.event.content_hash
      ? (bodies.get(visible.event.content_hash) ?? liveBody)
      : liveBody;
    return {
      kind: body.surface?.kind ?? "assistant",
      text: body.body_text,
      activity: body.surface?.activity,
    };
  }

  private async evidenceText(
    threadId: string,
    headEventId?: string,
  ): Promise<string | undefined> {
    const host = this.runtime.requireHost();
    if (headEventId) {
      const event = await host.get("authority").getEvent(this.runtime.orgId(), headEventId);
      if (event?.content_hash) {
        const bodies = await resolveInboxBodies(
          host.get("authority"),
          host.get("blobs"),
          [event.content_hash],
          "meta",
        );
        return bodies.get(event.content_hash)?.body_text;
      }
    }
    const items = await host.get("authority").listInbox(this.runtime.orgId(), {
      thread_ids: [threadId],
      heads: true,
    });
    const head = items[items.length - 1];
    if (!head?.event.content_hash) {
      return undefined;
    }
    const bodies = await resolveInboxBodies(
      host.get("authority"),
      host.get("blobs"),
      [head.event.content_hash],
      "meta",
    );
    return bodies.get(head.event.content_hash)?.body_text;
  }
}

function latestRunsByItem(runs: WorkRun[]): Map<string, WorkRun> {
  const best = new Map<string, WorkRun>();
  for (const run of runs) {
    const current = best.get(run.work_item_id);
    if (!current || current.updated_at < run.updated_at) {
      best.set(run.work_item_id, run);
    }
  }
  return best;
}

function attentionForWork(
  work: WorkFace,
  extraPrompts: number,
): AttentionClass {
  if (extraPrompts > 0 || work.status === "waiting_human" || work.status === "failed") {
    return "waiting_you";
  }
  if (work.status === "done" && work.has_result && work.can_write_back === false) {
    return "needs_ack";
  }
  if (work.status === "running") {
    return "running";
  }
  return "quiet";
}

function normalizeRecipe(
  input: RecipeInput,
  orgId: string,
  now: string,
  existing?: Recipe,
): Recipe {
  const name = (input.name ?? existing?.name ?? "").trim();
  if (!name) {
    throw new PersonalConnectorError("invalid_config", "Recipe name is required", 400);
  }
  const executor_type = (input.executor_type ?? existing?.executor_type ?? "").trim();
  if (!executor_type) {
    throw new PersonalConnectorError(
      "invalid_config",
      "executor_type is required",
      400,
    );
  }
  const match = normalizeMatch(input.match ?? existing?.match ?? {});
  if (recipeSpecificity(match) === 0) {
    throw new PersonalConnectorError(
      "invalid_config",
      "Recipe match needs a source, class, facet, or thread",
      400,
    );
  }
  return {
    id: existing?.id ?? input.id?.trim() ?? `recipe-${randomUUID()}`,
    org_id: orgId,
    name,
    match,
    executor_type,
    executor_config: input.executor_config ?? existing?.executor_config ?? {},
    can_write_back: input.can_write_back ?? existing?.can_write_back ?? false,
    enabled: input.enabled ?? existing?.enabled ?? true,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function normalizeMatch(match: RecipeMatch): RecipeMatch {
  const record_class = match.record_class;
  if (record_class !== undefined && !isRecordClass(record_class)) {
    throw new PersonalConnectorError(
      "invalid_config",
      "record_class is not a closed class",
      400,
    );
  }
  const thread_facet = match.thread_facet;
  if (thread_facet !== undefined && !isThreadFacet(thread_facet)) {
    throw new PersonalConnectorError(
      "invalid_config",
      "thread_facet is not a closed facet",
      400,
    );
  }
  return {
    ...(record_class ? { record_class } : {}),
    ...(thread_facet ? { thread_facet } : {}),
    ...(match.source?.trim() ? { source: match.source.trim() } : {}),
    ...(match.thread_id?.trim() ? { thread_id: match.thread_id.trim() } : {}),
  };
}

async function forceDisposition(
  authority: {
    getDisposition(eventId: string): Promise<ArrangementDecision | null>;
    putDisposition(decision: ArrangementDecision): Promise<void>;
  },
  event: EventRecord,
  disposition: ArrangementDecision["disposition"],
  reason: string,
  now: string,
): Promise<void> {
  const current = await authority.getDisposition(event.id);
  await authority.putDisposition({
    event_id: event.id,
    org_id: event.org_id,
    disposition,
    layer: current?.layer ?? "L1_event",
    reason_codes: [...new Set([...(current?.reason_codes ?? []), reason])],
    score: current?.score ?? 0.7,
    decided_at: now,
  });
}
