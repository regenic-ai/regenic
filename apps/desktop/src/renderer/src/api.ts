import type {
  ConnectorSyncView,
  ConversationPrefView,
  CreatedConversation,
  EngineInstallationView,
  InboxViewItem,
  KernelSettingsView,
  PersonalEngineView,
  ReplyAttachmentInput,
  ReplyView,
} from "./types";
import { normalizeListTitle } from "./types";

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

export async function fetchInbox(
  query: {
    since?: string;
    since_id?: string;
    heads?: boolean;
    thread_id?: string;
  } = {},
): Promise<InboxViewItem[]> {
  const params = new URLSearchParams();
  if (query.since) {
    params.set("since", query.since);
  }
  if (query.since_id) {
    params.set("since_id", query.since_id);
  }
  if (query.heads) {
    params.set("heads", "1");
  }
  if (query.thread_id) {
    params.set("thread_id", query.thread_id);
  }
  const encoded = params.toString();
  const suffix = encoded ? `?${encoded}` : "";
  const response = await fetch(`${origin()}/v1/me/inbox${suffix}`);
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
    await_reply: item.await_reply === true,
    list_title: normalizeListTitle(item.list_title),
    thread_id: item.thread_id,
    title: item.title ?? null,
    pinned: item.pinned === true,
    conversation_label: item.conversation_label ?? null,
    conversation_kind: item.conversation_kind ?? null,
    actor_label: item.actor_label ?? null,
    pref_updated_at: item.pref_updated_at ?? null,
    activity: item.activity,
  }));
}

export async function fetchEngine(
  query: { detailed?: boolean } = {},
): Promise<PersonalEngineView> {
  const suffix = query.detailed === false ? "?detail=0" : "";
  const response = await fetch(`${origin()}/v1/me/engine${suffix}`);
  if (!response.ok) {
    throw new Error(`engine ${response.status}`);
  }
  const engine = (await response.json()) as PersonalEngineView;
  return {
    ...engine,
    inbox_digest: engine.inbox_digest,
    pull: engine.pull ?? {
      interval_ms: 0,
      last_tick_at: null,
      last_error: null,
    },
    installations: (engine.installations ?? []).map((item) => ({
      ...item,
      syncable: item.syncable === true,
      can_reply: item.can_reply === true,
      can_create: item.can_create === true,
      channel: item.channel,
      channel_label: item.channel_label,
    })),
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

export async function updateConnectorConfig(
  id: string,
  config: Record<string, string>,
): Promise<EngineInstallationView> {
  const response = await fetch(`${origin()}/v1/me/connectors/${id}/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const body = (await response.json()) as
    | EngineInstallationView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `update ${response.status}`,
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

export async function createConversation(input: {
  installation_id?: string;
} = {}): Promise<CreatedConversation> {
  const response = await fetch(`${origin()}/v1/me/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as
    | CreatedConversation
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `conversation ${response.status}`,
    );
  }
  return body as CreatedConversation;
}

export async function updateConversationPrefs(input: {
  thread_id: string;
  title?: string | null;
  pinned?: boolean;
}): Promise<ConversationPrefView> {
  const response = await fetch(`${origin()}/v1/me/conversations/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as
    | ConversationPrefView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `conversation prefs ${response.status}`,
    );
  }
  return body as ConversationPrefView;
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
  const raw = await response.text();
  let body: ReplyView | { error?: { message?: string }; message?: string } = {};
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(replyErrorMessage(response.status, body));
  }
  return body as ReplyView;
}

function replyErrorMessage(
  status: number,
  body: { error?: { message?: string }; message?: string },
): string {
  if (body.error?.message) {
    return body.error.message;
  }
  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  if (status === 413) {
    return "This reply is too large. Use a smaller image or fewer attachments.";
  }
  return `reply ${status}`;
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
