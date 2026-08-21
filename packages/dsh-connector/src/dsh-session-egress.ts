import type {
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/domain";
import { DshApiError } from "./dsh-cli-client";
import { DSH_SOURCE } from "./dsh-session-poll-connector";

export interface DshSessionPromptClient {
  sessionPrompt(input: {
    sessionId: string;
    text: string;
  }): Promise<{ accepted: true; rpc_id: string }>;
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
    const result = await this.client.sessionPrompt({
      sessionId: this.options.session_id,
      text: plainTextFromIntent(intent),
    });
    return { accepted: result.accepted, rpc_id: result.rpc_id };
  }
}

function plainTextFromIntent(intent: SendIntent): string {
  const part = intent.content.find(
    (entry) =>
      entry.role === "body" &&
      entry.media_type === "text/plain" &&
      typeof entry.text === "string",
  );
  if (!part || typeof part.text !== "string" || part.text.trim().length === 0) {
    throw new DshApiError("Send intent must include a text/plain body");
  }
  return part.text;
}
