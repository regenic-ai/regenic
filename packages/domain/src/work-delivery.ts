import { createHash, randomUUID } from "node:crypto";
import type { ContentPart } from "./ingestion";
import type { DeliveryReceipt } from "./egress";
import type { RecipeTriggerKind } from "./work";
import type {
  WorkDelivery,
  WorkDeliveryFace,
  WorkDeliveryStatus,
  WorkWriteBackState,
} from "./work";

export const WORK_DELIVERY_RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const;
export const WORK_DELIVERY_MAX_ATTEMPTS = 3;
export const WORK_DELIVERY_LEASE_MS = 60_000;
export const WORK_DELIVERY_SEND_TIMEOUT_MS = 45_000;

export interface WorkDeliveryPayload {
  summary: string;
  content?: ContentPart[];
}

export function isWorkDeliveryStatus(
  value: unknown,
): value is WorkDeliveryStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "write_back" ||
    value === "acked" ||
    value === "dead"
  );
}

export function isWorkWriteBackState(value: unknown): value is WorkWriteBackState {
  return (
    value === "pending" ||
    value === "sent" ||
    value === "skipped" ||
    value === "failed"
  );
}

export function enqueueWriteBack(input: {
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  kind: RecipeTriggerKind;
  unit_key: string;
  event_id?: string;
  payload: WorkDeliveryPayload;
  now: string;
  existing?: WorkDelivery | null;
}): WorkDelivery {
  const idempotency_key = writeBackIdempotencyKey(input.work_item_id, input.payload);
  const existing = input.existing;
  if (existing && deliveryPayloadKey(existing) === idempotency_key) {
    return existing.idempotency_key
      ? existing
      : { ...existing, idempotency_key };
  }
  return {
    id: existing?.id ?? `deliv-${randomUUID()}`,
    org_id: input.org_id,
    work_item_id: input.work_item_id,
    recipe_id: input.recipe_id,
    kind: input.kind,
    unit_key: input.unit_key,
    event_id: input.event_id,
    status: "queued",
    write_back: "pending",
    attempts: 0,
    payload: clonePayload(input.payload),
    idempotency_key,
    channel_receipt: undefined,
    last_error: undefined,
    next_retry_at: undefined,
    lease_expires_at: undefined,
    created_at: existing?.created_at ?? input.now,
    updated_at: input.now,
  };
}

export function deliveryChannelReceipt(
  delivery?: Pick<WorkDelivery, "channel_receipt"> | null,
): DeliveryReceipt | undefined {
  const receipt = delivery?.channel_receipt;
  if (!receipt?.accepted) {
    return undefined;
  }
  return {
    accepted: true,
    ...(receipt.rpc_id ? { rpc_id: receipt.rpc_id } : {}),
  };
}

function deliveryPayloadKey(delivery: WorkDelivery): string | undefined {
  if (delivery.idempotency_key) {
    return delivery.idempotency_key;
  }
  if (!delivery.payload) {
    return undefined;
  }
  return writeBackIdempotencyKey(delivery.work_item_id, delivery.payload);
}

export function writeBackIdempotencyKey(
  workItemId: string,
  payload: WorkDeliveryPayload,
): string {
  const digest = createHash("sha256")
    .update(writeBackPayloadText(payload))
    .digest("hex")
    .slice(0, 16);
  return `work-back:${workItemId}:${digest}`;
}

export function deliveryRecordReceipt(
  delivery: WorkDelivery,
  receipt: DeliveryReceipt,
  now: string,
): WorkDelivery {
  return {
    ...delivery,
    channel_receipt: {
      accepted: receipt.accepted,
      ...(receipt.rpc_id ? { rpc_id: receipt.rpc_id } : {}),
    },
    updated_at: now,
  };
}

export function deliveryAbandoned(delivery: WorkDelivery, now: string): WorkDelivery {
  return {
    ...delivery,
    status: "acked",
    write_back: "skipped",
    last_error: undefined,
    next_retry_at: undefined,
    lease_expires_at: undefined,
    updated_at: now,
  };
}

export function deliveryClaimSend(delivery: WorkDelivery, now: string): WorkDelivery {
  return {
    ...delivery,
    status: "write_back",
    write_back: "pending",
    attempts: delivery.attempts + 1,
    last_error: undefined,
    next_retry_at: undefined,
    lease_expires_at: new Date(Date.parse(now) + WORK_DELIVERY_LEASE_MS).toISOString(),
    updated_at: now,
  };
}

export function deliveryAcked(
  delivery: WorkDelivery,
  write_back: Extract<WorkWriteBackState, "sent" | "skipped">,
  now: string,
): WorkDelivery {
  return {
    ...delivery,
    status: "acked",
    write_back,
    last_error: undefined,
    next_retry_at: undefined,
    lease_expires_at: undefined,
    updated_at: now,
  };
}

export function deliveryWriteBackFailed(
  delivery: WorkDelivery,
  error: string,
  now: string,
): WorkDelivery {
  const attempts = Math.max(delivery.attempts, 1);
  const dead = attempts >= WORK_DELIVERY_MAX_ATTEMPTS;
  return {
    ...delivery,
    status: dead ? "dead" : "write_back",
    write_back: "failed",
    attempts,
    last_error: error,
    next_retry_at: dead ? undefined : nextDeliveryRetryAt(attempts, now),
    lease_expires_at: undefined,
    updated_at: now,
  };
}

export function nextDeliveryRetryAt(attempts: number, now: string): string {
  const wait =
    WORK_DELIVERY_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts, 1) - 1, WORK_DELIVERY_RETRY_DELAYS_MS.length - 1)
    ] ?? WORK_DELIVERY_RETRY_DELAYS_MS[0];
  return new Date(Date.parse(now) + wait).toISOString();
}

export function deliverySendTimedOut(
  delivery: WorkDelivery,
  now: string,
): WorkDelivery {
  return {
    ...delivery,
    attempts: Math.max(0, delivery.attempts - 1),
    updated_at: now,
  };
}

export function deliveryRetryNow(delivery: WorkDelivery, now: string): WorkDelivery {
  return {
    ...delivery,
    status: "queued",
    write_back: "pending",
    attempts: delivery.status === "dead" ? 0 : delivery.attempts,
    last_error: undefined,
    next_retry_at: undefined,
    lease_expires_at: undefined,
    updated_at: now,
  };
}

export function isDeliveryLeaseExpired(
  delivery: WorkDelivery,
  now: string,
): boolean {
  if (delivery.write_back === "failed") {
    return false;
  }
  if (delivery.status !== "write_back" && delivery.status !== "running") {
    return false;
  }
  if (!delivery.lease_expires_at) {
    return true;
  }
  return Date.parse(now) >= Date.parse(delivery.lease_expires_at);
}

export function reclaimDeliveryLease(
  delivery: WorkDelivery,
  now: string,
): WorkDelivery {
  if (!isDeliveryLeaseExpired(delivery, now)) {
    return delivery;
  }
  if (delivery.payload) {
    return {
      ...delivery,
      status: "queued",
      write_back: "pending",
      lease_expires_at: undefined,
      updated_at: now,
    };
  }
  return deliveryAbandoned(delivery, now);
}

export function shouldFlushDelivery(
  delivery: WorkDelivery,
  now: string,
): boolean {
  const current = reclaimDeliveryLease(delivery, now);
  if (current.status === "acked" || current.status === "dead") {
    return false;
  }
  if (!current.payload) {
    return false;
  }
  if (current.write_back === "failed") {
    return !current.next_retry_at || Date.parse(now) >= Date.parse(current.next_retry_at);
  }
  if (current.status === "write_back" || current.status === "running") {
    return isDeliveryLeaseExpired(delivery, now);
  }
  return current.status === "queued";
}

/** @deprecated Use shouldFlushDelivery. */
export function shouldRetryDelivery(
  delivery: WorkDelivery,
  now: string,
): boolean {
  return shouldFlushDelivery(delivery, now);
}

export function isDeadLetter(delivery: WorkDelivery | null | undefined): boolean {
  return delivery?.status === "dead";
}

export function deliveryNeedsAttention(
  delivery:
    | Pick<WorkDelivery, "status" | "write_back">
    | Pick<WorkDeliveryFace, "status" | "write_back">
    | null
    | undefined,
): boolean {
  return delivery?.status === "dead" || delivery?.write_back === "failed";
}

export function deliveryFaceOf(
  delivery: WorkDelivery | null | undefined,
): WorkDeliveryFace | undefined {
  if (!delivery) {
    return undefined;
  }
  return {
    status: delivery.status,
    write_back: delivery.write_back,
    attempts: delivery.attempts,
    ...(delivery.last_error ? { last_error: delivery.last_error } : {}),
  };
}

export function writeBackPayloadText(
  payload: WorkDeliveryPayload | undefined,
): string {
  if (!payload) {
    return "";
  }
  const fromContent =
    payload.content
      ?.map((part) => ("text" in part && part.text ? part.text : ""))
      .find((part) => part.trim())
      ?.trim() ?? "";
  return fromContent || payload.summary.trim();
}

export function deliveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clonePayload(payload: WorkDeliveryPayload): WorkDeliveryPayload {
  return {
    summary: payload.summary,
    ...(payload.content ? { content: [...payload.content] } : {}),
  };
}
