import { fetchEngine, fetchHeartbeat } from "./api.ts";
import { applyHeartbeatToEngine } from "./runtime-pulse.ts";
import type { PersonalEngineView } from "./types.ts";
import type { KernelReachability } from "../../shared/connection-state.ts";
import { connectionReachability } from "../../shared/connection-state.ts";

function reachabilityFromEngineFetch(
  started: number,
  engine: PersonalEngineView,
): KernelReachability {
  return connectionReachability({
    health_ok: true,
    personal_ok: engine.kernel === "running",
    latency_ms: Date.now() - started,
  });
}

export async function fetchRuntimePulse(input: {
  detailed: boolean;
  current: PersonalEngineView | null;
}): Promise<{
  engine: PersonalEngineView;
  reachability: KernelReachability;
  source: "engine" | "heartbeat";
}> {
  if (input.detailed) {
    const started = Date.now();
    const engine = await fetchEngine({ detailed: true });
    return {
      engine,
      reachability: reachabilityFromEngineFetch(started, engine),
      source: "engine",
    };
  }
  if (!input.current) {
    const started = Date.now();
    const engine = await fetchEngine({ detailed: false });
    return {
      engine,
      reachability: reachabilityFromEngineFetch(started, engine),
      source: "engine",
    };
  }
  const heartbeat = await fetchHeartbeat();
  return {
    engine: applyHeartbeatToEngine(input.current, heartbeat),
    reachability: heartbeat.reachability,
    source: "heartbeat",
  };
}

export { applyHeartbeatToEngine } from "./runtime-pulse.ts";
