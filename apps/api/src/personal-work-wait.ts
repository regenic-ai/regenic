import {
  ChannelDriverRegistry,
  asConnectorHost,
  isActiveWorkStatus,
  parseConversationThread,
  type ConversationThread,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { PersonalWorkSupervise } from "./personal-work-supervise";

const WAIT_COALESCE_MS = 20;

/**
 * Absentee wait(2) for a running inferior. Drivers expose a wait fd
 * (DSH mux session/event). The kernel follow/polls that sysout, then
 * reaps. History poll remains catch-up.
 */
export class PersonalWorkWait {
  private readonly byRun = new Map<string, () => void>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waking = new Set<string>();

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly drivers: ChannelDriverRegistry,
    private readonly connectors: PersonalConnectorService,
    private readonly supervise: PersonalWorkSupervise,
  ) {}

  attached(runId: string): boolean {
    return this.byRun.has(runId);
  }

  drop(runId: string): void {
    const dispose = this.byRun.get(runId);
    this.byRun.delete(runId);
    dispose?.();
  }

  dropAll(): void {
    for (const runId of [...this.byRun.keys()]) {
      this.drop(runId);
    }
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  async attachActive(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const items = await host.get("authority").listWorkItems(orgId);
    for (const item of items) {
      if (!isActiveWorkStatus(item.status) || !item.recipe_id) {
        continue;
      }
      const recipe = await host.get("authority").getRecipe(orgId, item.recipe_id);
      const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
      if (!recipe || !run) {
        continue;
      }
      const executor = host.get("executors").get(run.executor_type);
      if (!executor) {
        continue;
      }
      this.attach(item, run, executor);
    }
  }

  attach(
    item: WorkItem,
    run: WorkRun,
    executor: TaskExecutor,
  ): void {
    if (!executor.capabilities().wait) {
      return;
    }
    if (!isActiveWorkStatus(item.status)) {
      return;
    }
    const sysoutId = run.agent_thread_id ?? run.external_run_id;
    if (!sysoutId) {
      return;
    }
    this.drop(run.id);
    let thread: ConversationThread;
    try {
      thread = parseConversationThread(sysoutId);
    } catch {
      return;
    }
    void this.attachForThread(item, run, thread);
  }

  private async attachForThread(
    item: WorkItem,
    run: WorkRun,
    thread: ConversationThread,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(item.org_id);
    const found = this.drivers.findForThread(installations, thread);
    if (!found?.driver.waitThread) {
      return;
    }
    const dispose = found.driver.waitThread(
      found.installation,
      thread,
      asConnectorHost(host),
      process.env,
      () => this.scheduleWake(item.id),
    );
    if (!dispose) {
      return;
    }
    this.byRun.set(run.id, dispose);
    this.scheduleWake(item.id);
  }

  private scheduleWake(itemId: string): void {
    const existing = this.pending.get(itemId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pending.delete(itemId);
      void this.wake(itemId);
    }, WAIT_COALESCE_MS);
    timer.unref?.();
    this.pending.set(itemId, timer);
  }

  private async wake(itemId: string): Promise<void> {
    if (this.waking.has(itemId) || !this.runtime.isReady()) {
      return;
    }
    this.waking.add(itemId);
    try {
      const host = this.runtime.requireHost();
      const item = await host.get("authority").getWorkItem(
        this.runtime.orgId(),
        itemId,
      );
      if (!item?.recipe_id || !isActiveWorkStatus(item.status)) {
        return;
      }
      const recipe = await host.get("authority").getRecipe(item.org_id, item.recipe_id);
      const run = await host.get("authority").getActiveWorkRun(item.org_id, item.id);
      if (!recipe || !run) {
        return;
      }
      const sysoutId = run.agent_thread_id ?? run.external_run_id;
      if (sysoutId) {
        try {
          const thread = parseConversationThread(sysoutId);
          const installations = await host
            .get("authority")
            .listInstallations(item.org_id);
          const found = this.drivers.findForThread(installations, thread);
          if (found) {
            await this.connectors.followThread(found.installation.id, thread);
          }
        } catch {
          // Follow is best-effort; status still reads the local transcript.
        }
      }
      await this.supervise.refreshOne(item, recipe, run);
      const latest = await host.get("authority").getWorkItem(item.org_id, item.id);
      const latestRun = await host.get("authority").getActiveWorkRun(item.org_id, item.id);
      if (!latest || !isActiveWorkStatus(latest.status) || !latestRun) {
        this.drop(run.id);
      }
    } finally {
      this.waking.delete(itemId);
    }
  }
}
