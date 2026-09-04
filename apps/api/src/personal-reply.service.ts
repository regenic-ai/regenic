import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  driverCanReply,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  parseConversationThread,
  asConnectorHost,
  requireReplyPorts,
  toReplyParts,
  type ContentPart,
  type DeliveryReceipt,
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
import { conversationStampForReply } from "./personal-reply-stamp";
import { PersonalRuntimeService } from "./personal-runtime.service";

export {
  conversationStampForReply,
  stampFromThreadSurfaces,
  usableConversationName,
} from "./personal-reply-stamp";

const MAX_TEXT = 32_000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
]);

export interface ReplyAttachmentInput {
  filename?: string;
  media_type?: string;
  data_base64?: string;
}

export interface ReplyInput {
  thread_id?: string;
  text?: string;
  reply_to_event_id?: string;
  attachments?: ReplyAttachmentInput[];
  /** Client txn id (Matrix/Slack style). Retries with the same key do not double-send. */
  client_request_id?: string;
}

export interface ReplyView {
  accepted: true;
  source: string;
  thread_id: string;
  rpc_id?: string;
  client_request_id?: string;
  item: InboxViewItem;
}

interface PreparedAttachment {
  filename: string;
  media_type: string;
  bytes: Uint8Array;
  path: string;
}

@Injectable()
export class PersonalReplyService {
  private readonly sendingByClient = new Map<string, Promise<ReplyView>>();

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

  async send(input: ReplyInput): Promise<ReplyView> {
    const clientRequestId = input.client_request_id?.trim() || undefined;
    if (!clientRequestId) {
      return this.sendOnce(input, undefined);
    }
    const key = this.clientKey(clientRequestId);
    const inflight = this.sendingByClient.get(key);
    if (inflight) {
      return inflight;
    }
    // Register before any await so concurrent retries coalesce on this promise.
    const run = this.runIdempotentSend(input, clientRequestId).finally(() => {
      this.sendingByClient.delete(key);
    });
    this.sendingByClient.set(key, run);
    return run;
  }

  private async runIdempotentSend(
    input: ReplyInput,
    clientRequestId: string,
  ): Promise<ReplyView> {
    const prior = await this.replayPriorAttempt(clientRequestId, input.thread_id);
    if (prior) {
      return prior;
    }
    return this.sendOnce(input, clientRequestId);
  }

  private async sendOnce(
    input: ReplyInput,
    clientRequestId: string | undefined,
  ): Promise<ReplyView> {
    const threadId = input.thread_id?.trim() ?? "";
    let thread;
    try {
      thread = parseConversationThread(threadId);
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
    const text = (input.text ?? "").trim();
    const attachments = await this.prepareAttachments(input.attachments ?? []);
    if (text.length === 0 && attachments.length === 0) {
      throw new PersonalConnectorError(
        "invalid_reply",
        "Reply needs text or an attachment",
        400,
      );
    }
    if (text.length > MAX_TEXT) {
      throw new PersonalConnectorError(
        "invalid_reply",
        `Reply text must be ${MAX_TEXT} characters or fewer`,
        400,
      );
    }

    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    const found = this.drivers.findForThread(installations, thread);
    if (!found) {
      throw new PersonalConnectorError(
        "no_sender",
        "No enabled connector can reply in this conversation",
        404,
      );
    }
    if (!driverCanReply(found.driver, found.installation)) {
      throw new PersonalConnectorError(
        "unsupported_channel",
        `Sending back to ${thread.source} is not available yet`,
        501,
      );
    }
    const { installation, driver } = found;
    const quoted = input.reply_to_event_id
      ? await this.inbox.getInboxItem(input.reply_to_event_id)
      : null;
    const composed = composeReplyText(text, quoted);
    const content: ContentPart[] = [
      { role: "body", media_type: "text/markdown", text: composed },
      ...attachments.map(
        (attachment): ContentPart => ({
          role: "attachment",
          media_type: attachment.media_type,
          source_filename: attachment.filename,
          bytes: attachment.bytes,
        }),
      ),
    ];

    const claimNow = new Date().toISOString();
    if (clientRequestId) {
      await host.get("authority").putOutboundAttempt({
        org_id: this.runtime.orgId(),
        client_request_id: clientRequestId,
        thread_id: threadId,
        status: "pending",
        now: claimNow,
      });
    }

    let receipt: DeliveryReceipt;
    let outboundId: ReturnType<typeof requireReplyPorts>["outboundId"];
    try {
      const ports = requireReplyPorts(driver);
      outboundId = ports.outboundId;
      const egress = await ports.bindEgress(
        installation,
        thread,
        asConnectorHost(host),
        process.env,
      );
      receipt = await egress.send({
        installation_id: installation.id,
        target: { scope_id: thread.target },
        content,
        ...(clientRequestId ? { idempotency_key: clientRequestId } : {}),
      });
    } catch (error) {
      if (clientRequestId) {
        await host
          .get("authority")
          .putOutboundAttempt({
            org_id: this.runtime.orgId(),
            client_request_id: clientRequestId,
            thread_id: threadId,
            status: "failed",
            now: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      throw wrapDriverError(error, "send_failed");
    }

    const channelIds = channelMessageIds(receipt);
    const acceptedAt = new Date().toISOString();
    if (clientRequestId) {
      // Persist channel ids before ingest so a crash cannot double-send on retry.
      await host.get("authority").putOutboundAttempt({
        org_id: this.runtime.orgId(),
        client_request_id: clientRequestId,
        thread_id: threadId,
        status: "accepted",
        channel_message_ids: channelIds,
        now: acceptedAt,
      });
    }

    const now = acceptedAt;
    const stamp = await this.conversationStamp(thread.target, threadId, quoted, {
      installationId: installation.id,
      host,
    });
    const primaryExternalId = outboundId(thread, receipt);
    const record = channelRecord({
      channel: driver.source,
      kind: "user",
      direction: "outbound",
      external_id: primaryExternalId,
      occurred_at: now,
      actor_id: "local-owner",
      scope_id: thread.target,
      ...(stamp.scope_name ? { scope_name: stamp.scope_name } : {}),
      ...(stamp.conversation_kind
        ? { conversation_kind: stamp.conversation_kind }
        : {}),
      ...(stamp.unit_kind ? { unit_kind: stamp.unit_kind } : {}),
      parent_external_id: quoted?.event.external_id,
      content: toReplyParts({
        text: composed,
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          media_type: attachment.media_type,
          bytes: attachment.bytes,
        })),
      }),
    });
    record.weight_hints = { importance: 1 };
    const ingested = await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: installation.id,
      org_id: this.runtime.orgId(),
      delivery_id: `reply:${clientRequestId ?? randomUUID()}`,
      received_at: now,
      records: [record],
    });
    if (!ingested.valid) {
      throw new PersonalConnectorError(
        "send_failed",
        "Reply was delivered but could not be stored",
        502,
      );
    }
    const eventId = ingested.records[0]?.event_id;
    if (!eventId) {
      throw new PersonalConnectorError(
        "send_failed",
        "Reply was delivered but did not enter current work",
        502,
      );
    }

    await this.bindChannelAliases({
      host,
      source: driver.source,
      threadTarget: thread.target,
      eventId,
      primaryExternalId,
      channelIds,
    });

    if (clientRequestId) {
      await host.get("authority").putOutboundAttempt({
        org_id: this.runtime.orgId(),
        client_request_id: clientRequestId,
        thread_id: threadId,
        event_id: eventId,
        status: "sent",
        channel_message_ids: channelIds,
        now: new Date().toISOString(),
      });
    }

    // Follow asynchronously — do not block the reply HTTP response on pull.
    void this.connectors
      .followThread(installation.id, thread)
      .catch(() => undefined);

    const item = await this.inbox.getInboxItem(eventId);
    if (!item) {
      throw new PersonalConnectorError(
        "send_failed",
        "Reply was delivered but did not enter current work",
        502,
      );
    }
    return {
      accepted: true,
      source: driver.source,
      thread_id: threadId,
      rpc_id: receipt.rpc_id,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      item,
    };
  }

  private async replayPriorAttempt(
    clientRequestId: string,
    threadId: string | undefined,
  ): Promise<ReplyView | null> {
    const host = this.runtime.requireHost();
    const prior = await host
      .get("authority")
      .getOutboundAttempt(this.runtime.orgId(), clientRequestId);
    if (!prior) {
      return null;
    }
    if (threadId?.trim() && prior.thread_id !== threadId.trim()) {
      throw new PersonalConnectorError(
        "invalid_reply",
        "client_request_id was already used for another conversation",
        409,
      );
    }
    if (prior.status === "failed") {
      // Allow a conscious client retry with the same key after a hard failure.
      return null;
    }
    if (prior.status === "pending") {
      throw new PersonalConnectorError(
        "send_in_progress",
        "Reply with this client_request_id is still in progress",
        409,
      );
    }
    if (prior.status === "accepted") {
      // Channel already got the message; never egress again.
      throw new PersonalConnectorError(
        "send_in_progress",
        "Reply was already delivered to the channel; refresh the conversation",
        409,
      );
    }
    if (prior.status !== "sent" || !prior.event_id) {
      return null;
    }
    const item = await this.inbox.getInboxItem(prior.event_id);
    if (!item) {
      // Attempt is durable; do not fall through to another channel send.
      throw new PersonalConnectorError(
        "send_failed",
        "Reply was already accepted; refresh the conversation",
        502,
      );
    }
    return {
      accepted: true,
      source: item.channel,
      thread_id: prior.thread_id,
      client_request_id: clientRequestId,
      item,
    };
  }

  private async bindChannelAliases(input: {
    host: Host;
    source: string;
    threadTarget: string;
    eventId: string;
    primaryExternalId: string;
    channelIds: string[];
  }): Promise<void> {
    const aliases = new Map<string, { source: string; external_id: string }>();
    for (const messageId of input.channelIds) {
      const native = `${input.threadTarget}:${messageId}`;
      if (native !== input.primaryExternalId) {
        aliases.set(native, { source: input.source, external_id: native });
      }
    }
    if (aliases.size === 0) {
      return;
    }
    await input.host.get("authority").bindSourceIdentityAliases({
      org_id: this.runtime.orgId(),
      event_id: input.eventId,
      aliases: [...aliases.values()],
    });
  }

  private clientKey(clientRequestId: string): string {
    return `${this.runtime.orgId()}\0${clientRequestId}`;
  }

  private async conversationStamp(
    target: string,
    threadId: string,
    quoted: InboxViewItem | null,
    bound: { installationId: string; host: Host },
  ): Promise<{
    scope_name?: string;
    conversation_kind?: string;
    unit_kind?: string;
  }> {
    const stream = bound.host
      .get("connectors")
      .listStreams(bound.installationId)
      .find((item) => item.thread_id === threadId);
    const fromKnown = conversationStampForReply({
      target,
      quotedLabel: quoted?.conversation_label,
      quotedKind: quoted?.conversation_kind,
      quotedUnitKind: quoted?.unit_kind,
      streamLabel: stream?.label,
    });
    if (fromKnown.scope_name && fromKnown.unit_kind) {
      return fromKnown;
    }
    const head = (
      await this.inbox.listInbox({
        thread_id: threadId,
        heads: true,
        limit: 1,
      })
    )[0];
    return conversationStampForReply({
      target,
      quotedLabel: quoted?.conversation_label,
      quotedKind: quoted?.conversation_kind,
      quotedUnitKind: quoted?.unit_kind,
      streamLabel: stream?.label,
      headLabel: head?.conversation_label,
      headKind: head?.conversation_kind,
      headUnitKind: head?.unit_kind,
    });
  }

  private async prepareAttachments(
    input: ReplyAttachmentInput[],
  ): Promise<PreparedAttachment[]> {
    if (input.length > MAX_ATTACHMENTS) {
      throw new PersonalConnectorError(
        "invalid_reply",
        `At most ${MAX_ATTACHMENTS} attachments`,
        400,
      );
    }
    const options = this.runtime.getOptions();
    if (!options) {
      throw new PersonalConnectorError(
        "not_configured",
        "Personal kernel is not running",
        503,
      );
    }
    const replyId = randomUUID();
    const prepared: PreparedAttachment[] = [];
    for (const raw of input) {
      const mediaType = (raw.media_type ?? "").trim().toLowerCase();
      if (!ALLOWED_MEDIA.has(mediaType)) {
        throw new PersonalConnectorError(
          "invalid_reply",
          `Attachment type is not allowed: ${mediaType || "unknown"}`,
          400,
        );
      }
      if (!raw.data_base64 || raw.data_base64.trim().length === 0) {
        throw new PersonalConnectorError(
          "invalid_reply",
          "Attachment data is required",
          400,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = Buffer.from(raw.data_base64, "base64");
      } catch {
        throw new PersonalConnectorError(
          "invalid_reply",
          "Attachment data is not valid base64",
          400,
        );
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new PersonalConnectorError(
          "invalid_reply",
          `Each attachment must be 1 byte through ${MAX_ATTACHMENT_BYTES} bytes`,
          400,
        );
      }
      const filename = safeFilename(raw.filename ?? "attachment");
      const directory = join(options.blobRoot, "outbound", replyId);
      await mkdir(directory, { recursive: true });
      const path = join(directory, filename);
      await writeFile(path, bytes);
      prepared.push({ filename, media_type: mediaType, bytes, path });
    }
    return prepared;
  }
}

function channelMessageIds(receipt: DeliveryReceipt): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...(receipt.channel_message_ids ?? []),
    ...(receipt.rpc_id ? [receipt.rpc_id] : []),
  ]) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

function composeReplyText(text: string, quoted: InboxViewItem | null): string {
  const blocks: string[] = [];
  if (quoted?.body_text) {
    const line = quoted.body_text.split(/\r?\n/).find((part) => part.trim()) ?? "";
    if (line.trim()) {
      blocks.push(`> ${line.trim().slice(0, 160)}`);
    }
  }
  if (text) {
    blocks.push(text);
  }
  return blocks.join("\n\n");
}

function safeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, "").replace(/^\.+/g, "").trim();
  return (base.length > 0 ? base : "attachment").slice(0, 120);
}
