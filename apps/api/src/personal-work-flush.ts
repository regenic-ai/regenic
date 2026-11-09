import { randomUUID } from "node:crypto";
import {
  deliveryErrorMessage,
  isDeliveryLeaseExpired,
  shouldFlushDelivery,
  WORK_DELIVERY_SEND_TIMEOUT_MS,
  type Recipe,
  type WorkDelivery,
  type WorkDeliveryCommand,
  type WorkItem,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalConnectorError, WorkDeliveryNotSentError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { WriteBackTimeoutError, withTimeout } from "./personal-work-support";

const WRITE_BACK_CONCURRENCY = 4;

export class PersonalWorkFlush {
  private readonly owner = `work-flush:${randomUUID()}`;

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
  ) {}

  async flushDeliveries(): Promise<void> {
    const authority = this.runtime.requireHost().get("authority");
    const orgId = this.runtime.orgId();
    const now = new Date().toISOString();
    const deliveries = await authority.listDueWorkDeliveries(orgId, now);
    for (let index = 0; index < deliveries.length; index += WRITE_BACK_CONCURRENCY) {
      await Promise.all(deliveries.slice(index, index + WRITE_BACK_CONCURRENCY).map(async (delivery) => {
        let current = delivery;
        if (isDeliveryLeaseExpired(current, now)) {
          const expired = await authority.transitionWorkDelivery({
            org_id: orgId, delivery_id: current.id, kind: "expire", now,
          });
          if (expired.outcome === "conflict") return;
          current = expired.delivery;
        }
        const item = await authority.getWorkItem(orgId, current.work_item_id);
        if (!item) throw new Error(`Delivery work item no longer exists: ${current.work_item_id}`);
        if (item.status === "skipped" && !current.channel_receipt?.accepted) {
          const stopped = await authority.transitionWorkDelivery({
            org_id: orgId, delivery_id: current.id, kind: "cancel", now,
          });
          if (stopped.outcome === "conflict") throw new Error(
            `Delivery cancellation rejected: ${stopped.reason}`,
          );
          return;
        }
        if (shouldFlushDelivery(current, now)) await this.flushOne(item, undefined, current);
      }));
    }
  }

  async flushOne(
    item: WorkItem,
    _recipe: Recipe | null | undefined,
    delivery: WorkDelivery,
    force = false,
  ): Promise<void> {
    const authority = this.runtime.requireHost().get("authority");
    const claimed = await authority.transitionWorkDelivery({
      org_id: item.org_id, delivery_id: delivery.id, kind: "claim",
      owner: this.owner, force, now: new Date().toISOString(),
    });
    if (claimed.outcome === "conflict") {
      if (force) throw new PersonalConnectorError(
        "delivery_claim_conflict", "Delivery is active or requires reconciliation before retrying.", 409,
      );
      return;
    }
    const current = claimed.delivery;
    const token = current.claim_token;
    if (!token || !current.payload) throw new Error("Claimed delivery has no token or payload");
    const settle = async (
      change: Extract<WorkDeliveryCommand, { token: string }>,
    ): Promise<void> => {
      const result = await authority.transitionWorkDelivery(change);
      if (result.outcome === "conflict") throw new PersonalConnectorError(
        "delivery_claim_conflict", `Delivery settlement rejected: ${result.reason}`, 409,
      );
    };
    const identity = { org_id: item.org_id, delivery_id: delivery.id, owner: this.owner, token };
    let accepted = current.channel_receipt?.accepted === true;
    try {
      const outcome = await withTimeout(
        this.channel.writeBack(item, current.payload.summary, current.payload.content, current, async (receipt) => {
          await settle({ ...identity, kind: "receipt", receipt, now: new Date().toISOString() });
          accepted = receipt.accepted;
        }),
        WORK_DELIVERY_SEND_TIMEOUT_MS,
      );
      await settle({ ...identity, kind: outcome, now: new Date().toISOString() });
    } catch (error) {
      console.error("personal write-back failed", error);
      const kind = !(error instanceof WriteBackTimeoutError)
        && (accepted || error instanceof WorkDeliveryNotSentError) ? "failed" : "uncertain";
      const result = await authority.transitionWorkDelivery({
        ...identity, kind, error: deliveryErrorMessage(error), now: new Date().toISOString(),
      });
      if (result.outcome === "conflict") console.error("personal write-back settlement conflict", {
        delivery_id: delivery.id, reason: result.reason,
      });
      if (force) throw error;
    }
  }
}
