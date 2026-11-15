import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExecutorInstallation, ExecutorStore } from "./executor-installation";
import { currentJobOnSession } from "./job-control";
import type {
  Recipe,
  RecipeWrite,
  RecipeWriteResult,
  CancellationJob,
  ClaimCancellationJobs,
  CommitCancellationJobObservation,
  CommitCancellationJobObservationResult,
  RetryCancellationJob,
  RetryCancellationJobResult,
  RenewCancellationJob,
  SettleCancellationJob,
  WorkDelivery,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkRunStartCommand,
  WorkRunStartReplay,
  WorkStore,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
} from "./work";
import { isActiveWorkStatus } from "./work";
import type { WorkItemStatus } from "./work";
import {
  shouldFlushDelivery,
  isDeliveryLeaseExpired,
  assertWorkDeliveryWrite,
  planWorkDeliveryCommand,
  sameWorkDeliveryRetryCommand,
} from "./work-delivery";
import type { SearchAnswerRecord } from "./search-answer";
import {
  prepareWorkObservation,
  prepareCancellationJobObservation,
  workDeliveryLifecycleEvent,
  assertWorkItemVersionWrite,
  assertWorkItemStatusWrite,
  assertWorkRunExecutionIdentityWrite,
  assertWorkRunStartStateWrite,
  assertWorkRunStatusWrite,
  assertWorkRunVersionWrite,
  assertWorkRunSnapshot,
  assertWorkRunWrite,
  canClaimWorkRunStartItem,
  prepareWorkRunStartCheckpoint,
  prepareWorkRunStartFailure,
  prepareWorkDismissal,
  sameWorkDismissalCommand,
  sameWorkRunStartCommand,
  workRunStartCommand,
  prepareWorkItemCreation,
  prepareWorkItemObservation,
  workItemObservationLifecycleEvent,
  type WorkItemCreation,
  type WorkItemCreationResult,
  type WorkItemObservation,
  type WorkItemObservationResult,
  type WorkItemObservationLifecycleEvent,
  prepareWorkItemCreationAbort,
  type WorkItemCreationAbort,
  type WorkItemCreationAbortResult,
  type WorkDismissal,
  type WorkDismissalResult,
  prepareWorkAcknowledgment,
  assertWorkAcknowledgmentAttentionBinding,
  sameWorkAcknowledgmentCommand,
  type WorkAcknowledgment,
  type WorkAcknowledgmentResult,
  type WorkRunStartFailure,
  type WorkRunStartFailureResult,
  type WorkRunStartCheckpoint,
  type WorkRunStartCheckpointResult,
  type CommitWorkObservation,
  type CommitWorkObservationResult,
  workObservationLifecycleEvents,
  workRunStartLifecycleEvent,
  type WorkObservationLifecycleEvent,
  type WorkRunStartLifecycleEvent,
  type WorkDeliveryLifecycleEvent,
} from "./work-transition";

export class MemoryWorkStore implements WorkStore, ExecutorStore {
  private readonly recipes = new Map<string, Recipe>();
  private readonly items = new Map<string, WorkItem>();
  private readonly runs = new Map<string, WorkRun>();
  private readonly deliveries = new Map<string, WorkDelivery>();
  private readonly uiPrefs = new Map<string, string>();
  private readonly searchAnswers = new Map<string, SearchAnswerRecord>();
  private readonly dismissalCommands = new Map<string, { command: WorkDismissal; item: WorkItem }>();
  private readonly acknowledgmentCommands = new Map<string, { command: WorkAcknowledgment; item: WorkItem }>();
  private readonly currentWorkEvidence = new Set<string>();
  private readonly startCommands = new Map<string, { command: WorkRunStartCommand; run_id: string }>();
  private readonly deliveryRetryCommands = new Map<string, {
    command: Extract<WorkDeliveryCommand, { kind: "retry" | "reconcile" }>;
    delivery: WorkDelivery;
  }>();
  private readonly cancellationJobs = new Map<string, CancellationJob>();
  private readonly cancellationRetryCommands = new Map<string, {
    command: RetryCancellationJob;
    job_id: string;
  }>();
  private readonly observationEvents: WorkObservationLifecycleEvent[] = [];
  private readonly itemObservationEvents: WorkItemObservationLifecycleEvent[] = [];
  private readonly workRunStartEvents: WorkRunStartLifecycleEvent[] = [];
  private readonly deliveryLifecycleEvents: WorkDeliveryLifecycleEvent[] = [];
  private readonly executors = new Map<string, ExecutorInstallation>();

  protected snapshotWorkItemObservationState(): {
    items: Map<string, WorkItem>;
    eventCount: number;
  } {
    return {
      items: new Map([...this.items].map(([id, item]) => [id, structuredClone(item)])),
      eventCount: this.itemObservationEvents.length,
    };
  }

  protected restoreWorkItemObservationState(snapshot: {
    items: Map<string, WorkItem>;
    eventCount: number;
  }): void {
    this.items.clear();
    for (const [id, item] of snapshot.items) this.items.set(id, structuredClone(item));
    this.itemObservationEvents.length = snapshot.eventCount;
  }

  listWorkObservationEvents(): WorkObservationLifecycleEvent[] {
    return structuredClone(this.observationEvents);
  }

  listWorkItemObservationEvents(): WorkItemObservationLifecycleEvent[] {
    return structuredClone(this.itemObservationEvents);
  }

  listWorkRunStartLifecycleEvents(): WorkRunStartLifecycleEvent[] {
    return structuredClone(this.workRunStartEvents);
  }

  listWorkDeliveryLifecycleEvents(): WorkDeliveryLifecycleEvent[] {
    return structuredClone(this.deliveryLifecycleEvents);
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    return [...this.recipes.values()]
      .filter((recipe) => recipe.org_id === orgId)
      .map((recipe) => cloneRecipe(recipe));
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    const recipe = this.recipes.get(id);
    return recipe && recipe.org_id === orgId ? cloneRecipe(recipe) : null;
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    this.recipes.set(recipe.id, cloneRecipe(recipe));
    return cloneRecipe(recipe);
  }

  async putRecipeIfUnchanged(input: RecipeWrite): Promise<RecipeWriteResult> {
    if (
      input.expected_recipe &&
      (input.expected_recipe.id !== input.recipe.id ||
        input.expected_recipe.org_id !== input.recipe.org_id)
    ) {
      return { outcome: "conflict" };
    }
    const current = this.recipes.get(input.recipe.id);
    if (
      input.expected_recipe === null
        ? current !== undefined
        : !current || !isDeepStrictEqual(current, input.expected_recipe)
    ) {
      return { outcome: "conflict" };
    }
    const saved = cloneRecipe(input.recipe);
    this.recipes.set(saved.id, saved);
    return { outcome: "applied", recipe: cloneRecipe(saved) };
  }

  async advanceRecipePullSchedule(input: {
    expected_recipe: Recipe;
    next_run_at: string;
    updated_at: string;
  }): Promise<boolean> {
    const current = this.recipes.get(input.expected_recipe.id);
    if (!current || !isDeepStrictEqual(current, input.expected_recipe)) {
      return false;
    }
    this.recipes.set(current.id, {
      ...cloneRecipe(current),
      next_run_at: input.next_run_at,
      updated_at: input.updated_at,
    });
    return true;
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    const recipe = this.recipes.get(id);
    if (!recipe || recipe.org_id !== orgId) {
      return false;
    }
    this.recipes.delete(id);
    return true;
  }

  async listWorkItems(
    orgId: string,
    options?: { statuses?: readonly WorkItemStatus[] },
  ): Promise<WorkItem[]> {
    const allowed = options?.statuses ? new Set(options.statuses) : null;
    return [...this.items.values()]
      .filter(
        (item) =>
          item.org_id === orgId &&
          (allowed === null || allowed.has(item.status)),
      )
      .map((item) => ({ ...item }));
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    const item = this.items.get(id);
    return item && item.org_id === orgId ? { ...item } : null;
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    const found = currentJobOnSession(
      [...this.items.values()].filter((item) => item.org_id === orgId),
      threadId,
    );
    return found ? { ...found } : null;
  }

  async getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null> {
    const found = [...this.items.values()].find(
      (item) =>
        item.org_id === orgId &&
        item.thread_id === threadId &&
        item.unit_key === unitKey,
    );
    return found ? { ...found } : null;
  }

  hasUnsettledWorkForThread(orgId: string, threadId: string, updatedItem?: WorkItem): boolean {
    const items = [...this.items.values()].filter(
      (item) => item.org_id === orgId && item.thread_id === threadId,
    ).map((item) => item.id === updatedItem?.id ? updatedItem : item);
    if (items.some((item) =>
      item.status === "open" || item.status === "running" || item.status === "waiting_human"
      || item.status === "failed"
      || (item.status === "done" && (
        !item.current_run_id || !item.acknowledged_run_id
        || item.acknowledged_run_id !== item.current_run_id
      )),
    )) return true;
    const itemIds = new Set(items.map((item) => item.id));
    return [...this.deliveries.values()].some((delivery) =>
      delivery.org_id === orgId && itemIds.has(delivery.work_item_id)
      && delivery.status !== "acked",
    );
  }

  recordCurrentWorkEvidence(eventId: string): void {
    this.setCurrentWorkEvidence(eventId, true);
  }

  setCurrentWorkEvidence(eventId: string, isCurrentWork: boolean): void {
    if (isCurrentWork) this.currentWorkEvidence.add(eventId);
    else this.currentWorkEvidence.delete(eventId);
  }

  protected hasCurrentWorkEvidence(eventId: string, _orgId: string, _threadId: string): boolean {
    return this.currentWorkEvidence.has(eventId);
  }

  protected restoreAcknowledgedTriggerForManualRetry(
    _input: WorkRunStartClaim,
    _item: WorkItem,
  ): void {}

  protected hasAcknowledgmentTrigger(input: WorkAcknowledgment, _item: WorkItem | null): boolean {
    return this.currentWorkEvidence.has(input.trigger_event_id);
  }

  protected prepareAcknowledgmentEffects(input: WorkAcknowledgment, _item: WorkItem): () => void {
    if (input.conversation_attention) {
      throw new Error("Conversation attention acknowledgment requires an AuthorityStore");
    }
    return () => {};
  }

  protected prepareAcknowledgmentConflictEffects(input: WorkAcknowledgment): () => void {
    if (input.conversation_attention) {
      throw new Error("Conversation attention acknowledgment requires an AuthorityStore");
    }
    return () => {};
  }

  protected onWorkDismissed(_item: WorkItem, _now: string): void {}

  protected hasAcknowledgmentCommand(orgId: string, commandId: string): boolean {
    return this.acknowledgmentCommands.has(`${orgId}\0${commandId}`);
  }

  protected hasExternalAcknowledgmentConflict(_orgId: string, _commandId: string): boolean {
    return false;
  }

  async createWorkItem(input: WorkItemCreation): Promise<WorkItemCreationResult> {
    const result = prepareWorkItemCreation(input, {
      item_exists: this.items.has(input.item.id),
      recipe: this.recipes.get(input.recipe.id) ?? null,
      search_answer_exists: input.search_answer ? this.searchAnswers.has(input.search_answer.id) : false,
    });
    if (result.outcome !== "applied") return result;
    const saved = structuredClone(result);
    this.recipes.set(saved.recipe.id, saved.recipe);
    this.items.set(saved.item.id, saved.item);
    if (saved.search_answer) this.searchAnswers.set(saved.search_answer.id, saved.search_answer);
    return structuredClone(saved);
  }

  async observeWorkItem(input: WorkItemObservation): Promise<WorkItemObservationResult> {
    return structuredClone(this.observeWorkItemWithinTurn(input));
  }

  protected observeWorkItemWithinTurn(input: WorkItemObservation): WorkItemObservationResult {
    const orgId = input.item.org_id;
    const expected = input.expected_item;
    const expectedItem = expected && expected.org_id === orgId ? this.items.get(expected.id) ?? null : null;
    const currentItem = this.items.get(input.item.id) ?? null;
    const result = prepareWorkItemObservation(input, {
      expected_item: expectedItem?.org_id === orgId ? expectedItem : null,
      current_item: currentItem,
      unit_exists: [...this.items.values()].some((candidate) =>
        candidate.org_id === orgId && candidate.thread_id === input.item.thread_id
        && candidate.unit_key === input.item.unit_key && candidate.id !== input.item.id),
      trigger_is_current_work: Boolean(
        input.item.head_event_id &&
        this.hasCurrentWorkEvidence(input.item.head_event_id, orgId, input.item.thread_id),
      ),
    });
    if (result.outcome !== "applied") return result;
    this.items.set(result.item.id, structuredClone(result.item));
    this.itemObservationEvents.push(workItemObservationLifecycleEvent(expected, result.item));
    return result;
  }

  async abortWorkItemCreation(input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult> {
    const result = prepareWorkItemCreationAbort(input, {
      item: this.items.get(input.expected_item.id) ?? null,
      has_run: [...this.runs.values()].some((run) => run.org_id === input.expected_item.org_id
        && run.work_item_id === input.expected_item.id),
      has_delivery: [...this.deliveries.values()].some((delivery) => delivery.org_id === input.expected_item.org_id
        && delivery.work_item_id === input.expected_item.id),
      search_answer: [...this.searchAnswers.values()].find((answer) =>
        answer.org_id === input.expected_item.org_id && answer.work_item_id === input.expected_item.id) ?? null,
    });
    if (result.outcome !== "applied") return result;
    this.items.delete(result.item.id);
    if (result.search_answer) this.searchAnswers.delete(result.search_answer.id);
    return structuredClone(result);
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.org_id === orgId &&
          (workItemId === undefined || run.work_item_id === workItemId),
      )
      .map((run) => cloneRun(run));
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    const run = this.runs.get(id);
    return run && run.org_id === orgId ? cloneRun(run) : null;
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    const item = this.items.get(workItemId);
    if (!item || item.org_id !== orgId || !item.current_run_id) return null;
    const current = this.runs.get(item.current_run_id);
    return current && current.org_id === orgId && current.work_item_id === workItemId
      && (current.status === "running" || current.status === "waiting_human")
      ? cloneRun(current)
      : null;
  }

  async checkpointWorkRunStart(input: WorkRunStartCheckpoint): Promise<WorkRunStartCheckpointResult> {
    const item = this.items.get(input.expected_item.id);
    const run = this.runs.get(input.expected_run.id);
    const result = prepareWorkRunStartCheckpoint(input, {
      item: item?.org_id === input.expected_item.org_id ? item : null,
      run: run?.org_id === input.expected_item.org_id ? run : null,
    });
    if (result.outcome !== "applied") return result;
    const saved = structuredClone(result);
    const event = workRunStartLifecycleEvent(input, saved.run);
    if (event) this.workRunStartEvents.push(structuredClone(event));
    this.items.set(saved.item.id, saved.item);
    this.runs.set(saved.run.id, saved.run);
    if (saved.cancellation_requested) {
      this.enqueueCancellationJob(saved.run, input.now);
    }
    return structuredClone(saved);
  }

  async commitWorkObservation(input: CommitWorkObservation): Promise<CommitWorkObservationResult> {
    const { expected_item: expectedItem, expected_run: expectedRun } = input;
    const item = this.items.get(expectedItem.id);
    const run = this.runs.get(expectedRun.id);
    const delivery = [...this.deliveries.values()].find(
      (row) => row.org_id === expectedItem.org_id && row.work_item_id === expectedItem.id
        && (expectedRun.write_back_required === undefined ? !row.run_id : row.run_id === expectedRun.id),
    );
    const prepared = prepareWorkObservation(input, {
      item: item?.org_id === expectedItem.org_id ? item : null,
      run: run?.org_id === expectedItem.org_id ? run : null,
      delivery: delivery ?? null,
    });
    if (prepared.outcome !== "applied") return prepared;
    const nextRun = structuredClone(prepared.transition.run);
    const nextItem = { ...prepared.transition.item };
    const nextDelivery = prepared.delivery ? structuredClone(prepared.delivery) : undefined;
    if (nextDelivery) assertWorkDeliveryWrite(
      nextDelivery, this.deliveries.get(nextDelivery.id), nextRun, true,
    );
    if (nextDelivery) {
      nextDelivery.version = delivery
        ? (delivery.version ?? 0) + 1
        : prepared.delivery?.version ?? 0;
    }
    const events = workObservationLifecycleEvents(
      input, prepared.transition, delivery ?? null, nextDelivery,
    );
    const savedEvents = structuredClone(events);
    this.runs.set(nextRun.id, nextRun);
    this.items.set(nextItem.id, nextItem);
    if (nextDelivery) this.deliveries.set(nextDelivery.id, nextDelivery);
    this.observationEvents.push(...savedEvents);
    return { outcome: "applied", transition: prepared.transition };
  }

  async dismissWorkItem(input: WorkDismissal): Promise<WorkDismissalResult> {
    const commandKey = input.command_id === undefined
      ? undefined
      : `${input.expected_item.org_id}\0${input.command_id}`;
    if (commandKey !== undefined) {
      if (this.startCommands.has(commandKey) || this.deliveryRetryCommands.has(commandKey)
        || this.acknowledgmentCommands.has(commandKey)) {
        return { outcome: "conflict", reason: "stale_dismissal" };
      }
      const previous = this.dismissalCommands.get(commandKey);
      if (previous) {
        return sameWorkDismissalCommand(
          {
            work_item_id: previous.command.expected_item.id,
            expected_version:
              previous.command.expected_version ?? previous.command.expected_item.version ?? 0,
            fold_visibility: previous.command.fold_visibility !== false,
            issued_at: previous.command.issued_at,
          },
          input,
        )
          ? { outcome: "replayed", item: structuredClone(previous.item) }
          : { outcome: "conflict", reason: "stale_dismissal" };
      }
    }
    const item = this.items.get(input.expected_item.id);
    const result = prepareWorkDismissal(input, {
      item: item?.org_id === input.expected_item.org_id ? item : null,
      run: item?.current_run_id ? this.runs.get(item.current_run_id) ?? null : null,
      deliveries: [...this.deliveries.values()].filter((row) =>
        row.org_id === input.expected_item.org_id && row.work_item_id === input.expected_item.id && row.status !== "acked"),
      search_answer: input.search_answer_timeout
        ? this.searchAnswers.get(input.search_answer_timeout.id) ?? null : undefined,
    });
    if (result.outcome !== "applied") return result;
    for (const delivery of result.deliveries) assertWorkDeliveryWrite(
      delivery, this.deliveries.get(delivery.id),
      delivery.run_id ? this.runs.get(delivery.run_id) : undefined, true,
    );
    const saved = {
      ...structuredClone(result),
      deliveries: result.deliveries.map((delivery) => ({
        ...delivery,
        version: (this.deliveries.get(delivery.id)?.version ?? 0) + 1,
      })),
    };
    this.items.set(saved.item.id, saved.item);
    for (const delivery of saved.deliveries) this.deliveries.set(delivery.id, delivery);
    if (saved.search_answer) this.searchAnswers.set(saved.search_answer.id, saved.search_answer);
    if (input.fold_visibility !== false) this.onWorkDismissed(saved.item, input.now);
    if (saved.run) this.enqueueCancellationJob(saved.run, input.now);
    if (commandKey !== undefined) {
      this.dismissalCommands.set(commandKey, {
        command: structuredClone(input),
        item: structuredClone(saved.item),
      });
    }
    return structuredClone(saved);
  }

  private enqueueCancellationJob(run: WorkRun, now: string): void {
    if ((run.status !== "running" && run.status !== "waiting_human")
      || (!run.external_run_id && !run.agent_thread_id)
      || [...this.cancellationJobs.values()].some((job) =>
        job.org_id === run.org_id && job.run_id === run.id)) return;
    const eventId = randomUUID();
    const job: CancellationJob = {
      id: randomUUID(),
      org_id: run.org_id,
      event_id: eventId,
      job_type: "cancel_execution",
      run_id: run.id,
      schema_version: 1,
      status: "pending",
      attempts: 0,
      created_at: now,
      updated_at: now,
    };
    this.cancellationJobs.set(job.id, job);
  }

  async claimCancellationJobs(input: ClaimCancellationJobs): Promise<CancellationJob[]> {
    assertCancellationClaim(input);
    const jobs = [...this.cancellationJobs.values()]
      .filter((job) => job.org_id === input.org_id && (
        job.status === "pending"
        || (job.status === "failed" && (!job.next_retry_at || job.next_retry_at <= input.now))
        || (job.status === "running" && (job.lease_expires_at ?? "") <= input.now)
      ))
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
      .slice(0, input.limit);
    for (const job of this.cancellationJobs.values()) {
      if (job.org_id === input.org_id && job.status === "running"
        && (job.lease_expires_at ?? "") <= input.now && job.attempts >= 5) {
        Object.assign(job, {
          status: "dead",
          lease_owner: undefined,
          claim_token: undefined,
          lease_expires_at: undefined,
          last_error_code: "retry_exhausted",
          outcome_code: "retry_exhausted",
          completed_at: input.now,
          updated_at: input.now,
        });
      }
    }
    for (const job of jobs) {
      if (job.attempts >= 5) continue;
      Object.assign(job, {
        status: "running",
        attempts: job.attempts + 1,
        lease_owner: input.owner,
        claim_token: randomUUID(),
        lease_expires_at: new Date(Date.parse(input.now) + input.lease_ms).toISOString(),
        next_retry_at: undefined,
        last_error_code: undefined,
        last_error: undefined,
        outcome_code: undefined,
        completed_at: undefined,
        updated_at: input.now,
      });
    }
    return jobs.filter((job) => job.status === "running").map((job) => structuredClone(job));
  }

  async renewCancellationJob(input: RenewCancellationJob): Promise<boolean> {
    assertCancellationLease(input);
    const job = this.cancellationJobs.get(input.id);
    if (!job || job.org_id !== input.org_id || job.status !== "running"
      || job.lease_owner !== input.owner || job.claim_token !== input.claim_token
      || !job.lease_expires_at || job.lease_expires_at <= input.now) return false;
    job.lease_expires_at = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    job.updated_at = input.now;
    return true;
  }

  async settleCancellationJob(input: SettleCancellationJob): Promise<boolean> {
    assertCancellationLease(input);
    const job = this.cancellationJobs.get(input.id);
    if (!hasCancellationLease(job, input)) return false;
    if (input.kind === "succeeded") {
      Object.assign(job, {
        status: "succeeded",
        lease_owner: undefined,
        claim_token: undefined,
        lease_expires_at: undefined,
        next_retry_at: undefined,
        outcome_code: input.outcome_code,
        completed_at: input.now,
        updated_at: input.now,
      });
    } else {
      const exhausted = job.attempts >= 5;
      Object.assign(job, {
        status: exhausted ? "dead" : "failed",
        lease_owner: undefined,
        claim_token: undefined,
        lease_expires_at: undefined,
        next_retry_at: exhausted ? undefined : input.next_retry_at,
        last_error_code: input.error_code.slice(0, 120),
        last_error: input.error.slice(0, 1000),
        outcome_code: exhausted ? "retry_exhausted" : undefined,
        completed_at: exhausted ? input.now : undefined,
        updated_at: input.now,
      });
    }
    return true;
  }

  async commitCancellationJobObservation(
    input: CommitCancellationJobObservation,
  ): Promise<CommitCancellationJobObservationResult> {
    const job = this.cancellationJobs.get(input.id);
    if (!hasCancellationLease(job, input)) return { outcome: "conflict" };
    const run = this.runs.get(input.expected_run.id);
    const item = run ? this.items.get(run.work_item_id) : undefined;
    if (!run || !item || item.org_id !== input.org_id
      || item.status !== "skipped" || item.current_run_id !== run.id
      || job.run_id !== run.id || run.org_id !== input.org_id) {
      return { outcome: "conflict" };
    }
    const prepared = prepareCancellationJobObservation(input, run);
    if (prepared.outcome === "conflict") return prepared;
    if (prepared.outcome === "already_terminal") {
      Object.assign(job, completedCancellationJob(job, input.now, "already_finished"));
      return prepared;
    }
    this.runs.set(prepared.run.id, structuredClone(prepared.run));
    Object.assign(job, completedCancellationJob(job, input.now, `observed_${prepared.run.status}`));
    this.observationEvents.push({
      thread_id: item.thread_id,
      aggregate_type: "work_run",
      aggregate_id: prepared.run.id,
      aggregate_version: prepared.run.version ?? 0,
      event_type: "work_run_transitioned",
      dedupe_key: JSON.stringify([
        "work_run", prepared.run.id, prepared.run.version ?? 0, "work_run_transitioned",
      ]),
      payload: {
        work_item_id: item.id,
        run_id: prepared.run.id,
        from_status: run.status,
        to_status: prepared.run.status,
      },
    });
    return prepared;
  }

  async listCancellationJobs(
    orgId: string,
    limit = 100,
    statuses?: CancellationJob["status"][],
  ): Promise<CancellationJob[]> {
    return [...this.cancellationJobs.values()]
      .filter((job) => job.org_id === orgId && (!statuses || statuses.includes(job.status)))
      .sort((left, right) => statuses
        ? right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)
        : left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
      .slice(0, Number.isSafeInteger(limit) ? Math.max(0, Math.min(500, limit)) : 100)
      .map((job) => structuredClone(job));
  }

  async retryCancellationJob(
    input: RetryCancellationJob,
  ): Promise<RetryCancellationJobResult> {
    if (!Number.isSafeInteger(input.expected_attempts) || input.expected_attempts < 0
      || !input.command_id.trim() || input.command_id !== input.command_id.trim()
      || input.command_id.length > 128 || !Number.isFinite(Date.parse(input.issued_at))) {
      throw new Error("Invalid cancellation job retry command");
    }
    const commandKey = `${input.org_id}\0${input.command_id}`;
    const previous = this.cancellationRetryCommands.get(commandKey);
    if (previous) {
      if (previous.command.id !== input.id
        || previous.command.expected_attempts !== input.expected_attempts
        || previous.command.issued_at !== input.issued_at) {
        return { outcome: "conflict" };
      }
      const replayed = this.cancellationJobs.get(previous.job_id);
      return replayed
        ? { outcome: "replayed", job: structuredClone(replayed) }
        : { outcome: "not_found" };
    }
    if (this.startCommands.has(commandKey) || this.dismissalCommands.has(commandKey)
      || this.acknowledgmentCommands.has(commandKey) || this.deliveryRetryCommands.has(commandKey)) {
      return { outcome: "conflict" };
    }
    const job = this.cancellationJobs.get(input.id);
    if (!job || job.org_id !== input.org_id) return { outcome: "not_found" };
    if (job.status !== "dead" || job.attempts !== input.expected_attempts) {
      return { outcome: "conflict" };
    }
    job.status = "pending";
    job.attempts = 0;
    delete job.lease_owner;
    delete job.claim_token;
    delete job.lease_expires_at;
    delete job.next_retry_at;
    delete job.last_error_code;
    delete job.last_error;
    delete job.outcome_code;
    delete job.completed_at;
    job.updated_at = input.issued_at;
    this.cancellationRetryCommands.set(commandKey, {
      command: structuredClone(input),
      job_id: job.id,
    });
    return { outcome: "applied", job: structuredClone(job) };
  }

  async acknowledgeWorkResult(input: WorkAcknowledgment): Promise<WorkAcknowledgmentResult> {
    assertWorkAcknowledgmentAttentionBinding(input);
    const key = `${input.expected_item.org_id}\0${input.command_id}`;
    if (this.startCommands.has(key) || this.dismissalCommands.has(key)
      || this.deliveryRetryCommands.has(key) || this.cancellationRetryCommands.has(key)
      || this.hasExternalAcknowledgmentConflict(input.expected_item.org_id, input.command_id)) {
      this.prepareAcknowledgmentConflictEffects(input)();
      return { outcome: "conflict", reason: "command_conflict" };
    }
    const previous = this.acknowledgmentCommands.get(key);
    if (previous) {
      this.prepareAcknowledgmentConflictEffects(input)();
      return sameWorkAcknowledgmentCommand(previous.command, input)
        ? { outcome: "replayed", item: structuredClone(previous.item) }
        : { outcome: "conflict", reason: "command_conflict" };
    }
    const currentItem = this.items.get(input.expected_item.id);
    const item = currentItem?.org_id === input.expected_item.org_id ? currentItem : null;
    const run = item?.current_run_id ? this.runs.get(item.current_run_id) ?? null : null;
    const delivery = item ? [...this.deliveries.values()].find((row) =>
      row.org_id === item.org_id && row.work_item_id === item.id && row.run_id === input.run_id) ?? null : null;
    const result = prepareWorkAcknowledgment(input, {
      item,
      run,
      delivery,
      trigger_is_current_work: this.hasAcknowledgmentTrigger(input, item),
    });
    if (result.outcome !== "applied") {
      this.prepareAcknowledgmentConflictEffects(input)();
      return result;
    }
    const saved = structuredClone(result.item);
    const savedCommand = structuredClone(input);
    const applyEffects = this.prepareAcknowledgmentEffects(input, saved);
    this.items.set(saved.id, saved);
    this.currentWorkEvidence.delete(input.trigger_event_id);
    this.acknowledgmentCommands.set(key, { command: savedCommand, item: saved });
    applyEffects();
    return { outcome: "applied", item: structuredClone(saved) };
  }

  async recordWorkRunStartFailure(input: WorkRunStartFailure): Promise<WorkRunStartFailureResult> {
    const { run } = input;
    const item = this.items.get(run.work_item_id);
    const result = prepareWorkRunStartFailure(input, {
      item: item?.org_id === run.org_id ? item : null,
      recipe_exists: this.recipes.get(run.recipe_id)?.org_id === run.org_id,
      active_run: [...this.runs.values()].some((row) =>
        row.org_id === run.org_id && row.work_item_id === run.work_item_id
        && (row.status === "running" || row.status === "waiting_human")),
      unresolved_delivery: [...this.deliveries.values()].some((row) =>
        row.org_id === run.org_id && row.work_item_id === run.work_item_id && row.status !== "acked"),
    });
    if (result.outcome !== "applied") return result;
    if (this.runs.has(run.id)) throw new Error(`Work run already exists: ${run.id}`);
    this.runs.set(run.id, cloneRun(result.run));
    this.items.set(result.item.id, structuredClone(result.item));
    return result;
  }

  async claimWorkRunStart(input: WorkRunStartClaim): Promise<boolean> {
    const { run, max_concurrent } = input;
    assertWorkRunSnapshot(run);
    const command = workRunStartCommand(input);
    const commandKey = command ? `${command.org_id}\0${command.command_id}` : undefined;
    if (commandKey && (
      this.startCommands.has(commandKey) ||
      this.dismissalCommands.has(commandKey) ||
      this.deliveryRetryCommands.has(commandKey) ||
      this.acknowledgmentCommands.has(commandKey)
    )) return false;
    const item = this.items.get(run.work_item_id);
    const recipe = this.recipes.get(run.recipe_id);
    const triggerIsCurrentWork = Boolean(
      item?.head_event_id &&
      this.hasCurrentWorkEvidence(item.head_event_id, run.org_id, item.thread_id),
    );
    const visibilityVersion = item
      ? this.conversationVisibilityVersion(run.org_id, item.thread_id)
      : 0;
    if (
      !item || !canClaimWorkRunStartItem(input, item, triggerIsCurrentWork) || recipe?.org_id !== run.org_id ||
      (input.expected_recipe !== undefined &&
        (input.expected_recipe.id !== run.recipe_id ||
          input.expected_recipe.org_id !== run.org_id ||
          !isDeepStrictEqual(recipe, input.expected_recipe))) ||
      (input.visibility_intent_version !== undefined &&
        visibilityVersion !== input.visibility_intent_version) ||
      [...this.deliveries.values()].some((delivery) =>
        delivery.org_id === run.org_id && delivery.work_item_id === item.id && delivery.status !== "acked") ||
      [...this.runs.values()].some((current) =>
        current.org_id === run.org_id && current.work_item_id === item.id &&
        (current.status === "running" || current.status === "waiting_human"))
    ) {
      return false;
    }
    const occupied = [...this.items.values()].filter((current) =>
      current.org_id === run.org_id && current.recipe_id === run.recipe_id &&
      (current.status === "running" || current.status === "waiting_human")).length;
    if (max_concurrent !== undefined && occupied >= max_concurrent) {
      return false;
    }
    if (this.runs.has(run.id)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    if (input.retry === "manual" && item.current_run_id
      && item.acknowledged_run_id === item.current_run_id) {
      this.restoreAcknowledgedTriggerForManualRetry(input, item);
    }
    this.runs.set(run.id, { ...cloneRun(run), version: run.version ?? 0 });
    this.items.set(item.id, {
      ...item,
      status: "running",
      recipe_id: run.recipe_id,
      current_run_id: run.id,
      acknowledged_run_id: undefined,
      visibility_intent_version:
        input.visibility_intent_version ?? item.visibility_intent_version ?? 0,
      version: (item.version ?? 0) + 1,
      updated_at: run.updated_at,
    });
    if (command && commandKey) {
      this.startCommands.set(commandKey, { command: structuredClone(command), run_id: run.id });
    }
    return true;
  }

  async getWorkRunStartReplay(command: WorkRunStartCommand): Promise<WorkRunStartReplay> {
    const commandKey = `${command.org_id}\0${command.command_id}`;
    if (this.deliveryRetryCommands.has(commandKey) || this.dismissalCommands.has(commandKey)
      || this.acknowledgmentCommands.has(commandKey)) {
      return { outcome: "conflict" };
    }
    const previous = this.startCommands.get(commandKey);
    if (!previous) return { outcome: "not_found" };
    if (!sameWorkRunStartCommand(previous.command, command)
      || previous.command.org_id !== command.org_id) {
      return { outcome: "conflict" };
    }
    const run = this.runs.get(previous.run_id);
    if (!run || run.org_id !== command.org_id || run.work_item_id !== command.work_item_id) {
      throw new Error("Reserved work start command references a missing or mismatched run");
    }
    return { outcome: "replayed", run: cloneRun(run) };
  }

  protected conversationVisibilityVersion(_orgId: string, _threadId: string): number {
    return 0;
  }

  async listHiddenExecutorThreadIds(orgId: string): Promise<string[]> {
    const sources = new Set(
      [...this.items.values()]
        .filter((item) => item.org_id === orgId)
        .map((item) => item.thread_id),
    );
    const hidden = new Set<string>();
    for (const run of this.runs.values()) {
      if (
        run.org_id === orgId &&
        run.agent_thread_id &&
        !sources.has(run.agent_thread_id)
      ) {
        hidden.add(run.agent_thread_id);
      }
    }
    return [...hidden];
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return [...this.deliveries.values()]
      .filter((item) => item.org_id === orgId)
      .map((item) => cloneDelivery(item));
  }

  async listDueWorkDeliveries(
    orgId: string,
    now: string,
  ): Promise<WorkDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (item) => item.org_id === orgId && Boolean(item.payload)
          && (shouldFlushDelivery(item, now) || isDeliveryLeaseExpired(item, now)),
      )
      .map((item) => cloneDelivery(item));
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    const item = this.deliveries.get(id);
    return item && item.org_id === orgId ? cloneDelivery(item) : null;
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    const found = [...this.deliveries.values()].find(
      (row) => row.org_id === orgId && row.work_item_id === workItemId
        && (row.run_id
          ? row.run_id === this.items.get(workItemId)?.current_run_id
          : this.runs.get(this.items.get(workItemId)?.current_run_id ?? "")?.write_back_required === undefined),
    );
    return found ? cloneDelivery(found) : null;
  }

  async transitionWorkDelivery(input: WorkDeliveryCommand): Promise<WorkDeliveryCommandResult> {
    let commandKey: string | undefined;
    if (input.kind === "retry" || input.kind === "reconcile") {
      commandKey = `${input.org_id}\0${input.command_id}`;
      const previous = this.deliveryRetryCommands.get(commandKey);
      if (previous) {
        return sameWorkDeliveryRetryCommand(previous.command, input)
          ? { outcome: "replayed", delivery: cloneDelivery(previous.delivery) }
          : { outcome: "conflict", reason: "not_claimable" };
      }
      if (this.startCommands.has(commandKey) || this.dismissalCommands.has(commandKey)
        || this.acknowledgmentCommands.has(commandKey)) {
        return { outcome: "conflict", reason: "not_claimable" };
      }
    }
    const current = this.deliveries.get(input.delivery_id);
    const delivery = current?.org_id === input.org_id ? current : null;
    const item = delivery ? this.items.get(delivery.work_item_id) : undefined;
    if ((input.kind === "retry" || input.kind === "reconcile") &&
      item?.version !== input.expected_item_version) {
      return { outcome: "conflict", reason: "not_claimable" };
    }
    let result = planWorkDeliveryCommand(delivery,
      item?.org_id === input.org_id ? item.status : undefined, input);
    if (result.outcome === "applied") {
      const savedDelivery = {
        ...result.delivery,
        version: (delivery?.version ?? 0) + 1,
      };
      result = { ...result, delivery: savedDelivery };
      if (delivery && item?.org_id === input.org_id) {
        const event = workDeliveryLifecycleEvent({
          thread_id: item.thread_id,
          previous: delivery,
          next: savedDelivery,
          command: input,
          aggregate_version: this.deliveryLifecycleEvents.filter(
            (saved) => saved.aggregate_id === savedDelivery.id,
          ).length + 1,
        });
        if (event) this.deliveryLifecycleEvents.push(structuredClone(event));
      }
      this.deliveries.set(savedDelivery.id, cloneDelivery(savedDelivery));
      if (commandKey !== undefined && (input.kind === "retry" || input.kind === "reconcile")) {
        this.deliveryRetryCommands.set(commandKey, {
          command: structuredClone(input),
          delivery: cloneDelivery(savedDelivery),
        });
      }
    }
    return structuredClone(result);
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    return this.uiPrefs.get(`${orgId}\0${key}`) ?? null;
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    _updatedAt: string,
  ): Promise<void> {
    this.uiPrefs.set(`${orgId}\0${key}`, value);
  }

  async getSearchAnswer(
    orgId: string,
    id: string,
  ): Promise<SearchAnswerRecord | null> {
    const record = this.searchAnswers.get(id);
    return record?.org_id === orgId ? structuredClone(record) : null;
  }

  async putSearchAnswer(
    record: SearchAnswerRecord,
  ): Promise<SearchAnswerRecord> {
    const current = this.searchAnswers.get(record.id);
    if (current && (current.org_id !== record.org_id
      || current.work_item_id !== record.work_item_id
      || current.outcome !== record.outcome)) {
      throw new Error("Search answer identity and outcome cannot be changed through ordinary writes");
    }
    const saved = { ...record, created_at: current?.created_at ?? record.created_at };
    this.searchAnswers.set(record.id, structuredClone(saved));
    return structuredClone(saved);
  }

  async deleteSearchAnswer(orgId: string, id: string): Promise<boolean> {
    const record = this.searchAnswers.get(id);
    return record?.org_id === orgId && this.searchAnswers.delete(id);
  }

  async listExecutorInstallations(orgId: string): Promise<ExecutorInstallation[]> {
    return [...this.executors.values()]
      .filter((item) => item.org_id === orgId)
      .map((item) => cloneExecutor(item));
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    const item = this.executors.get(id);
    return item && item.org_id === orgId ? cloneExecutor(item) : null;
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    this.executors.set(installation.id, cloneExecutor(installation));
    return cloneExecutor(installation);
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    const item = this.executors.get(id);
    if (!item || item.org_id !== orgId) {
      return false;
    }
    this.executors.delete(id);
    return true;
  }

  dropOperationalWork(orgId: string): number {
    let count = 0;
    for (const key of this.startCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) this.startCommands.delete(key);
    }
    for (const key of this.dismissalCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) this.dismissalCommands.delete(key);
    }
    for (const key of this.acknowledgmentCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) this.acknowledgmentCommands.delete(key);
    }
    for (const key of this.deliveryRetryCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) this.deliveryRetryCommands.delete(key);
    }
    for (const [id, item] of [...this.items]) {
      if (item.org_id === orgId) {
        this.items.delete(id);
        count += 1;
      }
    }
    for (const [id, run] of [...this.runs]) {
      if (run.org_id === orgId) {
        this.runs.delete(id);
      }
    }
    for (const [id, delivery] of [...this.deliveries]) {
      if (delivery.org_id === orgId) {
        this.deliveries.delete(id);
      }
    }
    for (const [id, job] of [...this.cancellationJobs]) {
      if (job.org_id === orgId) this.cancellationJobs.delete(id);
    }
    for (const key of this.cancellationRetryCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) this.cancellationRetryCommands.delete(key);
    }
    return count;
  }

  workItemCount(orgId: string): number {
    return [...this.items.values()].filter((item) => item.org_id === orgId).length;
  }

  recipeCount(orgId: string): number {
    return [...this.recipes.values()].filter((recipe) => recipe.org_id === orgId)
      .length;
  }

  executorCount(orgId: string): number {
    return [...this.executors.values()].filter((item) => item.org_id === orgId)
      .length;
  }

  activeItems(orgId: string): WorkItem[] {
    return [...this.items.values()].filter(
      (item) => item.org_id === orgId && isActiveWorkStatus(item.status),
    );
  }
}

function cloneRecipe(recipe: Recipe): Recipe {
  return {
    ...recipe,
    match: { ...recipe.match },
    executor_config: { ...recipe.executor_config },
  };
}

function cloneRun(run: WorkRun): WorkRun {
  return {
    ...run,
    result: run.result ? structuredClone(run.result) : undefined,
    ...(run.write_back_target ? { write_back_target: { ...run.write_back_target } } : {}),
  };
}

function cloneDelivery(delivery: WorkDelivery): WorkDelivery {
  return {
    ...delivery,
    ...(delivery.target ? { target: { ...delivery.target } } : {}),
    payload: delivery.payload
      ? {
          summary: delivery.payload.summary,
          ...(delivery.payload.content
            ? { content: structuredClone(delivery.payload.content) }
            : {}),
        }
      : undefined,
    channel_receipt: delivery.channel_receipt
      ? { ...delivery.channel_receipt }
      : undefined,
  };
}

function cloneExecutor(item: ExecutorInstallation): ExecutorInstallation {
  return {
    ...item,
    config: { ...item.config },
  };
}

function assertCancellationClaim(input: ClaimCancellationJobs): void {
  assertCancellationLease(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
    throw new Error("Invalid cancellation job claim");
  }
}

function assertCancellationLease(input: {
  org_id: string;
  id?: string;
  owner: string;
  claim_token?: string;
  now: string;
}): void {
  if (!input.org_id.trim() || !input.owner.trim()
    || (input.id !== undefined && !input.id.trim())
    || (input.claim_token !== undefined && !input.claim_token.trim())
    || !Number.isFinite(Date.parse(input.now))) {
    throw new Error("Invalid cancellation job lease identity");
  }
}

function hasCancellationLease(
  job: CancellationJob | undefined,
  input: { org_id: string; id: string; owner: string; claim_token: string; now: string },
): job is CancellationJob {
  return Boolean(job && job.org_id === input.org_id && job.id === input.id
    && job.status === "running" && job.lease_owner === input.owner
    && job.claim_token === input.claim_token && job.lease_expires_at
    && job.lease_expires_at > input.now);
}

function completedCancellationJob(
  job: CancellationJob,
  now: string,
  outcome_code: string,
): Partial<CancellationJob> {
  return {
    status: "succeeded",
    lease_owner: undefined,
    claim_token: undefined,
    lease_expires_at: undefined,
    next_retry_at: undefined,
    outcome_code,
    completed_at: now,
    updated_at: now,
  };
}
