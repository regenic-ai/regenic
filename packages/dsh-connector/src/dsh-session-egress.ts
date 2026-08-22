import type {
  ContentPart,
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/domain";
import { DshApiError } from "./dsh-cli-client";
import type { DshPromptPart, DshSessionPromptInput } from "./dsh-rpc-client";
import { DSH_SOURCE } from "./dsh-session-poll-connector";

export interface DshSessionPromptClient {
  sessionPrompt(input: DshSessionPromptInput): Promise<{
    accepted: true;
    rpc_id: string;
  }>;
}

export interface DshSessionEgressOptions {
  installation_id: string;
  session_id: string;
}

export class DshSessionEgress implements EgressAdapter {
  readonly source = DSH_SOURCE;

  constructor(
    private readonly client: DshSessionPromptClient,
    private readonly options: DshSessionEgressOptions,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.options.installation_id) {
      throw new DshApiError("Send intent installation does not match the DSH adapter");
    }
    const sessionId = intent.target?.scope_id ?? this.options.session_id;
    const prompt = promptFromIntent(intent);
    const result = await this.client.sessionPrompt({
      sessionId,
      ...prompt,
    });
    return { accepted: result.accepted, rpc_id: result.rpc_id };
  }
}

function promptFromIntent(
  intent: SendIntent,
): { text: string; content?: DshPromptPart[] } {
  const texts: string[] = [];
  const extras: DshPromptPart[] = [];
  for (const entry of intent.content) {
    if (entry.role === "body" && isTextMedia(entry.media_type) && typeof entry.text === "string") {
      texts.push(entry.text);
    } else if (entry.role === "attachment") {
      extras.push(attachmentPart(entry));
    }
  }
  const notes = extras.map((part) =>
    `[Attached: ${part.type === "text" ? part.text : part.filename ?? part.type}]`,
  );
  const text = (texts.join("\n\n").trim() || notes.join("\n\n")).trim();
  if (text.length === 0) {
    throw new DshApiError("Send intent must include a text body or attachment");
  }
  if (extras.length === 0) {
    return { text };
  }
  return {
    text,
    content: [{ type: "text", text }, ...extras],
  };
}

function attachmentPart(entry: ContentPart): DshPromptPart {
  const filename = entry.source_filename || "attachment";
  const locator = entry.external_locator;
  const url =
    entry.bytes !== undefined
      ? `data:${entry.media_type};base64,${Buffer.from(entry.bytes).toString("base64")}`
      : undefined;
  const image = entry.media_type.startsWith("image/");
  if (image) {
    return compactPart({
      type: "image",
      mimeType: entry.media_type,
      filename,
      path: locator,
      url,
    });
  }
  return compactPart({
    type: "file",
    mimeType: entry.media_type,
    filename,
    path: locator,
    url,
  });
}

function compactPart<T extends DshPromptPart>(part: T): T {
  const cleaned = { ...part };
  for (const key of Object.keys(cleaned) as (keyof T)[]) {
    if (cleaned[key] === undefined) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function isTextMedia(mediaType: string): boolean {
  return mediaType === "text/plain" || mediaType === "text/markdown";
}
