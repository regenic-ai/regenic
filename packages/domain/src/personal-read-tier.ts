/** How much work a personal read path may do. */
export type PersonalReadTier = "heartbeat" | "engine" | "engine_detailed";

export type SyncProgressReadMode = "none" | "snapshot" | "live";

export interface PersonalReadTierSpec {
  tier: PersonalReadTier;
  sync_progress: SyncProgressReadMode;
  include_install_attempts: boolean;
  include_executor_catalog: boolean;
  include_connector_catalog: boolean;
}

const TIER_SPECS: Record<PersonalReadTier, PersonalReadTierSpec> = {
  heartbeat: {
    tier: "heartbeat",
    sync_progress: "none",
    include_install_attempts: false,
    include_executor_catalog: false,
    include_connector_catalog: false,
  },
  engine: {
    tier: "engine",
    sync_progress: "snapshot",
    include_install_attempts: false,
    include_executor_catalog: false,
    include_connector_catalog: true,
  },
  engine_detailed: {
    tier: "engine_detailed",
    sync_progress: "live",
    include_install_attempts: true,
    include_executor_catalog: true,
    include_connector_catalog: true,
  },
};

export function personalReadTierSpec(tier: PersonalReadTier): PersonalReadTierSpec {
  return TIER_SPECS[tier];
}

export function personalReadTierFromDetail(
  detail: unknown,
): PersonalReadTier {
  if (detail === false || detail === "0" || detail === 0) {
    return "engine";
  }
  return "engine_detailed";
}

/** Inbox list / thread read paths. */
export type InboxReadTier = "heads" | "heads_live" | "thread" | "thread_live";

export interface InboxReadTierSpec {
  tier: InboxReadTier;
  /** Query connector for attention / outbound receipts (e.g. Feishu read_status). */
  channel_overlays: boolean;
  /** Live connector prompts (DSH, etc.) per thread. */
  connector_prompts: boolean;
  /** Bound executor prompt merge for linked agent threads. */
  agent_prompts: boolean;
}

const INBOX_TIER_SPECS: Record<InboxReadTier, InboxReadTierSpec> = {
  heads: {
    tier: "heads",
    channel_overlays: false,
    connector_prompts: false,
    agent_prompts: false,
  },
  heads_live: {
    tier: "heads_live",
    channel_overlays: true,
    connector_prompts: true,
    agent_prompts: true,
  },
  thread: {
    tier: "thread",
    channel_overlays: false,
    connector_prompts: true,
    agent_prompts: true,
  },
  thread_live: {
    tier: "thread_live",
    channel_overlays: true,
    connector_prompts: true,
    agent_prompts: true,
  },
};

export function personalInboxReadTier(query: {
  heads?: boolean;
  live?: boolean;
  thread_id?: string;
}): InboxReadTier {
  const thread = Boolean(query.thread_id?.trim());
  if (thread) {
    return query.live ? "thread_live" : "thread";
  }
  if (query.heads) {
    return query.live ? "heads_live" : "heads";
  }
  return query.live ? "thread_live" : "thread";
}

export function personalInboxReadTierSpec(tier: InboxReadTier): InboxReadTierSpec {
  return INBOX_TIER_SPECS[tier];
}

export function shouldQueryInboxChannelOverlays(query: {
  heads?: boolean;
  live?: boolean;
  thread_id?: string;
}): boolean {
  return personalInboxReadTierSpec(personalInboxReadTier(query)).channel_overlays;
}
