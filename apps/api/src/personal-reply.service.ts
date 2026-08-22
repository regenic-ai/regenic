import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  parseConversationThread,
  toReplyParts,
  type ContentPart,
} from "@regenic/domain";
import {
  PersonalConnectorError,
  PersonalConnectorService,
  wrapDriverError,
} from "./personal-connector.service";
import {
  PersonalInboxService,
  type InboxViewItem,
} from "./personal-inbox.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const FOLLOW_RETURN_MS = 2_500;
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
}

export interface ReplyView {
  accepted: true;
  source: string;
  thread_id: string;
  rpc_id?: string;
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
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly inbox: PersonalInboxService,
    private readonly connectors: PersonalConnectorService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async send(input: ReplyInput): Promise<ReplyView> {
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
    if (!found.driver.canReply(found.installation)) {
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
    const composed = composeReplyText(text, quoted, attachments);
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
    let receipt;
    try {
      const egress = await driver.bindEgress(
        installation,
        thread,
        host,
        process.env,
      );
      receipt = await egress.send({
        installation_id: installation.id,
        target: { scope_id: thread.target },
        content,
      });
    } catch (error) {
      throw wrapDriverError(error, "send_failed");
    }

    const now = new Date().toISOString();
    const record = channelRecord({
      channel: driver.source,
      kind: "user",
      direction: "outbound",
      external_id: driver.outboundId(thread, receipt),
      occurred_at: now,
      actor_id: "local-owner",
      scope_id: thread.target,
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
      delivery_id: `reply:${randomUUID()}`,
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
    const followed = this.connectors
      .followThread(installation.id, thread)
      .catch(() => undefined);
    await Promise.race([followed, delay(FOLLOW_RETURN_MS)]);
    const item = eventId ? await this.inbox.getInboxItem(eventId) : null;
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
      item,
    };
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

function composeReplyText(
  text: string,
  quoted: InboxViewItem | null,
  attachments: PreparedAttachment[],
): string {
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
  for (const attachment of attachments) {
    blocks.push(`[Attached: ${attachment.path}]`);
  }
  return blocks.join("\n\n");
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
