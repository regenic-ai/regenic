import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  ChannelDriverRegistry,
  FORWARD_MAX_TEXT,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  appendMissingAttachedLines,
  compileForwardPacket,
  driverCanReply,
  forwardIdempotencyKey,
  isForwardMode,
  parseConversationThread,
  parseStoredContentParts,
  requireReplyPorts,
  storedPartBytes,
  storedPartContentHash,
  toReplyParts,
  type ChannelDriver,
  type ConnectorInstallation,
  type ContentPart,
  type ConversationThread,
  type ForwardMode,
  type ForwardUtterance,
  type ForwardedFrom,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  PersonalConnectorError,
  PersonalConnectorService,
  wrapDriverError,
} from "./personal-connector.service";
import {
  PersonalInboxService,
  type InboxViewItem,
} from "./personal-inbox.service";
import { conversationStampForReply } from "./personal-reply.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const FOLLOW_RETURN_MS = 2_500;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface ForwardInput {
  source_thread_id?: string;
  event_ids?: string[];
  target?: { thread_id?: string; installation_id?: string; create?: boolean };
  mode?: string;
  attribution?: boolean;
  text?: string;
}

export interface ForwardView {
  accepted: true;
  source_thread_id: string;
  target_thread_id: string;
  created: boolean;
  item: InboxViewItem;
  truncated?: boolean;
}

@Injectable()
export class PersonalForwardService {
  private readonly inflight = new Map<string, Promise<ForwardView>>();

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalInboxService)
    private readonly inbox: PersonalInboxService,
    @Inject(PersonalConnectorService)
    private readonly connectors: PersonalConnectorService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async send(input: ForwardInput): Promise<ForwardView> {
    const sourceThreadId = input.source_thread_id?.trim() ?? "";
    const targetThreadId = input.target?.thread_id?.trim() ?? "";
    const installationId = input.target?.installation_id?.trim() ?? "";
    const creating = input.target?.create === true;
    const mode = input.mode;
    if (!isForwardMode(mode)) {
      throw new PersonalConnectorError(
        "invalid_forward",
        "Forward mode must be messages or transcript",
        400,
      );
    }
    let sourceThread;
    try {
      sourceThread = parseConversationThread(sourceThreadId);
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
    if (creating) {
      if (!installationId) {
        throw new PersonalConnectorError(
          "invalid_forward",
          "Creating a conversation needs an installation",
          400,
        );
      }
    } else {
      try {
        parseConversationThread(targetThreadId);
      } catch (error) {
        throw wrapDriverError(error, "invalid_config");
      }
      if (sourceThreadId === targetThreadId) {
        throw new PersonalConnectorError(
          "invalid_forward",
          "Pick a different conversation to forward to",
          400,
        );
      }
    }
    const key = forwardIdempotencyKey({
      org_id: this.runtime.orgId(),
      source_thread_id: sourceThreadId,
      event_ids: (input.event_ids ?? []).map((id) => id.trim()).filter(Boolean),
      target: creating ? `create:${installationId}` : targetThreadId,
      mode,
    });
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const run = this.sendOnce({
      sourceThreadId,
      sourceThread,
      targetThreadId,
      installationId,
      creating,
      mode,
      eventIds: input.event_ids,
      attribution: input.attribution,
      text: input.text,
    }).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async sendOnce(input: {
    sourceThreadId: string;
    sourceThread: ReturnType<typeof parseConversationThread>;
    targetThreadId: string;
    installationId: string;
    creating: boolean;
    mode: ForwardMode;
    eventIds?: string[];
    attribution?: boolean;
    text?: string;
  }): Promise<ForwardView> {
    const host = this.runtime.requireHost();
    const items = await this.loadSourceItems(
      input.sourceThreadId,
      input.mode,
      input.eventIds,
    );
    const utterances = await this.toUtterances(items, host);
    if (utterances.length === 0) {
      throw new PersonalConnectorError(
        "invalid_forward",
        "Nothing to forward from this conversation",
        400,
      );
    }
    const packet = compileForwardPacket({
      source_thread_id: input.sourceThreadId,
      source: input.sourceThread.source,
      mode: input.mode,
      attribution: input.attribution,
      title: items[0]?.title ?? items[0]?.conversation_label ?? undefined,
      utterances,
    });
    let text = (input.text ?? packet.text).trim();
    const taken = takeForwardAttachments(packet.attachments);
    const attachments = taken.kept;
    if (text.length === 0 && attachments.length === 0) {
      throw new PersonalConnectorError(
        "invalid_forward",
        "Forward needs text or an attachment",
        400,
      );
    }
    if (text.length > FORWARD_MAX_TEXT) {
      throw new PersonalConnectorError(
        "invalid_forward",
        `Forward text must be ${FORWARD_MAX_TEXT} characters or fewer`,
        400,
      );
    }
    const prepared = await this.stageAttachments(attachments);
    if (input.creating && prepared.length > 0) {
      text = appendMissingAttachedLines(
        text,
        prepared.map((file) => file.filename),
      );
    }
    let found: {
      installation: ConnectorInstallation;
      driver: ChannelDriver;
      thread: ConversationThread;
      create_with_task: boolean;
    };
    if (input.creating) {
      const opened = await this.connectors.openCreatedThread({
        installation_id: input.installationId,
        text,
      });
      found = {
        installation: opened.installation,
        driver: opened.driver,
        thread: opened.thread,
        create_with_task: opened.create_with_task,
      };
    } else {
      const installations = await host
        .get("authority")
        .listInstallations(this.runtime.orgId());
      const thread = parseConversationThread(input.targetThreadId);
      const matched = this.drivers.findForThread(installations, thread);
      if (!matched || !driverCanReply(matched.driver, matched.installation)) {
        throw new PersonalConnectorError(
          "no_sender",
          "No enabled connector can send in that conversation",
          404,
        );
      }
      found = {
        installation: matched.installation,
        driver: matched.driver,
        thread,
        create_with_task: false,
      };
    }
    const targetThreadId = `${found.thread.source}:${found.thread.target}`;
    const seedOnly = found.create_with_task && text.length > 0;
    const content: ContentPart[] = [
      ...(text
        ? [{ role: "body" as const, media_type: "text/markdown", text }]
        : []),
      ...prepared.map(
        (attachment): ContentPart => ({
          role: "attachment",
          media_type: attachment.media_type,
          source_filename: attachment.filename,
          bytes: attachment.bytes,
        }),
      ),
    ];
    let receipt: { accepted: true; rpc_id: string } = {
      accepted: true,
      rpc_id: randomUUID(),
    };
    const outboundId =
      found.driver.outboundId?.bind(found.driver) ??
      ((_thread: ConversationThread, sent: { rpc_id?: string }) =>
        `${found.thread.target}:out:${sent.rpc_id ?? randomUUID()}`);
    if (!seedOnly) {
      if (!driverCanReply(found.driver, found.installation)) {
        throw new PersonalConnectorError(
          "no_sender",
          "No enabled connector can send in that conversation",
          404,
        );
      }
      try {
        const ports = requireReplyPorts(found.driver);
        const egress = await ports.bindEgress(
          found.installation,
          found.thread,
          host,
          process.env,
        );
        receipt = {
          accepted: true,
          rpc_id:
            (
              await egress.send({
                installation_id: found.installation.id,
                target: { scope_id: found.thread.target },
                content,
              })
            ).rpc_id ?? receipt.rpc_id,
        };
      } catch (error) {
        throw wrapDriverError(error, "send_failed");
      }
    }

    const now = new Date().toISOString();
    const stamp = await this.conversationStamp(targetThreadId, {
      installationId: found.installation.id,
      host,
    });
    const record = channelRecord({
      channel: found.driver.source ?? found.thread.source,
      kind: "user",
      direction: "outbound",
      external_id: outboundId(found.thread, receipt),
      occurred_at: now,
      actor_id: "local-owner",
      scope_id: found.thread.target,
      ...(stamp.scope_name ? { scope_name: stamp.scope_name } : {}),
      ...(stamp.conversation_kind
        ? { conversation_kind: stamp.conversation_kind }
        : {}),
      forwarded_from: packet.forwarded_from,
      content: toReplyParts({
        text,
        attachments: prepared.map((attachment) => ({
          filename: attachment.filename,
          media_type: attachment.media_type,
          bytes: attachment.bytes,
        })),
      }),
    });
    record.weight_hints = { importance: 1 };
    const ingested = await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: found.installation.id,
      org_id: this.runtime.orgId(),
      delivery_id: `forward:${randomUUID()}`,
      received_at: now,
      records: [record],
    });
    if (!ingested.valid) {
      throw new PersonalConnectorError(
        "send_failed",
        "Forward was delivered but could not be stored",
        502,
      );
    }
    await this.rememberSourceForward({
      sourceThread: input.sourceThread,
      targetThreadId,
      targetSource: found.thread.source,
      eventIds: packet.forwarded_from.event_ids,
      fallbackConnectorId: found.installation.id,
      host,
      now,
    });
    const eventId = ingested.records[0]?.event_id;
    const followed = this.connectors
      .followThread(found.installation.id, found.thread)
      .catch(() => undefined);
    await Promise.race([followed, delay(FOLLOW_RETURN_MS)]);
    const item = eventId ? await this.inbox.getInboxItem(eventId) : null;
    if (!item) {
      throw new PersonalConnectorError(
        "send_failed",
        "Forward was delivered but did not enter current work",
        502,
      );
    }
    return {
      accepted: true,
      source_thread_id: input.sourceThreadId,
      target_thread_id: targetThreadId,
      created: input.creating,
      item,
      ...(packet.truncated || taken.dropped > 0 ? { truncated: true } : {}),
    };
  }

  private async loadSourceItems(
    sourceThreadId: string,
    mode: ForwardMode,
    eventIds?: string[],
  ): Promise<InboxViewItem[]> {
    const requested = (eventIds ?? []).map((id) => id.trim()).filter(Boolean);
    if (mode === "messages" && requested.length === 0) {
      throw new PersonalConnectorError(
        "invalid_forward",
        "Forward messages needs at least one event id",
        400,
      );
    }
    if (requested.length > 0) {
      const items: InboxViewItem[] = [];
      for (const eventId of requested) {
        const item = await this.inbox.getInboxItem(eventId);
        if (!item || item.thread_id !== sourceThreadId) {
          throw new PersonalConnectorError(
            "invalid_forward",
            "A selected message is not in this conversation",
            400,
          );
        }
        if ((item.record_class ?? "utterance") === "utterance") {
          items.push(item);
        }
      }
      return items;
    }
    const listed = await this.inbox.listInbox({
      thread_id: sourceThreadId,
      limit: 200,
    });
    return listed.filter((item) => (item.record_class ?? "utterance") === "utterance");
  }

  private async toUtterances(
    items: InboxViewItem[],
    host: Host,
  ): Promise<ForwardUtterance[]> {
    const blobs = host.get("blobs");
    const authority = host.get("authority");
    const utterances: ForwardUtterance[] = [];
    for (const item of items) {
      utterances.push({
        event_id: item.event.id,
        occurred_at: item.event.occurred_at,
        channel_label: item.channel_label,
        actor_label: item.actor_label,
        body_text: item.body_text,
        attachments: await loadAttachmentBytes(item, blobs, authority),
      });
    }
    return utterances;
  }

  private async rememberSourceForward(input: {
    sourceThread: ConversationThread;
    targetThreadId: string;
    targetSource: string;
    eventIds: string[];
    fallbackConnectorId: string;
    host: Host;
    now: string;
  }): Promise<void> {
    try {
      const installations = await input.host
        .get("authority")
        .listInstallations(this.runtime.orgId());
      const matched = this.drivers.findForThread(
        installations,
        input.sourceThread,
      );
      const ingested = await input.host.get("ingest").ingest({
        schema_version: INGEST_SCHEMA_VERSION,
        connector_id: matched?.installation.id ?? input.fallbackConnectorId,
        org_id: this.runtime.orgId(),
        delivery_id: `forward-trace:${randomUUID()}`,
        received_at: input.now,
        records: [
          channelRecord({
            channel: input.sourceThread.source,
            kind: "system",
            direction: "outbound",
            type: "thread_status",
            external_id: `${input.sourceThread.target}:out:fwd-${randomUUID()}`,
            occurred_at: input.now,
            actor_id: "local-owner",
            scope_id: input.sourceThread.target,
            text: "",
            forwarded_to: {
              thread_id: input.targetThreadId,
              event_ids: input.eventIds,
              source: input.targetSource,
            },
          }),
        ],
      });
      if (!ingested.valid) {
        return;
      }
    } catch {
      // Destination already sent. A missing source chip is not a failed forward.
    }
  }

  private async conversationStamp(
    threadId: string,
    bound: { installationId: string; host: Host },
  ): Promise<{ scope_name?: string; conversation_kind?: string }> {
    const thread = parseConversationThread(threadId);
    const stream = bound.host
      .get("connectors")
      .listStreams(bound.installationId)
      .find((item) => item.thread_id === threadId);
    const head = (
      await this.inbox.listInbox({
        thread_id: threadId,
        heads: true,
        limit: 1,
      })
    )[0];
    return conversationStampForReply({
      target: thread.target,
      streamLabel: stream?.label,
      headLabel: head?.conversation_label,
      headKind: head?.conversation_kind,
    });
  }

  private async stageAttachments(
    attachments: Array<{ filename: string; media_type: string; bytes: Uint8Array }>,
  ): Promise<Array<{ filename: string; media_type: string; bytes: Uint8Array }>> {
    const options = this.runtime.getOptions();
    if (!options) {
      throw new PersonalConnectorError(
        "not_configured",
        "Personal kernel is not running",
        503,
      );
    }
    const batchId = randomUUID();
    const staged = [];
    for (const attachment of attachments) {
      const directory = join(options.blobRoot, "outbound", batchId);
      await mkdir(directory, { recursive: true });
      const filename = safeFilename(attachment.filename);
      await writeFile(join(directory, filename), attachment.bytes);
      staged.push({
        filename,
        media_type: attachment.media_type,
        bytes: attachment.bytes,
      });
    }
    return staged;
  }
}

async function loadAttachmentBytes(
  item: InboxViewItem,
  blobs: { getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>> },
  authority: {
    findBlob(
      hash: string,
    ): Promise<{ media_type: string } | null>;
  },
): Promise<ForwardUtterance["attachments"]> {
  const hash = item.event.content_hash;
  if (!hash) {
    return [];
  }
  const envelope = (await blobs.getMany([hash])).get(hash);
  if (!envelope) {
    return [];
  }
  const meta = await authority.findBlob(hash);
  if (meta?.media_type !== CONTENT_PARTS_MEDIA_TYPE) {
    return [];
  }
  const parts = parseStoredContentParts(envelope) ?? [];
  const sidecarHashes = parts
    .map((part) => storedPartContentHash(part))
    .filter((value): value is string => Boolean(value));
  const sidecars = await blobs.getMany(sidecarHashes);
  const attachments: NonNullable<ForwardUtterance["attachments"]> = [];
  for (const part of parts) {
    if (part.role !== "attachment") {
      continue;
    }
    const partHash = storedPartContentHash(part);
    const bytes = (partHash ? sidecars.get(partHash) : undefined) ?? storedPartBytes(part);
    if (!bytes || bytes.byteLength === 0) {
      continue;
    }
    attachments.push({
      filename: part.source_filename?.trim() || "attachment",
      media_type: part.media_type ?? "application/octet-stream",
      bytes,
    });
  }
  return attachments;
}

function takeForwardAttachments(
  attachments: Array<{ filename: string; media_type: string; bytes: Uint8Array }>,
): {
  kept: Array<{ filename: string; media_type: string; bytes: Uint8Array }>;
  dropped: number;
} {
  const kept = [];
  let dropped = 0;
  for (const attachment of attachments) {
    if (kept.length >= MAX_ATTACHMENTS) {
      dropped += 1;
      continue;
    }
    if (
      attachment.bytes.byteLength === 0 ||
      attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES
    ) {
      dropped += 1;
      continue;
    }
    kept.push(attachment);
  }
  return { kept, dropped };
}

function safeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, "").replace(/^\.+/g, "").trim();
  return (base.length > 0 ? base : "attachment").slice(0, 120);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type { ForwardedFrom };
