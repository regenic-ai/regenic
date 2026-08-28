import type { DeliveryReceipt, EgressAdapter, EgressCapabilities, SendIntent } from "@regenic/domain";
import { CursorApiError } from "./cursor-api-client";
import { CURSOR_SOURCE } from "./cursor-agent-poll-connector";

export interface CursorFollowUpClient {
  createRun(agentId: string, text: string): Promise<{ id: string }>;
}

export interface CursorAgentEgressOptions {
  installation_id: string;
  agent_id: string;
}

export class CursorAgentEgress implements EgressAdapter {
  readonly source = CURSOR_SOURCE;

  constructor(
    private readonly client: CursorFollowUpClient,
    private readonly options: CursorAgentEgressOptions,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.options.installation_id) {
      throw new CursorApiError("Send intent installation does not match the Cursor adapter");
    }
    const text = textFromContent(intent.content);
    if (!text) {
      throw new CursorApiError("Send intent must include a text body", 400, "send_failed");
    }
    const agentId = intent.target?.scope_id ?? this.options.agent_id;
    const run = await this.client.createRun(agentId, text);
    return { accepted: true, rpc_id: run.id };
  }
}

function textFromContent(content: SendIntent["content"]): string | undefined {
  const texts: string[] = [];
  for (const part of content) {
    if (part.role !== "body" || typeof part.text !== "string") {
      continue;
    }
    const text = part.text.trim();
    if (text) {
      texts.push(part.text);
    }
  }
  const joined = texts.join("\n").trim();
  return joined || undefined;
}
