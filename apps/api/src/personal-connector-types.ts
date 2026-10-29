import type { ConnectorWebhookRunResult, SyncRunMode } from "@regenic/domain";

export interface ConnectorInstallInput {
  connector_type: string;
  config?: Record<string, unknown>;
}

export interface CreatedConversationView {
  thread_id: string;
  channel: string;
  channel_label: string;
  can_send: boolean;
  await_reply: boolean;
  list_title: "conversation" | "face" | "prompt";
}

export interface StartSyncRunInput {
  mode?: SyncRunMode;
  max_pages?: number;
  stream_keys?: string[];
  archive_from?: string;
  archive_to?: string;
  run_window?: { start_hour: number; end_hour: number; timezone?: string };
}

export interface ConnectorWebhookView {
  installation_id: string;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: ConnectorWebhookRunResult["status"];
}
