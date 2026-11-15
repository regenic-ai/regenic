import { preferThread, preferredThreadId } from "./personal-pull-status";

export function releaseFinishedAgentThread(agentThreadId: string | undefined): void {
  const agent = agentThreadId?.trim();
  if (agent && preferredThreadId() === agent) {
    preferThread(null);
  }
}
