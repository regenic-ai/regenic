import { Inject, Injectable } from "@nestjs/common";
import type {
  ActorRef,
  CustomerResolvedValue,
  CustomerServiceTaskStatus,
  CustomerTaskMember,
} from "@regenic/domain";
import {
  CustomerServiceCoordinator,
  CustomerServiceError,
  type CustomerBusinessGateway,
} from "@regenic/context-engine";
import { customerBusinessGatewayFromEnv } from "./customer-business-gateway";
import { PersonalReplyService } from "./personal-reply.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

@Injectable()
export class PersonalCustomerService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalReplyService)
    private readonly replies: PersonalReplyService,
  ) {}

  create(input: unknown) {
    const body = strictBody(input, new Set([
      "source_event_id",
      "content_hash",
      "question",
      "query_at",
    ]));
    return this.coordinator().createTask({
      source_event_id: stringValue(body.source_event_id, "source_event_id"),
      content_hash: stringValue(body.content_hash, "content_hash"),
      ...(body.question === undefined ? {} : { question: stringValue(body.question, "question") }),
      ...(body.query_at === undefined ? {} : { query_at: stringValue(body.query_at, "query_at") }),
    });
  }

  get(taskId: string) {
    return this.coordinator().getTask(taskId);
  }

  list(statuses?: string, limit?: string) {
    const parsedStatuses = statuses?.trim()
      ? statuses.split(",").map((status) => status.trim() as CustomerServiceTaskStatus)
      : undefined;
    return this.coordinator().listTasks({
      ...(parsedStatuses ? { statuses: parsedStatuses } : {}),
      ...(limit === undefined ? {} : { limit: integerValue(limit, "limit") }),
    });
  }

  search(taskId: string, input: unknown) {
    const body = strictBody(input, new Set(["query", "objective", "max_items", "neighbor_count", "include_related"]));
    return this.coordinator().searchContext(taskId, {
      query: stringValue(body.query, "query"),
      ...(body.objective === undefined ? {} : { objective: stringValue(body.objective, "objective") }),
      ...(body.max_items === undefined ? {} : { max_items: numberValue(body.max_items, "max_items") }),
      ...(body.neighbor_count === undefined ? {} : { neighbor_count: numberValue(body.neighbor_count, "neighbor_count") }),
      ...(body.include_related === undefined ? {} : { include_related: booleanValue(body.include_related, "include_related") }),
    });
  }

  read(taskId: string, input: unknown) {
    const body = strictBody(input, new Set(["continuation_handle", "max_items"]));
    return this.coordinator().readContext(taskId, {
      continuation_handle: stringValue(body.continuation_handle, "continuation_handle"),
      ...(body.max_items === undefined ? {} : { max_items: numberValue(body.max_items, "max_items") }),
    });
  }

  updateBrief(taskId: string, input: unknown) {
    const body = strictBody(input, new Set([
      "customer",
      "project",
      "batch",
      "intent",
      "expected_member_count",
      "expected_count_evidence",
      "members_closed",
      "members",
      "requested_fields",
      "unresolved",
      "query_at",
    ]));
    return this.coordinator().updateBrief(taskId, {
      customer: body.customer as CustomerResolvedValue,
      project: body.project as CustomerResolvedValue,
      batch: body.batch as CustomerResolvedValue,
      intent: body.intent as CustomerResolvedValue,
      ...(body.expected_member_count === undefined
        ? {}
        : { expected_member_count: numberValue(body.expected_member_count, "expected_member_count") }),
      ...(body.expected_count_evidence === undefined
        ? {}
        : { expected_count_evidence: stringValue(body.expected_count_evidence, "expected_count_evidence") }),
      members_closed: booleanValue(body.members_closed, "members_closed"),
      members: arrayValue(body.members, "members") as CustomerTaskMember[],
      requested_fields: stringArray(body.requested_fields, "requested_fields"),
      ...(body.unresolved === undefined ? {} : { unresolved: stringArray(body.unresolved, "unresolved") }),
      ...(body.query_at === undefined ? {} : { query_at: stringValue(body.query_at, "query_at") }),
    });
  }

  query(taskId: string, input: unknown) {
    const body = strictBody(input, new Set(["page"]));
    return this.coordinator().queryBusiness(taskId, {
      ...(body.page === undefined ? {} : { page: stringValue(body.page, "page") }),
    });
  }

  draft(taskId: string, input: unknown) {
    const body = strictBody(input, new Set([
      "text",
      "claims",
      "covered_member_keys",
      "unresolved",
    ]));
    return this.coordinator().createDraft(taskId, {
      text: stringValue(body.text, "text"),
      claims: arrayValue(body.claims, "claims") as Parameters<CustomerServiceCoordinator["createDraft"]>[1]["claims"],
      covered_member_keys: stringArray(body.covered_member_keys, "covered_member_keys"),
      ...(body.unresolved === undefined ? {} : { unresolved: stringArray(body.unresolved, "unresolved") }),
    });
  }

  review(taskId: string, input: unknown) {
    const body = strictBody(input, new Set(["result", "note"]));
    const result = stringValue(body.result, "result");
    if (result !== "approved" && result !== "rejected") {
      throw new CustomerServiceError("invalid_request", "result must be approved or rejected");
    }
    return this.coordinator().reviewDraft(taskId, {
      result,
      reviewer: this.principal(),
      ...(body.note === undefined ? {} : { note: stringValue(body.note, "note") }),
    });
  }

  async send(taskId: string, input: unknown) {
    strictBody(input, new Set());
    const coordinator = this.coordinator();
    const task = await coordinator.prepareSend(taskId);
    const draft = task.draft!;
    const clientRequestId = `customer-service:${task.id}:draft:${draft.version}`;
    try {
      const sent = await this.replies.send({
        thread_id: task.brief.source.thread_id,
        text: draft.text,
        reply_to_event_id: task.brief.source.event_id,
        client_request_id: clientRequestId,
      });
      return coordinator.recordSent(task.id, {
        client_request_id: clientRequestId,
        event_id: sent.item.event.id,
      });
    } catch (error) {
      await coordinator.releaseSend(task.id).catch(() => undefined);
      throw error;
    }
  }

  private coordinator(): CustomerServiceCoordinator {
    const host = this.runtime.requireHost();
    return new CustomerServiceCoordinator({
      org_id: this.runtime.orgId(),
      principal: this.principal(),
      authority: host.get("authority"),
      context_authority: host.get("context-authority"),
      blobs: host.get("blobs"),
      context: host.get("context"),
      tasks: host.get("customer-service-tasks"),
      business: this.businessGateway(),
    });
  }

  private principal(): ActorRef {
    return { actor_type: "human", actor_id: this.runtime.orgId() };
  }

  protected businessGateway(): CustomerBusinessGateway {
    return customerBusinessGatewayFromEnv();
  }
}

function strictBody(value: unknown, keys: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerServiceError("invalid_request", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !keys.has(key))) {
    throw new CustomerServiceError("invalid_request", "Request body contains unknown fields");
  }
  return body;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomerServiceError("invalid_request", `${field} is required`);
  }
  return value.trim();
}

function integerValue(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CustomerServiceError("invalid_request", `${field} must be an integer`);
  }
  return parsed;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CustomerServiceError("invalid_request", `${field} must be an integer`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CustomerServiceError("invalid_request", `${field} must be a boolean`);
  }
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CustomerServiceError("invalid_request", `${field} must be an array`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return arrayValue(value, field).map((item) => stringValue(item, field));
}
