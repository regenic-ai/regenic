import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChannelDriverRegistry,
  INGEST_SCHEMA_VERSION,
  WORK_EVIDENCE_FETCH_LIMIT,
  channelRecord,
  deliveryChannelReceipt,
  isAbandonedWorkItem,
  matchWriteBackPrompt,
  parseConversationThread,
  pickAbsenteeInboxRows,
  recipeWantsWriteBack,
  selectThreadEvidenceLines,
  toReplyParts,
  transcriptFromAbsenteeLive,
  type ChannelDriver,
  type ConnectorInstallation,
  type ContentPart,
  type ConversationThread,
  type DeliveryReceipt,
  type ExecutorContext,
  type TaskExecutor,
  type Transcript,
  type WorkDelivery,
  type WorkEvidenceLine,
  type WorkItem,
} from "@regenic/domain";
import { resolveInboxBodies } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";

export class PersonalWorkChannel {
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  contextFor(executor: TaskExecutor): ExecutorContext {
    return {
      org_id: this.runtime.orgId(),
      env: process.env,
      spawnSysout: async (options) => {
        const host = this.runtime.requireHost();
        const installations = await host
          .get("authority")
          .listInstallations(this.runtime.orgId());
        const catalog = executor.catalog();
        const pin = catalog.installation_id?.trim();
        const found = pin
          ? pinnedCreatable(this.drivers, installations, pin)
          : this.drivers.findCreatable(installations, catalog.source);
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
          options?.cwd ? { cwd: options.cwd } : undefined,
        );
      },
      writeWorkFiles: async (files, options) =>
        this.writeWorkFiles(files, options?.work_item_id),
      writeStdin: async (thread, text) => {
        await this.sendText(thread, text);
      },
      listPrompts: async (thread) => {
        const host = this.runtime.requireHost();
        const installations = await host
          .get("authority")
          .listInstallations(this.runtime.orgId());
        return this.drivers.listPrompts(installations, thread, host);
      },
      readTranscript: async (sysoutId) => this.readTranscript(sysoutId),
    };
  }

  async writeWorkFiles(
    files: Record<string, string>,
    workItemId?: string,
  ): Promise<{ cwd: string }> {
    const blobRoot = this.runtime.getOptions()?.blobRoot;
    if (!blobRoot) {
      throw new PersonalConnectorError(
        "kernel_stopped",
        "Local work files need a blob root",
        503,
      );
    }
    const folder = workItemId?.replace(/[^A-Za-z0-9._-]/g, "") || randomUUID();
    const cwd = join(blobRoot, "work-context", this.runtime.orgId(), folder);
    await mkdir(cwd, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "") || "file.txt";
      await writeFile(join(cwd, safe), body, "utf8");
    }
    return { cwd };
  }

  async sendText(
    thread: ConversationThread,
    text: string,
    options?: {
      writeBack?: boolean;
      idempotency_key?: string;
      receipt?: DeliveryReceipt;
      onReceipt?: (receipt: DeliveryReceipt, now: string) => Promise<void>;
    },
  ): Promise<DeliveryReceipt> {
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
    const receipt =
      options?.receipt ??
      (await egress.send({
        installation_id: found.installation.id,
        target: { scope_id: thread.target },
        content,
        ...(options?.idempotency_key
          ? { idempotency_key: options.idempotency_key }
          : {}),
      }));
    const now = new Date().toISOString();
    if (options?.onReceipt) {
      await options.onReceipt(receipt, now);
    }
    await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: found.installation.id,
      org_id: this.runtime.orgId(),
      delivery_id:
        options?.idempotency_key ??
        `${options?.writeBack ? "work-back" : "work-exec"}:${randomUUID()}`,
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
    return receipt;
  }

  async writeBack(
    item: WorkItem,
    summary: string,
    content: ContentPart[] | undefined,
    delivery?: WorkDelivery,
    onReceipt?: (receipt: DeliveryReceipt, now: string) => Promise<void>,
  ): Promise<"sent" | "skipped"> {
    const recipe = item.recipe_id
      ? await this.runtime
          .requireHost()
          .get("authority")
          .getRecipe(item.org_id, item.recipe_id)
      : null;
    if (!recipe || !recipeWantsWriteBack(recipe)) {
      return "skipped";
    }
    const latest = await this.runtime
      .requireHost()
      .get("authority")
      .getWorkItem(item.org_id, item.id);
    if (isAbandonedWorkItem(latest?.status)) {
      return "skipped";
    }
    const thread = parseConversationThread(item.thread_id);
    const text =
      content
        ?.map((part) => ("text" in part && part.text ? part.text : ""))
        .find((part) => part.trim())
        ?.trim() ?? summary;
    if (!text.trim()) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Write-back has no text",
        400,
      );
    }
    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(item.org_id);
    const found = this.drivers.findForThread(installations, thread);
    const recorded = deliveryChannelReceipt(delivery);
    if (found?.driver.canReply(found.installation)) {
      await this.sendText(thread, text, {
        writeBack: true,
        idempotency_key: delivery?.idempotency_key,
        receipt: recorded,
        onReceipt,
      });
      return "sent";
    }
    if (recorded) {
      if (onReceipt) {
        await onReceipt(recorded, new Date().toISOString());
      }
      return "sent";
    }
    const prompts = await this.drivers.listPrompts(installations, thread, host);
    const answer = matchWriteBackPrompt(
      prompts,
      text,
      (label) => found?.driver.writeBackLabels?.(label) ?? [label.trim()].filter(Boolean),
    );
    if (!answer) {
      throw new PersonalConnectorError(
        "invalid_config",
        prompts.length === 0
          ? "Write-back has no live prompt on this conversation"
          : "Write-back needs a prompt option that matches the result",
        400,
      );
    }
    const accepted = await this.drivers.answerPrompt(
      installations,
      thread,
      answer,
      host,
    );
    if (!accepted.accepted) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Write-back prompt was not accepted",
        502,
      );
    }
    if (onReceipt) {
      await onReceipt({ accepted: true }, new Date().toISOString());
    }
    return "sent";
  }

  async readTranscript(threadId: string): Promise<Transcript | null> {
    const host = this.runtime.requireHost();
    const items = await host.get("authority").listInbox(this.runtime.orgId(), {
      thread_ids: [threadId],
      siblings: true,
    });
    const { live, visible } = pickAbsenteeInboxRows(items);
    if (!live) {
      return null;
    }
    const hashes = [live.event.content_hash];
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
    const body = visible?.event.content_hash
      ? (bodies.get(visible.event.content_hash) ?? liveBody)
      : liveBody;
    return transcriptFromAbsenteeLive({
      liveKind: liveBody.surface?.kind,
      liveActivity: liveBody.surface?.activity,
      liveTurn: liveBody.surface?.turn,
      visibleKind: body.surface?.kind,
      visibleText: body.body_text,
      visibleActivity: body.surface?.activity,
    });
  }

  async threadContextLines(
    threadId: string,
    options?: { fetchLimit?: number },
  ): Promise<{ lines: WorkEvidenceLine[]; overflow: boolean }> {
    const host = this.runtime.requireHost();
    const fetchLimit = options?.fetchLimit ?? WORK_EVIDENCE_FETCH_LIMIT;
    const items = await host.get("authority").listInbox(this.runtime.orgId(), {
      thread_ids: [threadId],
      siblings: true,
      limit: fetchLimit + 1,
    });
    const overflow = items.length > fetchLimit;
    const windowed = overflow ? items.slice(1) : items;
    const bodies = await resolveInboxBodies(
      host.get("authority"),
      host.get("blobs"),
      windowed.map((row) => row.event.content_hash),
      "meta",
    );
    return {
      overflow,
      lines: selectThreadEvidenceLines(
        windowed.map((row) => {
          const body = row.event.content_hash
            ? bodies.get(row.event.content_hash)
            : undefined;
          return {
            tombstone: row.event.operation === "tombstone",
            status: row.decision.reason_codes.includes("thread_status"),
            working: body?.surface?.activity === "working",
            speaker: body?.surface?.actor_label || body?.surface?.kind,
            text: body?.body_text,
          };
        }),
      ),
    };
  }

  async evidenceText(
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

  async canReplyThread(threadId: string): Promise<boolean | undefined> {
    let thread;
    try {
      thread = parseConversationThread(threadId);
    } catch {
      return undefined;
    }
    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    const found = this.drivers.findForThread(installations, thread);
    if (!found) {
      return undefined;
    }
    return found.driver.canReply(found.installation);
  }
}

function pinnedCreatable(
  drivers: ChannelDriverRegistry,
  installations: ConnectorInstallation[],
  installationId: string,
): { installation: ConnectorInstallation; driver: ChannelDriver } | undefined {
  const installation = installations.find((item) => item.id === installationId);
  if (!installation || installation.status !== "enabled") {
    return undefined;
  }
  const driver = drivers.get(installation.connector_type);
  if (!driver?.capabilities(installation).create) {
    return undefined;
  }
  return { installation, driver };
}
