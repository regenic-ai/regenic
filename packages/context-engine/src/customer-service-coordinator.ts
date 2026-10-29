import { createHash, randomUUID } from "node:crypto";
import {
  bodyTextFromStored,
  canonicalContextJson,
  type ActorRef,
  type AuthorityStore,
  type BlobStore,
  type BusinessEvidence,
  type BusinessFieldValue,
  type ContextAuthorityRead,
  type ContextAuthorityReader,
  type ContextEngine,
  type CustomerContextContinuation,
  type CustomerContextEvidence,
  type CustomerReplyClaim,
  type CustomerResolvedValue,
  type CustomerServiceTask,
  type CustomerServiceTaskStatus,
  type CustomerServiceTaskStore,
  type CustomerTaskBrief,
  type CustomerTaskMember,
  validateBusinessEvidence,
} from "@regenic/domain";

const MAX_CONTEXT_ITEMS = 100;
const DEFAULT_CONTEXT_ITEMS = 40;
const CONTINUATION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_NEIGHBOR_COUNT = 4;

export interface CustomerBusinessQuery {
  task_id: string;
  brief_version: number;
  customer_id: string;
  project_id: string;
  batch_id: string;
  members: Array<{ member_key: string; business_id: string }>;
  fields: string[];
  query_at: string;
  page?: string;
}

export interface CustomerBusinessGateway {
  readonly id: string;
  query(input: CustomerBusinessQuery): Promise<BusinessEvidence>;
}

export class CustomerServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "invalid_state"
      | "context_changed"
      | "cursor_expired"
      | "business_unavailable"
      | "coverage_incomplete"
      | "review_required",
    message: string,
  ) {
    super(message);
    this.name = "CustomerServiceError";
  }
}

export interface CustomerServiceCoordinatorOptions {
  org_id: string;
  principal: ActorRef;
  authority: AuthorityStore;
  context_authority: ContextAuthorityReader;
  blobs: BlobStore;
  context: ContextEngine;
  tasks: CustomerServiceTaskStore;
  business: CustomerBusinessGateway;
  now?: () => string;
  create_id?: () => string;
}

export class CustomerServiceCoordinator {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: CustomerServiceCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.create_id ?? randomUUID;
  }

  async createTask(input: {
    source_event_id: string;
    content_hash: string;
    question?: string;
    query_at?: string;
  }): Promise<CustomerServiceTask> {
    const eventId = required(input.source_event_id, "source_event_id");
    const contentHash = requiredHash(input.content_hash);
    const event = await this.options.authority.getEvent(this.options.org_id, eventId);
    if (!event || event.content_hash !== contentHash || !event.thread_id) {
      throw new CustomerServiceError("not_found", "The triggering message is no longer current and readable");
    }
    const current = await this.options.authority.findBySourceIdentity({
      org_id: this.options.org_id,
      source: event.source,
      external_id: event.external_id,
    });
    if (!current || current.id !== event.id || current.operation === "tombstone") {
      throw new CustomerServiceError("not_found", "The triggering message was revised or removed");
    }
    const text = await this.eventText(event.content_hash);
    const question = input.question === undefined
      ? text.trim()
      : required(input.question, "question");
    if (!text.includes(question)) {
      throw new CustomerServiceError("invalid_request", "question must be present in the triggering message");
    }
    const createdAt = this.now();
    const task: CustomerServiceTask = {
      schema_version: "1.0",
      id: this.createId(),
      org_id: this.options.org_id,
      status: "resolving_context",
      revision: 1,
      brief: {
        version: 1,
        question,
        source: {
          event_id: event.id,
          content_hash: contentHash,
          thread_id: event.thread_id,
          source: event.source,
          external_id: event.external_id,
          received_at: event.occurred_at,
        },
        customer: unresolved(),
        project: unresolved(),
        batch: unresolved(),
        intent: unresolved(),
        query_at: input.query_at === undefined
          ? createdAt
          : timestamp(input.query_at, "query_at"),
        members_closed: false,
        members: [],
        requested_fields: [],
        unresolved: ["customer", "project", "batch", "intent", "members", "requested_fields"],
        context_snapshot_ids: [],
      },
      context_evidence: [],
      continuations: [],
      business_evidence: [],
      created_at: createdAt,
      updated_at: createdAt,
    };
    return this.options.tasks.putCustomerServiceTask(task);
  }

  async getTask(taskId: string): Promise<CustomerServiceTask> {
    const task = await this.options.tasks.getCustomerServiceTask(
      this.options.org_id,
      required(taskId, "task_id"),
    );
    if (!task) {
      throw new CustomerServiceError("not_found", "Customer service task was not found");
    }
    return task;
  }

  async listTasks(input: {
    statuses?: CustomerServiceTaskStatus[];
    limit?: number;
  } = {}): Promise<CustomerServiceTask[]> {
    if (input.statuses?.some((status) => ![
      "resolving_context",
      "ready_for_query",
      "querying",
      "verifying",
      "awaiting_review",
      "approved",
      "sending",
      "sent",
      "needs_clarification",
      "needs_human",
      "failed",
    ].includes(status))) {
      throw new CustomerServiceError("invalid_request", "Unknown customer task status");
    }
    return this.options.tasks.listCustomerServiceTasks({
      org_id: this.options.org_id,
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
      limit: boundedInteger(input.limit ?? 50, "limit", 1, 100),
    });
  }

  async searchContext(taskId: string, input: {
    query: string;
    objective?: string;
    max_items?: number;
    neighbor_count?: number;
    include_related?: boolean;
  }): Promise<{
    task: CustomerServiceTask;
    evidence: CustomerContextEvidence[];
    continuations: CustomerContextContinuation[];
    snapshot_id: string;
    degradation_flags: string[];
    completeness: {
      message_content: "complete_or_explicitly_omitted";
      local_read_scope: "bounded";
      source_sync: "unknown";
    };
    budget: { returned_items: number; max_items: number };
  }> {
    const task = await this.getTask(taskId);
    this.requireMutable(task);
    const query = required(input.query, "query");
    const maxItems = boundedInteger(input.max_items ?? DEFAULT_CONTEXT_ITEMS, "max_items", 1, MAX_CONTEXT_ITEMS);
    const neighbors = boundedInteger(input.neighbor_count ?? DEFAULT_NEIGHBOR_COUNT, "neighbor_count", 0, 12);
    const includeRelated = input.include_related ?? false;
    if (includeRelated && (
      task.brief.customer.status !== "verified"
      || !task.brief.customer.value
      || task.brief.project.status !== "verified"
      || !task.brief.project.value
    )) {
      throw new CustomerServiceError(
        "invalid_state",
        "Related-conversation search requires verified customer and project scope",
      );
    }
    const scopedQuery = includeRelated
      ? `${task.brief.customer.value} ${task.brief.project.value} ${query}`
      : query;
    const assembled = await this.options.context.assemble({
      schema_version: "1.0",
      id: this.createId(),
      org_id: this.options.org_id,
      principal: structuredClone(this.options.principal),
      consumer_id: "customer-service-agent",
      purpose: `resolve customer task${input.objective ? `: ${required(input.objective, "objective")}` : ""}`,
      allowed_uses: ["reason", "draft"],
      query: scopedQuery,
      ...(includeRelated ? {} : {
        anchors: [
          { kind: "event" as const, id: task.brief.source.event_id },
          { kind: "conversation" as const, id: task.brief.source.thread_id },
        ],
        filters: { thread_ids: [task.brief.source.thread_id] },
      }),
      temporal: { mode: "current" },
      budget: {
        profile: "customer-service-context-v1",
        max_tokens: 8_000,
        max_items: Math.min(maxItems, 20),
        max_raw_evidence: Math.min(maxItems, 20),
      },
      requested_kinds: ["event"],
    });
    const seeds = assembled.bundle.sections.flatMap((section) => section.items)
      .filter((item) => item.kind === "event" && item.content_hash && item.text)
      .map((item) => ({
        event_id: item.resource_id,
        content_hash: item.content_hash!,
      }));
    if (!seeds.some((seed) => seed.event_id === task.brief.source.event_id)) {
      seeds.unshift({
        event_id: task.brief.source.event_id,
        content_hash: task.brief.source.content_hash,
      });
    }
    const seedsByThread = new Map<string, string[]>();
    for (const seed of seeds) {
      const event = seed.event_id === task.brief.source.event_id
        ? { thread_id: task.brief.source.thread_id }
        : await this.options.authority.getEvent(this.options.org_id, seed.event_id);
      if (!event?.thread_id) continue;
      const group = seedsByThread.get(event.thread_id) ?? [];
      group.push(seed.event_id);
      seedsByThread.set(event.thread_id, group);
    }
    const orderedThreads = [
      task.brief.source.thread_id,
      ...[...seedsByThread.keys()].filter((threadId) => threadId !== task.brief.source.thread_id),
    ].slice(0, 4);
    const expanded = {
      evidence: [] as CustomerContextEvidence[],
      continuations: [] as CustomerContextContinuation[],
    };
    let remainingItems = maxItems;
    for (let index = 0; index < orderedThreads.length && remainingItems > 0; index += 1) {
      const threadId = orderedThreads[index];
      const remainingThreads = orderedThreads.length - index;
      const threadBudget = Math.max(1, Math.floor(remainingItems / remainingThreads));
      const window = await this.expandThread(
        threadId,
        seedsByThread.get(threadId) ?? [task.brief.source.event_id],
        assembled.snapshot.id,
        threadBudget,
        neighbors,
        "neighbor",
      );
      expanded.evidence.push(...window.evidence);
      expanded.continuations.push(...window.continuations);
      remainingItems -= window.evidence.length;
    }
    const seedIds = new Set(seeds.map((seed) => seed.event_id));
    const replyTargetIds = new Set(expanded.evidence.flatMap((item) =>
      item.reply_to_event_id ? [item.reply_to_event_id] : []));
    for (const item of expanded.evidence) {
      if (item.event_id === task.brief.source.event_id) {
        item.selection_reason = "source";
      } else if (seedIds.has(item.event_id)) {
        item.selection_reason = "hit";
      } else if (replyTargetIds.has(item.event_id)) {
        item.selection_reason = "reply_target";
      }
    }
    const saved = await this.update(task, (current) => ({
      ...current,
      status: "resolving_context",
      brief: {
        ...current.brief,
        context_snapshot_ids: unique([
          ...current.brief.context_snapshot_ids,
          assembled.snapshot.id,
        ]),
      },
      context_evidence: mergeContextEvidence(current.context_evidence, expanded.evidence),
      continuations: mergeContinuations(current.continuations, expanded.continuations, this.now()),
    }));
    return {
      task: saved,
      evidence: expanded.evidence,
      continuations: expanded.continuations,
      snapshot_id: assembled.snapshot.id,
      degradation_flags: assembled.bundle.degradation_flags,
      completeness: {
        message_content: "complete_or_explicitly_omitted",
        local_read_scope: "bounded",
        source_sync: "unknown",
      },
      budget: { returned_items: expanded.evidence.length, max_items: maxItems },
    };
  }

  async readContext(taskId: string, input: {
    continuation_handle: string;
    max_items?: number;
  }): Promise<{
    task: CustomerServiceTask;
    evidence: CustomerContextEvidence[];
    continuations: CustomerContextContinuation[];
  }> {
    const task = await this.getTask(taskId);
    this.requireMutable(task);
    const handle = required(input.continuation_handle, "continuation_handle");
    const continuation = task.continuations.find((item) => item.handle === handle);
    if (!continuation) {
      throw new CustomerServiceError("not_found", "Continuation handle is invalid");
    }
    if (Date.parse(continuation.expires_at) <= Date.parse(this.now())) {
      throw new CustomerServiceError("cursor_expired", "Continuation handle expired");
    }
    const maxItems = boundedInteger(input.max_items ?? 20, "max_items", 1, 40);
    const thread = await this.currentThread(continuation.thread_id);
    if (thread.read_epoch !== continuation.read_epoch) {
      throw new CustomerServiceError("context_changed", "Context changed; search again");
    }
    const boundary = thread.events.findIndex((item) =>
      item.id === continuation.boundary_event_id
      && item.occurred_at === continuation.boundary_occurred_at);
    if (boundary < 0) {
      throw new CustomerServiceError("context_changed", "Context changed; search again");
    }
    const pageIndexes = continuation.direction === "after"
      ? range(boundary + 1, Math.min(thread.events.length, boundary + 1 + maxItems))
      : range(Math.max(0, boundary - maxItems), boundary).reverse();
    const selected = [...pageIndexes].sort((left, right) => left - right)
      .map((index) => thread.events[index]);
    const evidence = await this.materializeEvidence(
      selected,
      task.brief.context_snapshot_ids.at(-1) ?? `continuation:${task.id}`,
      "continuation",
    );
    const next = nextContinuation(
      continuation,
      thread,
      pageIndexes,
      this.now(),
      this.createId,
    );
    const saved = await this.update(task, (current) => ({
      ...current,
      context_evidence: mergeContextEvidence(current.context_evidence, evidence),
      continuations: mergeContinuations(
        current.continuations.filter((item) => item.handle !== handle),
        next ? [next] : [],
        this.now(),
      ),
    }));
    return { task: saved, evidence, continuations: next ? [next] : [] };
  }

  async updateBrief(taskId: string, input: {
    customer: CustomerResolvedValue;
    project: CustomerResolvedValue;
    batch: CustomerResolvedValue;
    intent: CustomerResolvedValue;
    expected_member_count?: number;
    expected_count_evidence?: string;
    members_closed: boolean;
    members: CustomerTaskMember[];
    requested_fields: string[];
    unresolved?: string[];
    query_at?: string;
  }): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    this.requireMutable(task);
    const citationIds = new Set(task.context_evidence.map((item) => item.citation_id));
    validateBriefEvidence(input, citationIds);
    const requestedFields = unique(input.requested_fields.map((field) => required(field, "requested_fields")));
    const members = input.members.map((member) => ({
      ...structuredClone(member),
      member_key: required(member.member_key, "member_key"),
      display_name: required(member.display_name, "display_name"),
      evidence: unique(member.evidence),
    }));
    if (new Set(members.map((member) => member.member_key)).size !== members.length) {
      throw new CustomerServiceError("invalid_request", "member_key values must be unique");
    }
    if (input.members_closed && input.expected_member_count !== undefined
      && members.length !== input.expected_member_count) {
      throw new CustomerServiceError("invalid_request", "Closed member set does not match expected_member_count");
    }
    const unresolvedFields = unique(input.unresolved ?? []);
    const ready = [input.customer, input.project, input.batch, input.intent]
      .every((value) => value.status === "verified" && value.value)
      && input.members_closed
      && members.length > 0
      && members.every((member) => member.status === "verified" && member.business_id)
      && requestedFields.length > 0
      && unresolvedFields.length === 0;
    return this.update(task, (current) => ({
      ...current,
      status: ready ? "ready_for_query" : "needs_clarification",
      brief: {
        ...current.brief,
        version: current.brief.version + 1,
        customer: structuredClone(input.customer),
        project: structuredClone(input.project),
        batch: structuredClone(input.batch),
        intent: structuredClone(input.intent),
        ...(input.expected_member_count === undefined
          ? {}
          : { expected_member_count: boundedInteger(input.expected_member_count, "expected_member_count", 0, 1_000) }),
        ...(input.expected_count_evidence
          ? { expected_count_evidence: required(input.expected_count_evidence, "expected_count_evidence") }
          : {}),
        members_closed: input.members_closed,
        members,
        requested_fields: requestedFields,
        unresolved: unresolvedFields,
        query_at: input.query_at === undefined
          ? current.brief.query_at
          : timestamp(input.query_at, "query_at"),
      },
      business_evidence: [],
      draft: undefined,
    }));
  }

  async queryBusiness(taskId: string, input: { page?: string } = {}): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (!["ready_for_query", "querying", "verifying"].includes(task.status)) {
      throw new CustomerServiceError("invalid_state", "Task is not ready for a business query");
    }
    const currentPages = task.business_evidence.filter((item) =>
      item.brief_version === task.brief.version);
    const lastPage = currentPages.at(-1);
    if (input.page && lastPage?.next_page !== input.page) {
      throw new CustomerServiceError("invalid_request", "Business query page is not the expected continuation");
    }
    if (!input.page && task.status === "querying" && lastPage?.next_page) {
      throw new CustomerServiceError("invalid_request", "Business query continuation page is required");
    }
    const query = businessQuery(task, input.page);
    const querying = task.status === "querying"
      ? task
      : await this.update(task, (current) => ({ ...current, status: "querying" }));
    let result: BusinessEvidence;
    try {
      result = validateBusinessEvidence(await this.options.business.query(query));
    } catch (error) {
      if (error instanceof CustomerServiceError) {
        throw error;
      }
      throw new CustomerServiceError(
        "business_unavailable",
        error instanceof Error ? error.message : "Business query failed",
      );
    }
    validateGatewayEvidence(querying, query, result, this.options.business.id);
    if (!result.complete && !result.next_page) {
      throw new CustomerServiceError("business_unavailable", "Business query returned an incomplete page without a continuation");
    }
    return this.update(querying, (current) => ({
      ...current,
      status: result.complete && !result.next_page ? "verifying" : "querying",
      business_evidence: mergeBusinessEvidence(
        input.page
          ? current.business_evidence
          : current.business_evidence.filter((item) => item.brief_version !== current.brief.version),
        result,
      ),
      draft: undefined,
    }));
  }

  async createDraft(taskId: string, input: {
    text: string;
    claims: CustomerReplyClaim[];
    covered_member_keys: string[];
    unresolved?: string[];
  }): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (task.status !== "verifying") {
      throw new CustomerServiceError("invalid_state", "Task is not ready to create a reply draft");
    }
    const currentEvidence = task.business_evidence.filter((item) =>
      item.brief_version === task.brief.version);
    const terminal = currentEvidence.at(-1);
    if (!terminal?.complete || terminal.next_page
      || currentEvidence.slice(0, -1).some((item) => item.complete || !item.next_page)) {
      throw new CustomerServiceError("coverage_incomplete", "Business query pages are incomplete");
    }
    const memberKeys = new Set(task.brief.members.map((member) => member.member_key));
    const covered = unique(input.covered_member_keys);
    if (covered.some((member) => !memberKeys.has(member))) {
      throw new CustomerServiceError("invalid_request", "Draft covers a member outside the verified set");
    }
    const evidenceByCitation = new Map(
      currentEvidence.map((item) => [item.citation_id, item]),
    );
    const foundMembers = new Set(currentEvidence.flatMap((item) =>
      item.results
        .filter((result) => result.status === "found")
        .map((result) => result.member_key)));
    if (covered.some((member) => !foundMembers.has(member))) {
      throw new CustomerServiceError("coverage_incomplete", "Draft marks a member covered without a found business result");
    }
    const claims = input.claims.map((claim) => {
      const next = {
        ...structuredClone(claim),
        claim_id: required(claim.claim_id, "claim_id"),
        text: required(claim.text, "claim text"),
        member_keys: unique(claim.member_keys),
        fields: unique(claim.fields),
        evidence: unique(claim.evidence),
      };
      if (!next.evidence.length || next.evidence.some((citation) => !evidenceByCitation.has(citation))) {
        throw new CustomerServiceError("invalid_request", "Every claim must cite current business evidence");
      }
      if (next.member_keys.some((member) => !covered.includes(member))) {
        throw new CustomerServiceError("coverage_incomplete", "Claim references an uncovered member");
      }
      validateVisibleClaim(next, evidenceByCitation);
      return next;
    });
    if (!claims.length) {
      throw new CustomerServiceError("invalid_request", "Reply draft needs at least one supported claim");
    }
    const unresolved = unique(input.unresolved ?? []);
    if (unresolved.length === 0 && (
      !task.brief.members_closed
      || covered.length !== task.brief.members.length
      || task.brief.expected_member_count !== undefined
        && covered.length !== task.brief.expected_member_count
    )) {
      throw new CustomerServiceError("coverage_incomplete", "A complete reply must cover the closed member set");
    }
    return this.update(task, (current) => ({
      ...current,
      status: "awaiting_review",
      draft: {
        version: (current.draft?.version ?? 0) + 1,
        text: required(input.text, "text"),
        claims,
        covered_member_keys: covered,
        unresolved,
        brief_version: current.brief.version,
        business_query_ids: currentEvidence.map((item) => item.query_id),
        created_at: this.now(),
      },
    }));
  }

  async reviewDraft(taskId: string, input: {
    result: "approved" | "rejected";
    reviewer: ActorRef;
    note?: string;
  }): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (task.status !== "awaiting_review" || !task.draft) {
      throw new CustomerServiceError("invalid_state", "Task has no draft awaiting review");
    }
    if (task.draft.brief_version !== task.brief.version) {
      throw new CustomerServiceError("context_changed", "Draft is based on an outdated brief");
    }
    if (input.reviewer.actor_type !== "human" || !input.reviewer.actor_id.trim()) {
      throw new CustomerServiceError("invalid_request", "A human reviewer is required");
    }
    const reviewedAt = this.now();
    return this.update(task, (current) => ({
      ...current,
      status: input.result === "approved" ? "approved" : "resolving_context",
      draft: {
        ...current.draft!,
        review: {
          result: input.result,
          reviewer: structuredClone(input.reviewer),
          reviewed_at: reviewedAt,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        },
      },
    }));
  }

  async recordSent(taskId: string, input: {
    client_request_id: string;
    event_id: string;
    sent_at?: string;
  }): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (task.status === "sent" && task.draft?.sent?.client_request_id === input.client_request_id) {
      return task;
    }
    if (task.status !== "sending" || task.draft?.review?.result !== "approved") {
      throw new CustomerServiceError("review_required", "An approved current draft is required before sending");
    }
    return this.update(task, (current) => ({
      ...current,
      status: "sent",
      draft: {
        ...current.draft!,
        sent: {
          client_request_id: required(input.client_request_id, "client_request_id"),
          event_id: required(input.event_id, "event_id"),
          sent_at: input.sent_at === undefined
            ? this.now()
            : timestamp(input.sent_at, "sent_at"),
        },
      },
    }));
  }

  async prepareSend(taskId: string): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (task.status !== "approved" || task.draft?.review?.result !== "approved") {
      throw new CustomerServiceError("review_required", "An approved current draft is required before sending");
    }
    if (task.draft.brief_version !== task.brief.version) {
      throw new CustomerServiceError("context_changed", "Approved draft is based on an outdated brief");
    }
    const freshPages: BusinessEvidence[] = [];
    const seenPages = new Set<string>();
    let page: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const query = businessQuery(task, page);
      let fresh: BusinessEvidence;
      try {
        fresh = validateBusinessEvidence(await this.options.business.query(query));
      } catch (error) {
        throw new CustomerServiceError(
          "business_unavailable",
          error instanceof Error ? error.message : "Business revalidation failed",
        );
      }
      validateGatewayEvidence(task, query, fresh, this.options.business.id);
      freshPages.push(fresh);
      if (fresh.complete && !fresh.next_page) {
        break;
      }
      if (!fresh.next_page || seenPages.has(fresh.next_page)) {
        throw new CustomerServiceError("business_unavailable", "Business revalidation returned an invalid page chain");
      }
      seenPages.add(fresh.next_page);
      page = fresh.next_page;
    }
    const previousPages = task.business_evidence
      .filter((item) => task.draft!.business_query_ids.includes(item.query_id));
    const freshTerminal = freshPages.at(-1);
    if (!previousPages.length || !freshTerminal?.complete || freshTerminal.next_page
      || businessResultFingerprint(previousPages) !== businessResultFingerprint(freshPages)) {
      await this.update(task, (current) => ({
        ...current,
        status: "verifying",
        business_evidence: freshPages.reduce(
          (evidence, fresh) => mergeBusinessEvidence(evidence, fresh),
          current.business_evidence,
        ),
        draft: current.draft
          ? { ...current.draft, review: undefined }
          : undefined,
      }));
      throw new CustomerServiceError("context_changed", "Business facts changed; regenerate and review the reply");
    }
    return this.update(task, (current) => ({ ...current, status: "sending" }));
  }

  async releaseSend(taskId: string): Promise<CustomerServiceTask> {
    const task = await this.getTask(taskId);
    if (task.status !== "sending") return task;
    return this.update(task, (current) => ({ ...current, status: "approved" }));
  }

  private async update(
    task: CustomerServiceTask,
    apply: (current: CustomerServiceTask) => CustomerServiceTask,
  ): Promise<CustomerServiceTask> {
    const changed = apply(structuredClone(task));
    const next = {
      ...changed,
      revision: task.revision + 1,
      updated_at: this.now(),
    };
    return this.options.tasks.putCustomerServiceTask(next, task.revision);
  }

  private requireMutable(task: CustomerServiceTask): void {
    if (["sent", "failed"].includes(task.status)) {
      throw new CustomerServiceError("invalid_state", "Customer service task is terminal");
    }
  }

  private async expandThread(
    threadId: string,
    seedIds: string[],
    snapshotId: string,
    maxItems: number,
    neighbors: number,
    reason: CustomerContextEvidence["selection_reason"],
  ): Promise<{
    evidence: CustomerContextEvidence[];
    continuations: CustomerContextContinuation[];
  }> {
    const thread = await this.currentThread(threadId);
    const selectedIndexes = new Set<number>();
    for (const seed of seedIds) {
      const index = thread.events.findIndex((item) => item.id === seed);
      if (index < 0) continue;
      let replyIndex = index;
      for (let depth = 0; depth < 8; depth += 1) {
        const parentExternalId = stringAttribute(
          thread.events[replyIndex].attrs,
          "parent_external_id",
        );
        if (!parentExternalId) break;
        const parent = thread.events.findIndex((item) =>
          item.source === thread.events[replyIndex].source
          && item.external_id === parentExternalId);
        if (parent < 0 || selectedIndexes.has(parent)) break;
        selectedIndexes.add(parent);
        replyIndex = parent;
      }
      for (
        let cursor = Math.max(0, index - neighbors);
        cursor <= Math.min(thread.events.length - 1, index + neighbors);
        cursor += 1
      ) {
        selectedIndexes.add(cursor);
      }
    }
    const ordered = [...selectedIndexes].sort((left, right) => left - right).slice(0, maxItems);
    const selected = ordered.map((index) => thread.events[index]);
    const evidence = await this.materializeEvidence(selected, snapshotId, reason);
    const continuations: CustomerContextContinuation[] = [];
    if (ordered.length) {
      const first = ordered[0];
      const last = ordered.at(-1)!;
      if (first > 0) {
        continuations.push(createContinuation(
          thread,
          thread.events[first],
          "before",
          this.now(),
          this.createId,
        ));
      }
      if (last < thread.events.length - 1) {
        continuations.push(createContinuation(
          thread,
          thread.events[last],
          "after",
          this.now(),
          this.createId,
        ));
      }
    }
    return { evidence, continuations };
  }

  private async currentThread(threadId: string): Promise<{
    read_epoch: string;
    events: ContextAuthorityRead["events"];
  }> {
    const read = await this.options.context_authority.openContextReadForThread(
      this.options.org_id,
      threadId,
    );
    const heads = new Set(read.lifecycle_heads.map((head) => head.head_event_id));
    const events = read.events
      .filter((event) =>
        event.thread_id === threadId
        && event.operation !== "tombstone"
        && heads.has(event.id)
        && event.content_hash
        && event.content_media_type)
      .sort(compareEvent);
    return { read_epoch: read.read_epoch, events };
  }

  private async materializeEvidence(
    events: ContextAuthorityRead["events"],
    snapshotId: string,
    selectionReason: CustomerContextEvidence["selection_reason"],
  ): Promise<CustomerContextEvidence[]> {
    const hashes = events.flatMap((event) => event.content_hash ? [event.content_hash] : []);
    const bodies = await this.options.blobs.getMany(hashes);
    const evidence: CustomerContextEvidence[] = [];
    for (const event of events) {
      if (!event.content_hash || !event.content_media_type) continue;
      const bytes = bodies.get(event.content_hash);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== event.content_hash) {
        continue;
      }
      const text = bodyTextFromStored(bytes, event.content_media_type)?.trim();
      if (!text) continue;
      const parentExternalId = stringAttribute(event.attrs, "parent_external_id");
      const replyTarget = parentExternalId
        ? events.find((candidate) =>
          candidate.source === event.source
          && candidate.external_id === parentExternalId)
        : undefined;
      evidence.push({
        citation_id: contextCitation(event.id, event.content_hash),
        snapshot_id: snapshotId,
        event_id: event.id,
        content_hash: event.content_hash,
        source: event.source,
        thread_id: event.thread_id!,
        ...(event.actor_id ? { actor_id: event.actor_id } : {}),
        ...(stringAttribute(event.attrs, "native_thread_id")
          ? { native_thread_id: stringAttribute(event.attrs, "native_thread_id") }
          : {}),
        ...(replyTarget ? { reply_to_event_id: replyTarget.id } : {}),
        occurred_at: event.occurred_at,
        text,
        selection_reason: selectionReason,
      });
    }

    return evidence;
  }

  private async eventText(contentHash: string): Promise<string> {
    const metadata = await this.options.authority.findBlob(contentHash);
    if (!metadata) {
      throw new CustomerServiceError("not_found", "Triggering message body is unavailable");
    }
    const bytes = await this.options.blobs.get(contentHash);
    if (createHash("sha256").update(bytes).digest("hex") !== contentHash) {
      throw new CustomerServiceError("context_changed", "Triggering message body failed integrity validation");
    }
    const text = bodyTextFromStored(bytes, metadata.media_type);
    if (!text?.trim()) {
      throw new CustomerServiceError("not_found", "Triggering message has no readable text");
    }
    return text;
  }
}

function stringAttribute(
  attrs: ContextAuthorityRead["events"][number]["attrs"],
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function businessQuery(task: CustomerServiceTask, page?: string): CustomerBusinessQuery {
  const { brief } = task;
  if (
    brief.customer.status !== "verified" || !brief.customer.value
    || brief.project.status !== "verified" || !brief.project.value
    || brief.batch.status !== "verified" || !brief.batch.value
    || brief.intent.status !== "verified" || !brief.intent.value
    || !brief.members_closed
    || !brief.members.length
    || brief.members.some((member) => member.status !== "verified" || !member.business_id)
    || !brief.requested_fields.length
    || brief.unresolved.length
  ) {
    throw new CustomerServiceError("invalid_state", "Task brief still has unresolved query parameters");
  }
  return {
    task_id: task.id,
    brief_version: brief.version,
    customer_id: brief.customer.value,
    project_id: brief.project.value,
    batch_id: brief.batch.value,
    members: brief.members.map((member) => ({
      member_key: member.member_key,
      business_id: member.business_id!,
    })),
    fields: [...brief.requested_fields],
    query_at: brief.query_at,
    ...(page ? { page: required(page, "page") } : {}),
  };
}

function validateGatewayEvidence(
  task: CustomerServiceTask,
  query: CustomerBusinessQuery,
  evidence: BusinessEvidence,
  providerId: string,
): void {
  if (
    evidence.task_id !== task.id
    || evidence.brief_version !== task.brief.version
    || evidence.provider_id !== providerId
    || evidence.customer_id !== query.customer_id
    || evidence.project_id !== query.project_id
    || evidence.batch_id !== query.batch_id
    || !sameSet(evidence.requested_fields, query.fields)
  ) {
    throw new CustomerServiceError("business_unavailable", "Business provider returned evidence outside the verified query");
  }
  const allowed = new Map(query.members.map((member) => [member.member_key, member.business_id]));
  if (evidence.results.some((result) => allowed.get(result.member_key) !== result.business_id)) {
    throw new CustomerServiceError("business_unavailable", "Business provider returned an unrequested entity");
  }
  for (const result of evidence.results) {
    if (result.fields.some((field) => !query.fields.includes(field.field))) {
      throw new CustomerServiceError("business_unavailable", "Business provider returned an unrequested field");
    }
  }
}

function validateVisibleClaim(
  claim: CustomerReplyClaim,
  evidenceByCitation: Map<string, BusinessEvidence>,
): void {
  for (const memberKey of claim.member_keys) {
    for (const fieldName of claim.fields) {
      const values = claim.evidence.flatMap((citation) =>
        evidenceByCitation.get(citation)?.results
          .filter((result) => result.member_key === memberKey && result.status === "found")
          .flatMap((result) => result.fields.filter((field) => field.field === fieldName)) ?? []);
      if (!values.length) {
        throw new CustomerServiceError("coverage_incomplete", `Claim lacks ${fieldName} evidence for ${memberKey}`);
      }
      if (values.some((field) => field.visibility !== "customer")) {
        throw new CustomerServiceError("invalid_request", `Claim exposes non-customer field ${fieldName}`);
      }
    }
  }
}

function businessResultFingerprint(evidence: BusinessEvidence[]): string {
  return canonicalContextJson(
    evidence.flatMap((page) => page.results)
      .map((result) => ({
        member_key: result.member_key,
        business_id: result.business_id,
        status: result.status,
        record_id: result.record_id,
        record_version: result.record_version,
        reason_code: result.reason_code,
        fields: result.fields
          .map((field) => ({
            field: field.field,
            value: field.value,
            visibility: field.visibility,
            authority: field.authority,
            updated_at: field.updated_at,
          }))
          .sort((left, right) => compare(left.field, right.field)),
      }))
      .sort((left, right) => compare(left.member_key, right.member_key)),
  );
}

function validateBriefEvidence(
  input: {
    customer: CustomerResolvedValue;
    project: CustomerResolvedValue;
    batch: CustomerResolvedValue;
    intent: CustomerResolvedValue;
    expected_member_count?: number;
    expected_count_evidence?: string;
    members: CustomerTaskMember[];
  },
  citations: Set<string>,
): void {
  const resolved = [input.customer, input.project, input.batch, input.intent];
  if (resolved.some((value) => value.status === "verified" && value.evidence.length === 0)) {
    throw new CustomerServiceError("invalid_request", "Verified brief values require context evidence");
  }
  if (input.members.some((member) =>
    member.status === "verified" && (member.evidence.length === 0 || !member.identity_evidence))) {
    throw new CustomerServiceError("invalid_request", "Verified members require identity evidence");
  }
  if (input.expected_member_count !== undefined && !input.expected_count_evidence) {
    throw new CustomerServiceError("invalid_request", "Expected member count requires context evidence");
  }
  const referenced = [
    ...input.customer.evidence,
    ...input.project.evidence,
    ...input.batch.evidence,
    ...input.intent.evidence,
    ...(input.expected_count_evidence ? [input.expected_count_evidence] : []),
    ...input.members.flatMap((member) => [
      ...member.evidence,
      ...(member.identity_evidence ? [member.identity_evidence] : []),
    ]),
  ];
  if (referenced.some((citation) => !citations.has(citation))) {
    throw new CustomerServiceError("invalid_request", "Brief references evidence outside this task");
  }
}

function mergeContextEvidence(
  current: CustomerContextEvidence[],
  added: CustomerContextEvidence[],
): CustomerContextEvidence[] {
  const merged = new Map(current.map((item) => [item.citation_id, item]));
  for (const item of added) merged.set(item.citation_id, item);
  return [...merged.values()].sort((left, right) =>
    compare(`${left.occurred_at}\u0000${left.event_id}`, `${right.occurred_at}\u0000${right.event_id}`));
}

function mergeBusinessEvidence(
  current: BusinessEvidence[],
  added: BusinessEvidence,
): BusinessEvidence[] {
  const merged = current.filter((item) => item.query_id !== added.query_id);
  merged.push(added);
  return merged;
}

function mergeContinuations(
  current: CustomerContextContinuation[],
  added: CustomerContextContinuation[],
  now: string,
): CustomerContextContinuation[] {
  const active = current.filter((item) => Date.parse(item.expires_at) > Date.parse(now));
  const merged = new Map(active.map((item) => [item.handle, item]));
  for (const item of added) merged.set(item.handle, item);
  return [...merged.values()];
}

function nextContinuation(
  current: CustomerContextContinuation,
  thread: { read_epoch: string; events: ContextAuthorityRead["events"] },
  indexes: number[],
  now: string,
  createId: () => string,
): CustomerContextContinuation | undefined {
  if (!indexes.length) return undefined;
  const boundaryIndex = indexes.at(-1)!;
  if (current.direction === "after" && boundaryIndex >= thread.events.length - 1) return undefined;
  if (current.direction === "before" && boundaryIndex <= 0) return undefined;
  return createContinuation(thread, thread.events[boundaryIndex], current.direction, now, createId);
}

function createContinuation(
  thread: { read_epoch: string },
  boundary: ContextAuthorityRead["events"][number],
  direction: "before" | "after",
  now: string,
  createId: () => string,
): CustomerContextContinuation {
  return {
    handle: createId(),
    thread_id: boundary.thread_id!,
    direction,
    boundary_occurred_at: boundary.occurred_at,
    boundary_event_id: boundary.id,
    read_epoch: thread.read_epoch,
    expires_at: new Date(Date.parse(now) + CONTINUATION_TTL_MS).toISOString(),
  };
}

function contextCitation(eventId: string, contentHash: string): string {
  return `context:${createHash("sha256").update(`${eventId}\u0000${contentHash}`).digest("hex").slice(0, 24)}`;
}

function compareEvent(
  left: ContextAuthorityRead["events"][number],
  right: ContextAuthorityRead["events"][number],
): number {
  return compare(`${left.occurred_at}\u0000${left.id}`, `${right.occurred_at}\u0000${right.id}`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unresolved(): CustomerResolvedValue {
  return { status: "unresolved", evidence: [] };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomerServiceError("invalid_request", `${field} is required`);
  }
  return value.trim();
}

function requiredHash(value: unknown): string {
  const hash = required(value, "content_hash");
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new CustomerServiceError("invalid_request", "content_hash must be a lowercase SHA-256 value");
  }
  return hash;
}

function timestamp(value: unknown, field: string): string {
  const text = required(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new CustomerServiceError("invalid_request", `${field} must be an ISO timestamp`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CustomerServiceError(
      "invalid_request",
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function customerBusinessCitation(queryId: string): string {
  return `business:${createHash("sha256").update(queryId).digest("hex").slice(0, 24)}`;
}

export function customerVisibleFields(
  evidence: BusinessEvidence,
): BusinessFieldValue[] {
  return evidence.results.flatMap((result) =>
    result.fields.filter((field) => field.visibility === "customer"));
}
