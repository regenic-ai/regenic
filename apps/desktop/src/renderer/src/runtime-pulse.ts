import type {
  PersonalEngineView,
  PersonalHeartbeatView,
  PullStatusView,
} from "./types.ts";

const EMPTY_PULL: PullStatusView = {
  interval_ms: 0,
  last_tick_at: null,
  last_error: null,
  last_error_hint: null,
  network: { kind: "ok", proxy: null, hint: null },
  phase: "idle",
  catching_up_count: 0,
  last_accepted_count: 0,
  last_pages: 0,
  streams: [],
};

export function applyHeartbeatToEngine(
  current: PersonalEngineView,
  heartbeat: PersonalHeartbeatView,
): PersonalEngineView {
  const pull: PullStatusView = {
    ...(current.pull ?? EMPTY_PULL),
    phase: heartbeat.pull.phase,
    catching_up_count: heartbeat.pull.catching_up_count,
    last_tick_at: heartbeat.pull.last_tick_at,
    last_accepted_count: heartbeat.pull.last_accepted_count,
  };
  const pulseById = new Map(
    (heartbeat.installations ?? []).map((item) => [item.id, item] as const),
  );
  const installations =
    pulseById.size === 0
      ? current.installations
      : current.installations.map((installation) => {
          const pulse = pulseById.get(installation.id);
          if (!pulse) {
            return installation;
          }
          return {
            ...installation,
            ...(pulse.sync ? { sync: pulse.sync } : {}),
            ...(pulse.last_attempt !== undefined
              ? { last_attempt: pulse.last_attempt }
              : {}),
          };
        });
  return {
    ...current,
    kernel: heartbeat.kernel,
    org_id: heartbeat.org_id,
    inbox_count: heartbeat.inbox_count,
    inbox_digest: heartbeat.inbox_digest,
    memory: heartbeat.memory,
    pressure: heartbeat.pressure,
    pull,
    installations,
  };
}
