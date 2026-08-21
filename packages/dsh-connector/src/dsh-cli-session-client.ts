import { DshApiError, type DshCliClient, type DshHistoryPage, runsToHistoryPage } from "./dsh-cli-client";
import type { DshRunLog } from "./dsh-run-log";

export class DshCliSessionClient {
  constructor(
    private readonly runLog: DshRunLog,
    private readonly client?: Pick<DshCliClient, "run">,
  ) {}

  async sessionHistory(): Promise<DshHistoryPage> {
    return runsToHistoryPage(await this.runLog.list());
  }

  async sessionPrompt(input: { sessionId?: string; text: string }): Promise<{
    accepted: true;
    rpc_id: string;
  }> {
    if (!this.client) {
      throw new DshApiError("DSH CLI client is not configured for send", "internal");
    }
    const nextSeq = (await this.runLog.list()).reduce(
      (max, run) => Math.max(max, run.seq),
      -1,
    ) + 1;
    const run = await this.client.run(input.text, nextSeq);
    await this.runLog.append(run);
    return { accepted: true, rpc_id: run.run_id };
  }
}
