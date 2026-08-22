import type { DeliveryReceipt, EgressAdapter, EgressCapabilities, SendIntent } from "@regenic/domain";
import { DshApiError } from "./dsh-cli-client";
import { promptFromContentParts, type DshPromptPart } from "./dsh-prompt-part";
import type { DshSessionPromptInput } from "./dsh-rpc-client";
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
    let prompt: { text: string; content?: DshPromptPart[] };
    try {
      prompt = promptFromContentParts(intent.content);
    } catch (error) {
      throw new DshApiError(
        error instanceof Error ? error.message : "Send intent must include a text body or attachment",
      );
    }
    const result = await this.client.sessionPrompt({
      sessionId,
      ...prompt,
    });
    return { accepted: result.accepted, rpc_id: result.rpc_id };
  }
}
