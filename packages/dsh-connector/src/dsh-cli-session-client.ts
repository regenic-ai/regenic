import { DshApiError, type DshCliClient, type DshHistoryPage, runsToHistoryPage } from "./dsh-cli-client";
import type { DshRunLog } from "./dsh-run-log";

export class DshCliSessionClient {
  constructor(
    private readonly runLog: DshRunLog,
    private readonly client?: Pick<DshCliClient, "run">,
  ) {}

  async sessionHistory(input: {
    sessionId?: string;
    maxMessages?: number;
    beforeSeq?: number;
  } = {}): Promise<DshHistoryPage> {
    return runsToHistoryPage(await this.runLog.list(), input);
  }

  async sessionPrompt(input: {
    sessionId?: string;
    text?: string;
    content?: Array<{ type: string; text?: string; filename?: string; path?: string }>;
  }): Promise<{
    accepted: true;
    rpc_id: string;
  }> {
    if (!this.client) {
      throw new DshApiError("DSH CLI client is not configured for send", "internal");
    }
    const text = flattenPromptText(input);
    if (text.trim().length === 0) {
      throw new DshApiError("Send intent must include a text body or attachment");
    }
    const nextSeq = (await this.runLog.list()).reduce(
      (max, run) => Math.max(max, run.seq),
      -1,
    ) + 1;
    const run = await this.client.run(text, nextSeq);
    await this.runLog.append(run);
    return { accepted: true, rpc_id: run.run_id };
  }
}

function flattenPromptText(input: {
  text?: string;
  content?: Array<{ type: string; text?: string; filename?: string; path?: string }>;
}): string {
  if (typeof input.text === "string" && input.text.trim().length > 0) {
    return input.text;
  }
  return (input.content ?? [])
    .flatMap((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      if (part.path) {
        return [`[Attached: ${part.path}]`];
      }
      if (part.filename) {
        return [`[Attached: ${part.filename}]`];
      }
      return [];
    })
    .join("\n\n");
}
