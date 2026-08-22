import type {
  ConnectorSyncView,
  EngineInstallationView,
  InboxViewItem,
  KernelSettingsView,
  PersonalEngineView,
  ReplyAttachmentInput,
  ReplyView,
} from "./types";

let currentOrigin = window.regenic?.apiOrigin ?? "http://127.0.0.1:4370";

if (window.regenic?.onApiOriginChanged) {
  window.regenic.onApiOriginChanged((origin) => {
    currentOrigin = origin;
  });
}

function origin(): string {
  return currentOrigin;
}

export function currentApiOrigin(): string {
  return currentOrigin;
}

export async function fetchKernelSettings(): Promise<KernelSettingsView> {
  if (!window.regenic?.getKernelSettings) {
    return {
      mode: "local",
      customOrigin: currentOrigin,
      activeOrigin: currentOrigin,
    };
  }
  const settings = await window.regenic.getKernelSettings();
  currentOrigin = settings.activeOrigin;
  return settings;
}

export async function applyKernelSettings(input: {
  mode: "local" | "custom";
  origin?: string;
}): Promise<KernelSettingsView> {
  if (!window.regenic?.setKernelSettings) {
    throw new Error("Desktop settings are not available");
  }
  const settings = await window.regenic.setKernelSettings(input);
  currentOrigin = settings.activeOrigin;
  return settings;
}

export async function fetchInbox(): Promise<InboxViewItem[]> {
  const response = await fetch(`${origin()}/v1/me/inbox`);
  if (!response.ok) {
    throw new Error(`inbox ${response.status}`);
  }
  const items = (await response.json()) as InboxViewItem[];
  return items.map((item) => ({
    ...item,
    channel: item.channel ?? item.event.source,
    channel_label: item.channel_label ?? item.event.source.toUpperCase(),
    kind: item.kind ?? "assistant",
    direction: item.direction ?? "inbound",
    can_send: item.can_send === true,
  }));
}

export async function fetchEngine(): Promise<PersonalEngineView> {
  const response = await fetch(`${origin()}/v1/me/engine`);
  if (!response.ok) {
    throw new Error(`engine ${response.status}`);
  }
  const engine = (await response.json()) as PersonalEngineView;
  return {
    ...engine,
    pull: engine.pull ?? {
      interval_ms: 0,
      last_tick_at: null,
      last_error: null,
    },
    installations: engine.installations ?? [],
    catalog: (engine.catalog ?? []).map((item) => ({
      ...item,
      prerequisites: item.prerequisites ?? [],
      setup_ready: item.setup_ready ?? false,
    })),
  };
}

export async function syncConnector(id: string): Promise<ConnectorSyncView> {
  const response = await fetch(`${origin()}/v1/me/connectors/${id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json()) as
    | ConnectorSyncView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `sync ${response.status}`,
    );
  }
  return body as ConnectorSyncView;
}

export async function installConnector(
  connectorType: string,
  config: Record<string, string>,
): Promise<EngineInstallationView> {
  const response = await fetch(`${origin()}/v1/me/connectors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connector_type: connectorType, config }),
  });
  const body = (await response.json()) as
    | EngineInstallationView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `install ${response.status}`,
    );
  }
  return body as EngineInstallationView;
}

export async function uninstallConnector(id: string): Promise<void> {
  const response = await fetch(`${origin()}/v1/me/connectors/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `uninstall ${response.status}`);
  }
}

export async function sendReply(input: {
  thread_id: string;
  text?: string;
  reply_to_event_id?: string;
  attachments?: ReplyAttachmentInput[];
}): Promise<ReplyView> {
  const response = await fetch(`${origin()}/v1/me/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as
    | ReplyView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `reply ${response.status}`,
    );
  }
  return body as ReplyView;
}

export async function setConnectorStatus(
  id: string,
  status: "enabled" | "disabled",
): Promise<EngineInstallationView> {
  const response = await fetch(`${origin()}/v1/me/connectors/${id}/${status}`, {
    method: "POST",
  });
  const body = (await response.json()) as
    | EngineInstallationView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `status ${response.status}`,
    );
  }
  return body as EngineInstallationView;
}
