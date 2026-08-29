import {
  cancelWorkRun,
  deliveryAbandoned,
  foldThreadByPolicy,
  isActiveWorkStatus,
  enqueueWriteBack,
  isAbandonedWorkItem,
  recipeTriggerOf,
  recipeWantsWriteBack,
  shouldWriteBackHandle,
  workStatusFromHandle,
  type ExecutorRunHandle,
  type Recipe,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalRuntimeService } from "./personal-runtime.service";

export class PersonalWorkSupervise {
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
  ) {}

  async refreshRuns(): Promise<void> {
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

  async refreshOne(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(run.executor_type);
    if (!executor) {
      return;
    }
    const handle = await executor.status(run, this.channel.contextFor(executor));
    await this.applyHandle(item, recipe, run, handle);
  }

  async applyHandle(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
    handle: ExecutorRunHandle,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    if (await this.abandonIfSkipped(item, run)) {
      return;
    }
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
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    await authority.putWorkRun(nextRun);
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    const status = workStatusFromHandle(handle);
    const delivery = await authority.getWorkDeliveryByItem(item.org_id, item.id);
    if (shouldWriteBackHandle(handle, recipeWantsWriteBack(recipe))) {
      if (await this.abandonIfSkipped(item, nextRun)) {
        return;
      }
      await authority.putWorkDelivery(
        enqueueWriteBack({
          org_id: item.org_id,
          work_item_id: item.id,
          recipe_id: recipe.id,
          kind: recipeTriggerOf(recipe).kind,
          unit_key: item.unit_key,
          event_id: item.head_event_id,
          payload: {
            summary: handle.result?.summary ?? "",
            content: handle.result?.content,
          },
          now,
          existing: delivery,
        }),
      );
    } else if (handle.status === "completed" && delivery && delivery.status !== "acked") {
      await authority.putWorkDelivery(deliveryAbandoned(delivery, now));
    }
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    if (item.status !== status) {
      await authority.putWorkItem({
        ...item,
        status,
        updated_at: now,
      });
      if (!isActiveWorkStatus(status)) {
        await foldThreadByPolicy(authority, item.org_id, item.thread_id, now);
      }
    }
  }

  async abandonIfSkipped(item: WorkItem, run: WorkRun): Promise<boolean> {
    const latest = await this.runtime
      .requireHost()
      .get("authority")
      .getWorkItem(item.org_id, item.id);
    if (!isAbandonedWorkItem(latest?.status)) {
      return false;
    }
    if (run.status !== "cancelled") {
      await this.runtime
        .requireHost()
        .get("authority")
        .putWorkRun(cancelWorkRun(run, new Date().toISOString()));
    }
    return true;
  }
}
