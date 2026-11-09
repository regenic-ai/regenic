import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalContextJson } from "./context-canonical";
import type { ContentPart } from "./ingestion";
import type { DeliveryReceipt } from "./egress";
import type { RecipeTriggerKind, WorkWriteBackTarget } from "./work";
import type {
  WorkDelivery,
  WorkDeliveryFace,
  WorkDeliveryStatus,
  WorkWriteBackState,
  WorkRun,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
} from "./work";

export function assertWorkDeliveryWrite(
  delivery: WorkDelivery,
  current?: WorkDelivery | null,
  run?: WorkRun | null,
  commandWrite = false,
): void {
  if (!commandWrite && (current?.claim_token || delivery.claim_token || delivery.lease_owner
    || current?.cancel_requested_at || delivery.cancel_requested_at)) {
    throw new Error("Claimed delivery must be updated through the atomic delivery command");
  }
  if (delivery.run_id && (!run || run.id !== delivery.run_id
    || run.org_id !== delivery.org_id || run.work_item_id !== delivery.work_item_id
    || run.write_back_required !== true || !delivery.target
    || !isDeepStrictEqual(run.write_back_target, delivery.target))) {
    throw new Error("Delivery must belong to its run and frozen write-back target");
  }
  if (current && (current.org_id !== delivery.org_id
    || current.work_item_id !== delivery.work_item_id
    || current.run_id !== delivery.run_id
    || (current.run_id && canonicalContextJson({
      target: current.target, payload: current.payload, idempotency_key: current.idempotency_key,
    }) !== canonicalContextJson({
      target: delivery.target, payload: delivery.payload, idempotency_key: delivery.idempotency_key,
    })))) {
    throw new Error("Delivery request identity, target and payload are immutable");
  }
  if ((!delivery.run_id && delivery.target)
    || (delivery.run_id && (!delivery.payload || !delivery.idempotency_key?.trim()))) {
    throw new Error("Run-backed delivery needs a frozen payload, target and idempotency key");
  }
}

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
    value === "dead" ||
    value === "uncertain"
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
  run_id?: string;
  target?: WorkWriteBackTarget;
}): WorkDelivery {
  const existing = input.existing?.run_id === input.run_id ? input.existing : undefined;
  if (input.run_id && existing) {
    if (existing.org_id !== input.org_id || existing.work_item_id !== input.work_item_id
      || canonicalContextJson({ target: existing.target, payload: existing.payload })
        !== canonicalContextJson({ target: input.target, payload: input.payload })) {
      throw new Error("Delivery request identity, target and payload are immutable");
    }
    return existing;
  }
  const id = input.run_id ? `deliv-${randomUUID()}` : existing?.id ?? `deliv-${randomUUID()}`;
  const idempotency_key = input.run_id ? `work-back:${id}` : writeBackIdempotencyKey(input.work_item_id, input.payload);
  if (existing && deliveryPayloadKey(existing) === idempotency_key) {
    return existing.idempotency_key
      ? existing
      : { ...existing, idempotency_key };
  }
  return {
    id,
    org_id: input.org_id,
    work_item_id: input.work_item_id,
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.target ? { target: { ...input.target } } : {}),
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
    status: "uncertain",
    write_back: "pending",
    last_error: "Delivery acceptance is unknown. Reconcile before retrying.",
    next_retry_at: undefined,
    lease_expires_at: undefined,
    updated_at: now,
  };
}

export function deliveryRetryNow(delivery: WorkDelivery, now: string): WorkDelivery {
  if (delivery.status === "uncertain") {
    throw new Error("Uncertain delivery requires reconciliation before retrying");
  }
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
  const expires = Date.parse(delivery.lease_expires_at);
  return !Number.isFinite(expires) || Date.parse(now) >= expires;
}

export function reclaimDeliveryLease(
  delivery: WorkDelivery,
  now: string,
): WorkDelivery {
  if (!isDeliveryLeaseExpired(delivery, now)) {
    return delivery;
  }
  return deliverySendTimedOut(delivery, now);
}

export function shouldFlushDelivery(
  delivery: WorkDelivery,
  now: string,
): boolean {
  const current = reclaimDeliveryLease(delivery, now);
  if (current.status === "uncertain") return current.channel_receipt?.accepted === true;
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
  return delivery?.status === "dead" || delivery?.status === "uncertain" || delivery?.write_back === "failed";
}

export function planWorkDeliveryCommand(
  current: WorkDelivery | null,
  itemStatus: string | undefined,
  input: WorkDeliveryCommand,
): WorkDeliveryCommandResult {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("Delivery command requires a valid timestamp");
  if (!current) return { outcome: "conflict", reason: "missing_delivery" };
  if (current.org_id !== input.org_id || current.id !== input.delivery_id) {
    throw new Error("Delivery command identity mismatch");
  }
  const applied = (delivery: WorkDelivery): WorkDeliveryCommandResult => ({ outcome: "applied", delivery });
  if (input.kind === "expire") {
    return isDeliveryLeaseExpired(current, input.now)
      ? applied(deliverySendTimedOut(current, input.now))
      : { outcome: "conflict", reason: "not_claimable" };
  }
  if (input.kind === "cancel") {
    if (current.status === "acked") return applied(current);
    const unsafe = current.status === "uncertain" || current.status === "running"
      || (current.status === "write_back" && current.write_back !== "failed")
      || current.channel_receipt?.accepted === true;
    return applied({
      ...(unsafe ? current : deliveryAbandoned(current, input.now)),
      cancel_requested_at: current.cancel_requested_at ?? input.now,
      updated_at: input.now,
    });
  }
  if (input.kind === "claim") {
    if (!input.owner.trim()) throw new Error("Delivery claim requires an owner");
    if (!itemStatus) throw new Error("Delivery work item identity is unknown");
    const localRecovery = current.channel_receipt?.accepted === true;
    const ready = current.status === "uncertain" ? localRecovery
      : (current.status === "queued" || current.write_back === "failed" || current.status === "dead")
        && (input.force || shouldFlushDelivery(current, input.now));
    if (!ready || current.status === "acked" || !current.payload
      || ((itemStatus === "skipped" || current.cancel_requested_at) && !localRecovery)) {
      return { outcome: "conflict", reason: "not_claimable" };
    }
    return applied({
      ...deliveryClaimSend(input.force && current.status !== "uncertain"
        ? deliveryRetryNow(current, input.now) : current, input.now),
      lease_owner: input.owner,
      claim_token: randomUUID(),
    });
  }
  if (!input.owner.trim() || !input.token.trim()
    || current.lease_owner !== input.owner || current.claim_token !== input.token) {
    return { outcome: "conflict", reason: "stale_claim" };
  }
  if (input.kind === "receipt") {
    if (input.receipt?.accepted !== true) throw new Error("Receipt must prove channel acceptance");
    if (current.channel_receipt?.accepted && current.channel_receipt.rpc_id
      && current.channel_receipt.rpc_id !== input.receipt.rpc_id) {
      return { outcome: "conflict", reason: "receipt_conflict" };
    }
    // Retained claim evidence may merge acceptance after expiry, never settle a newer claim.
    const needsRecovery = current.status === "dead"
      || (current.status === "acked" && current.write_back !== "sent")
      || current.write_back === "failed";
    return applied(deliveryRecordReceipt(
      needsRecovery ? deliverySendTimedOut(current, input.now) : current, input.receipt, input.now,
    ));
  }
  const expires = current.lease_expires_at ? Date.parse(current.lease_expires_at) : NaN;
  if (current.status !== "write_back" || !Number.isFinite(expires) || expires <= Date.parse(input.now)) {
    return { outcome: "conflict", reason: "stale_claim" };
  }
  if (input.kind === "renew") return applied({
    ...current,
    lease_expires_at: new Date(Date.parse(input.now) + WORK_DELIVERY_LEASE_MS).toISOString(),
    updated_at: input.now,
  });
  if (input.kind === "sent") return applied(deliveryAcked(current, "sent", input.now));
  if (input.kind === "skipped") {
    return applied(current.channel_receipt?.accepted
      ? deliverySendTimedOut(current, input.now) : deliveryAcked(current, "skipped", input.now));
  }
  if (input.kind === "uncertain") return applied({
    ...deliverySendTimedOut(current, input.now),
    ...(input.error ? { last_error: input.error } : {}),
  });
  if (!input.error?.trim()) throw new Error("Delivery failure requires an error");
  return applied(deliveryWriteBackFailed(current, input.error, input.now));
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
