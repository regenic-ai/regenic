import { fetchEngine, fetchHeartbeat } from "./api.ts";
import { applyHeartbeatToEngine } from "./runtime-pulse.ts";
import type { PersonalEngineView } from "./types.ts";
import type { KernelReachability } from "../../shared/connection-state.ts";

export async function fetchRuntimePulse(input: {
  detailed: boolean;
  current: PersonalEngineView | null;
}): Promise<{
  engine: PersonalEngineView;
  reachability: KernelReachability;
  source: "engine" | "heartbeat";
}> {
  if (input.detailed) {
    const engine = await fetchEngine({ detailed: true });
    return { engine, reachability: "live", source: "engine" };
  }
  if (!input.current) {
    const engine = await fetchEngine({ detailed: false });
    return { engine, reachability: "live", source: "engine" };
  }
  const heartbeat = await fetchHeartbeat();
  return {
    engine: applyHeartbeatToEngine(input.current, heartbeat),
    reachability: heartbeat.reachability,
    source: "heartbeat",
  };
}

export { applyHeartbeatToEngine } from "./runtime-pulse.ts";
