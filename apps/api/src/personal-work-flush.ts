import {
  deliveryAbandoned,
  deliveryAcked,
  deliveryClaimSend,
  deliveryErrorMessage,
  deliveryRecordReceipt,
  deliveryRetryNow,
  deliveryWriteBackFailed,
  reclaimDeliveryLease,
  shouldFlushDelivery,
  WORK_DELIVERY_SEND_TIMEOUT_MS,
  type Recipe,
  type WorkDelivery,
  type WorkItem,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { WriteBackTimeoutError, withTimeout } from "./personal-work-support";

export class PersonalWorkFlush {
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
  ) {}

  async flushDeliveries(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const now = new Date().toISOString();
    const [deliveries, recipes] = await Promise.all([
      authority.listWorkDeliveries(orgId),
      authority.listRecipes(orgId),
    ]);
    const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    for (const delivery of deliveries) {
      const reclaimed = reclaimDeliveryLease(delivery, now);
      if (reclaimed !== delivery) {
        await authority.putWorkDelivery(reclaimed);
      }
      const item = await authority.getWorkItem(orgId, reclaimed.work_item_id);
      if (item?.status === "skipped" && reclaimed.status !== "acked") {
        await authority.putWorkDelivery(deliveryAbandoned(reclaimed, now));
        continue;
      }
      const recipe = recipesById.get(reclaimed.recipe_id);
      if (!item || !recipe || !shouldFlushDelivery(reclaimed, now)) {
        continue;
      }
      await this.flushOne(item, recipe, reclaimed);
    }
  }

  async flushOne(
    item: WorkItem,
    recipe: Recipe,
    delivery: WorkDelivery,
    force = false,
  ): Promise<void> {
    const now = new Date().toISOString();
    const host = this.runtime.requireHost();
    let current = reclaimDeliveryLease(delivery, now);
    if (force) {
      current = deliveryRetryNow(current, now);
    } else if (!shouldFlushDelivery(current, now)) {
      return;
    }
    const payload = current.payload;
    if (!payload) {
      await host.get("authority").putWorkDelivery(
        deliveryWriteBackFailed(current, "Write-back has no payload", now),
      );
      return;
    }
    current = deliveryClaimSend(current, now);
    await host.get("authority").putWorkDelivery(current);
    try {
      const outcome = await withTimeout(
        this.channel.writeBack(
          item,
          payload.summary,
          payload.content,
          current,
          async (receipt, sentAt) => {
            const latest =
              (await host.get("authority").getWorkDeliveryByItem(item.org_id, item.id)) ??
              current;
            current = deliveryRecordReceipt(latest, receipt, sentAt);
            await host.get("authority").putWorkDelivery(current);
          },
        ),
        WORK_DELIVERY_SEND_TIMEOUT_MS,
      );
      const latest =
        (await host.get("authority").getWorkDeliveryByItem(item.org_id, item.id)) ??
        current;
      await host.get("authority").putWorkDelivery(deliveryAcked(latest, outcome, now));
    } catch (error) {
      if (error instanceof WriteBackTimeoutError) {
        return;
      }
      console.error("personal write-back failed", error);
      const latest =
        (await host.get("authority").getWorkDeliveryByItem(item.org_id, item.id)) ??
        current;
      await host.get("authority").putWorkDelivery(
        deliveryWriteBackFailed(latest, deliveryErrorMessage(error), now),
      );
      if (force) {
        throw error;
      }
    }
  }
}
