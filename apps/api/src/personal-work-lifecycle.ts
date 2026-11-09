import { foldThreadByPolicy } from "@regenic/domain";
import { preferThread, preferredThreadId } from "./personal-pull-status";

// Compatibility boundary until RFC 0011 moves visibility into atomic transitions.
export async function foldFinishedWorkThreads(
  store: Parameters<typeof foldThreadByPolicy>[0],
  orgId: string,
  sourceThreadId: string,
  agentThreadId: string | undefined,
  now: string,
): Promise<void> {
  await foldThreadByPolicy(store, orgId, sourceThreadId, now);
  const agent = agentThreadId?.trim();
  if (!agent || agent === sourceThreadId) {
    return;
  }
  await foldThreadByPolicy(store, orgId, agent, now);
  if (preferredThreadId() === agent) {
    preferThread(null);
  }
}
