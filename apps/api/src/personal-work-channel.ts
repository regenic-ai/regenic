import { randomUUID } from "node:crypto";
import {
  ChannelDriverRegistry,
  driverCanReply,
  INBOX_PAGE_MAX,
  INGEST_SCHEMA_VERSION,
  WORK_EVIDENCE_ANCHOR_WINDOW,
  WORK_EVIDENCE_FETCH_LIMIT,
  WORK_EVIDENCE_REPLY_DEPTH,
  channelRecord,
  deliveryChannelReceipt,
  isAbandonedWorkItem,
  matchWriteBackPrompt,
  parseConversationThread,
  pickAbsenteeInboxRows,
  recipeWantsWriteBack,
  asConnectorHost,
  requireCreateThread,
  rankThreadEvidenceLines,
  requireReplyPorts,
  toReplyParts,
  transcriptFromAbsenteeLive,
  type AuthorityStore,
  type ChannelDriver,
  type ConnectorInstallation,
  type ContentPart,
  type ConversationThread,
  type DeliveryReceipt,
  type EventRecord,
  type ExecutorContext,
  type InboxItem,
  type TaskExecutor,
  type Transcript,
  type WorkDelivery,
  type WorkEvidenceLine,
  type WorkItem,
} from "@regenic/domain";
import { resolveInboxBodies, type InboxBody } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import { stampFromThreadSurfaces } from "./personal-reply-stamp";
import { writeWorkContextFiles } from "./personal-work-context";
import { PersonalRuntimeService } from "./personal-runtime.service";
import {
  scanInboxTurns,
  type InboxTurnScan,
} from "./personal-work-reap";

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
        return requireCreateThread(found.driver)(
          found.installation,
          asConnectorHost(host),
          process.env,
          options?.cwd ? { cwd: options.cwd } : undefined,
        );
      },
      ...(this.runtime.getOptions()?.blobRoot
        ? {
            writeWorkFiles: async (
              files: Record<string, string>,
              options?: { work_item_id?: string },
            ) => this.writeWorkFiles(files, options?.work_item_id),
          }
        : {}),
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
        "unavailable",
        "Local work files need a blob root",
        503,
      );
    }
    return writeWorkContextFiles({
      blobRoot,
      orgId: this.runtime.orgId(),
      files,
      workItemId,
    });
  }

  async sendText(
    thread: ConversationThread,
    text: string,
    options?: {
      writeBack?: boolean;
      headEventId?: string;
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
    if (!found || !driverCanReply(found.driver, found.installation)) {
      throw new PersonalConnectorError(
        "no_sender",
        "No enabled connector can send in this conversation",
        404,
      );
    }
    const content = toReplyParts({ text });
    const { bindEgress, outboundId } = requireReplyPorts(found.driver);
    const egress = await bindEgress(
      found.installation,
      thread,
      asConnectorHost(host),
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
    const stamp = await this.destinationStamp(thread, options?.headEventId);
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
          external_id: outboundId(thread, receipt),
          occurred_at: now,
          actor_id: "local-owner",
          scope_id: thread.target,
          ...(stamp.scope_name ? { scope_name: stamp.scope_name } : {}),
          ...(stamp.conversation_kind
            ? { conversation_kind: stamp.conversation_kind }
            : {}),
          ...(stamp.unit_kind ? { unit_kind: stamp.unit_kind } : {}),
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
    if (found && driverCanReply(found.driver, found.installation)) {
      await this.sendText(thread, text, {
        writeBack: true,
        headEventId: item.head_event_id,
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

  async inspectSysout(threadId: string): Promise<{
    transcript: Transcript | null;
    scan: InboxTurnScan;
  }> {
    const host = this.runtime.requireHost();
    const items = await host.get("authority").listInbox(this.runtime.orgId(), {
      thread_ids: [threadId],
      siblings: true,
    });
    const newest = [...items]
      .reverse()
      .filter((row) => row.event.operation !== "tombstone");
    const hashes = newest
      .map((row) => row.event.content_hash)
      .filter((hash): hash is string => Boolean(hash));
    const bodies = await resolveInboxBodies(
      host.get("authority"),
      host.get("blobs"),
      hashes,
      "meta",
    );
    const scan = scanInboxTurns(
      newest.map((row) => {
        const body = row.event.content_hash
          ? bodies.get(row.event.content_hash)
          : undefined;
        return {
          status: row.decision.reason_codes.includes("thread_status"),
          turn: body?.surface?.turn,
          activity: body?.surface?.activity,
          text: body?.body_text,
        };
      }),
    );
    return { transcript: await this.readTranscript(threadId), scan };
  }

  /**
   * Thread lines ranked around the anchor event: the recent tail, a window
   * ending at the anchor when it is older than the tail, and its reply chain.
   */
  async threadContextLines(
    threadId: string,
    options?: { fetchLimit?: number; anchorEventId?: string },
  ): Promise<{ lines: WorkEvidenceLine[]; overflow: boolean }> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const orgId = this.runtime.orgId();
    const fetchLimit = options?.fetchLimit ?? WORK_EVIDENCE_FETCH_LIMIT;
    const rows = new Map<string, { item: InboxItem; segment: number }>();
    let segments = 0;
    const add = (items: InboxItem[]) => {
      const segment = segments++;
      for (const item of items) {
        if (!rows.has(item.event.id)) rows.set(item.event.id, { item, segment });
      }
    };
    const tail = await readThreadTail(authority, orgId, threadId, fetchLimit);
    add(tail.rows);
    let overflow = tail.overflow;

    const anchor = options?.anchorEventId
      ? await authority.getEvent(orgId, options.anchorEventId)
      : null;
    const anchorRow = anchor?.thread_id === threadId
      ? rows.get(anchor.id)?.item ?? await inboxRowOf(authority, anchor)
      : undefined;
    if (anchorRow && !rows.has(anchorRow.event.id)) {
      const window = await authority.listInbox(orgId, {
        thread_ids: [threadId],
        siblings: true,
        before: anchorRow.event.occurred_at,
        before_id: anchorRow.event.id,
        limit: WORK_EVIDENCE_ANCHOR_WINDOW,
      });
      add([...window, anchorRow]);
      overflow ||= window.length >= WORK_EVIDENCE_ANCHOR_WINDOW;
    }

    let cursor = anchorRow?.event ?? tail.rows[tail.rows.length - 1]?.event;
    for (let depth = 0; cursor && depth < WORK_EVIDENCE_REPLY_DEPTH; depth += 1) {
      const parentExternalId = cursor.attrs?.parent_external_id;
      if (typeof parentExternalId !== "string" || !parentExternalId.trim()) break;
      const loaded = [...rows.values()].find(({ item }) =>
        item.event.source === cursor!.source && item.event.external_id === parentExternalId);
      if (loaded) {
        cursor = loaded.item.event;
        continue;
      }
      const parent = await authority.findBySourceIdentity({
        org_id: orgId, source: cursor.source, external_id: parentExternalId,
      });
      const parentRow = parent?.thread_id === threadId ? await inboxRowOf(authority, parent) : undefined;
      if (!parentRow) break;
      add([parentRow]);
      cursor = parentRow.event;
    }

    const ordered = [...rows.values()].sort((left, right) =>
      left.item.event.occurred_at < right.item.event.occurred_at ? -1
        : left.item.event.occurred_at > right.item.event.occurred_at ? 1
          : left.item.event.id < right.item.event.id ? -1 : 1);
    const bodies = await resolveInboxBodies(
      authority,
      host.get("blobs"),
      ordered.map(({ item }) => item.event.content_hash),
      "meta",
    );
    return {
      overflow,
      lines: rankThreadEvidenceLines(
        ordered.map(({ item, segment }, index) => {
          const body = item.event.content_hash
            ? bodies.get(item.event.content_hash)
            : undefined;
          const parentExternalId = item.event.attrs?.parent_external_id;
          return {
            event_id: item.event.id,
            source: item.event.source,
            external_id: item.event.external_id,
            ...(typeof parentExternalId === "string" ? { parent_external_id: parentExternalId } : {}),
            occurred_at: item.event.occurred_at,
            tombstone: item.event.operation === "tombstone",
            status: item.decision.reason_codes.includes("thread_status"),
            working: body?.surface?.activity === "working",
            speaker: body?.surface?.actor_label || body?.surface?.kind,
            text: body?.body_text || attachmentEvidence(body?.attachments),
            gap_before: index > 0 && ordered[index - 1].segment !== segment,
          };
        }),
        anchorRow?.event.id,
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

  private async destinationStamp(
    thread: ConversationThread,
    headEventId?: string,
  ): Promise<{
    scope_name?: string;
    conversation_kind?: string;
    unit_kind?: string;
  }> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const threadId = `${thread.source}:${thread.target}`;
    const headEvent = headEventId
      ? await authority.getEvent(orgId, headEventId)
      : null;
    const rows = await authority.listInbox(orgId, {
      thread_ids: [threadId],
      limit: 40,
    });
    const bodies = await resolveInboxBodies(
      authority,
      host.get("blobs"),
      [headEvent?.content_hash, ...rows.map((row) => row.event.content_hash)],
      "meta",
    );
    const surfaces: Array<{
      surface?: {
        direction?: string;
        conversation_label?: string;
        conversation_kind?: string;
        unit_kind?: string;
      };
    }> = [];
    if (headEvent?.content_hash) {
      surfaces.push({ surface: bodies.get(headEvent.content_hash)?.surface });
    }
    for (const row of rows) {
      surfaces.push({
        surface: row.event.content_hash
          ? bodies.get(row.event.content_hash)?.surface
          : undefined,
      });
    }
    return stampFromThreadSurfaces(thread.target, surfaces);
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
    return driverCanReply(found.driver, found.installation);
  }
}

function attachmentEvidence(
  attachments: InboxBody["attachments"] | undefined,
): string | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  return attachments.map((attachment) =>
    `[Attachment: ${attachment.filename || attachment.media_type}]`,
  ).join(" ");
}

async function readThreadTail(
  authority: AuthorityStore,
  orgId: string,
  threadId: string,
  limit: number,
): Promise<{ rows: InboxItem[]; overflow: boolean }> {
  let rows: InboxItem[] = [];
  let before: EventRecord | undefined;
  while (rows.length <= limit) {
    const want = Math.min(INBOX_PAGE_MAX, limit + 1 - rows.length);
    const page = await authority.listInbox(orgId, {
      thread_ids: [threadId],
      siblings: true,
      limit: want,
      ...(before ? { before: before.occurred_at, before_id: before.id } : {}),
    });
    rows = [...page, ...rows];
    if (page.length < want) break;
    before = page[0].event;
  }
  const overflow = rows.length > limit;
  return { rows: overflow ? rows.slice(1) : rows, overflow };
}

async function inboxRowOf(
  authority: AuthorityStore,
  event: EventRecord,
): Promise<InboxItem | undefined> {
  const decision = await authority.getDisposition(event.id);
  return decision ? { decision, event } : undefined;
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
