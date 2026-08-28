import type {
  ConnectorSyncView,
  ConversationPrefView,
  CreatedConversation,
  DataDirectoryAction,
  DataDirectoryPlan,
  EngineExecutorView,
  EngineInstallationView,
  ExecutorCatalogEntry,
  ExecutorKind,
  InboxViewItem,
  KernelSettingsView,
  Locale,
  MessageReceipt,
  PersonalEngineView,
  PromptAnswerItem,
  RecipeView,
  ReplyAttachmentInput,
  ReplyView,
  StoreClearView,
  StoreView,
  ThreadPrompt,
  UiPrefsView,
  WhatsAppImportView,
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

const emptyDataDirectory: KernelSettingsView["dataDirectory"] = {
  path: "",
  database: "",
  blobRoot: "",
  source: "default",
  envOverride: false,
  productRoot: "",
  splitLayout: false,
  canChange: false,
  remoteWarning: false,
};

function withKernelLocale(settings: KernelSettingsView): KernelSettingsView {
  return {
    ...settings,
    locale: settings.locale === "zh" ? "zh" : "en",
    dataDirectory: settings.dataDirectory ?? emptyDataDirectory,
    ...(settings.sourceRetention
      ? { sourceRetention: settings.sourceRetention }
      : {}),
  };
}

export async function resolveSourceRetention(input: {
  action: "keep" | "discard";
}): Promise<KernelSettingsView> {
  if (!window.regenic?.resolveSourceRetention) {
    throw new Error("Desktop settings are not available");
  }
  const settings = await window.regenic.resolveSourceRetention(input);
  currentOrigin = settings.activeOrigin;
  return withKernelLocale(settings);
}

export async function fetchKernelSettings(): Promise<KernelSettingsView> {
  if (!window.regenic?.getKernelSettings) {
    return {
      mode: "local",
      customOrigin: currentOrigin,
      activeOrigin: currentOrigin,
      locale: "en",
      dataDirectory: emptyDataDirectory,
    };
  }
  const settings = await window.regenic.getKernelSettings();
  currentOrigin = settings.activeOrigin;
  return withKernelLocale(settings);
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
  return withKernelLocale(settings);
}

export async function pickDataDirectory(): Promise<DataDirectoryPlan | null> {
  if (!window.regenic?.pickDataDirectory) {
    throw new Error("Desktop settings are not available");
  }
  return window.regenic.pickDataDirectory();
}

export async function applyDataDirectory(input: {
  path: string;
  action: DataDirectoryAction;
}): Promise<KernelSettingsView> {
  if (!window.regenic?.setDataDirectory) {
    throw new Error("Desktop settings are not available");
  }
  const settings = await window.regenic.setDataDirectory(input);
  currentOrigin = settings.activeOrigin;
  return withKernelLocale(settings);
}

export async function saveLocale(locale: Locale): Promise<Locale> {
  if (!window.regenic?.setLocale) {
    return locale;
  }
  const next = await window.regenic.setLocale(locale);
  return next === "zh" ? "zh" : "en";
}

export async function fetchInbox(
  query: {
    since?: string;
    since_id?: string;
    before?: string;
    before_id?: string;
    heads?: boolean;
    live?: boolean;
    thread_id?: string;
    limit?: number;
  } = {},
): Promise<InboxViewItem[]> {
  const params = new URLSearchParams();
  if (query.since) {
    params.set("since", query.since);
  }
  if (query.since_id) {
    params.set("since_id", query.since_id);
  }
  if (query.before) {
    params.set("before", query.before);
  }
  if (query.before_id) {
    params.set("before_id", query.before_id);
  }
  if (query.heads) {
    params.set("heads", "1");
  }
  if (query.live) {
    params.set("live", "1");
  }
  if (query.thread_id) {
    params.set("thread_id", query.thread_id);
  }
  if (query.limit) {
    params.set("limit", String(query.limit));
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
    prompts: normalizePrompts(item.prompts),
    unread: item.unread === true,
    unread_count:
      typeof item.unread_count === "number" && item.unread_count > 0
        ? item.unread_count
        : item.unread === true
          ? 1
          : 0,
    can_receipt: item.can_receipt === true,
    receipt: normalizeReceipt(item.receipt),
    record_class: item.record_class,
    thread_facet: item.thread_facet,
    attention: item.attention,
    work: item.work,
  }));
}

function normalizeReceipt(value: InboxViewItem["receipt"]): MessageReceipt | undefined {
  if (!value || (value.state !== "sent" && value.state !== "read")) {
    return undefined;
  }
  return {
    state: value.state,
    ...(typeof value.read_at === "string" && value.read_at.trim()
      ? { read_at: value.read_at.trim() }
      : {}),
    ...(typeof value.read_count === "number" && value.read_count > 0
      ? { read_count: value.read_count }
      : {}),
  };
}

function normalizePrompts(value: InboxViewItem["prompts"]): ThreadPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is ThreadPrompt =>
      Boolean(item) &&
      typeof item.prompt_id === "string" &&
      item.prompt_id.trim().length > 0 &&
      Array.isArray(item.questions),
  );
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
    pull: {
      interval_ms: engine.pull?.interval_ms ?? 0,
      last_tick_at: engine.pull?.last_tick_at ?? null,
      last_error: engine.pull?.last_error ?? null,
      last_error_hint: engine.pull?.last_error_hint ?? null,
      network: engine.pull?.network ?? {
        kind: "ok",
        proxy: null,
        hint: null,
      },
      phase: engine.pull?.phase === "pulling" ? "pulling" : "idle",
      catching_up_count: engine.pull?.catching_up_count ?? 0,
      last_accepted_count: engine.pull?.last_accepted_count ?? 0,
      last_pages: engine.pull?.last_pages ?? 0,
      streams: Array.isArray(engine.pull?.streams) ? engine.pull.streams : [],
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
      singleton: item.singleton === true,
      docs: catalogDocs(item.docs),
    })),
    executor_installations: (engine.executor_installations ?? []).map((item) => ({
      ...item,
      kind: item.kind === "http" ? "http" : "local_connector",
      status: item.status === "disabled" ? "disabled" : "enabled",
    })),
    executor_catalog: (engine.executor_catalog ?? []).map((item) => ({
      ...item,
      kind: item.kind === "http" ? "http" : "local_connector",
      fields: item.fields ?? [],
      setup_ready: item.setup_ready !== false,
      docs: catalogDocs(item.docs),
    })),
  };
}

function catalogDocs(
  docs: PersonalEngineView["catalog"][number]["docs"] | undefined,
): PersonalEngineView["catalog"][number]["docs"] {
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs.flatMap((item) => {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const href = typeof item.href === "string" ? item.href.trim() : "";
    const hrefZh = typeof item.href_zh === "string" ? item.href_zh.trim() : "";
    return id && href
      ? [{ id, title: title || id, href, href_zh: hrefZh || href }]
      : [];
  });
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

export async function importWhatsAppExport(
  content: string,
  fileName: string,
): Promise<WhatsAppImportView> {
  const response = await fetch(`${origin()}/v1/me/imports/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, file_name: fileName }),
  });
  const body = (await response.json()) as
    | WhatsAppImportView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `WhatsApp import ${response.status}`,
    );
  }
  return body as WhatsAppImportView;
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

export async function ackConversationAttention(input: {
  thread_id: string;
  last_read_at?: string | null;
  last_read_external_id?: string | null;
}): Promise<ConversationPrefView> {
  const response = await fetch(`${origin()}/v1/me/conversations/attention`, {
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
        : `conversation attention ${response.status}`,
    );
  }
  return body as ConversationPrefView;
}

export async function answerConversationPrompt(input: {
  thread_id: string;
  prompt_id: string;
  answers: PromptAnswerItem[];
}): Promise<{ accepted: true; thread_id: string; prompt_id: string }> {
  const response = await fetch(`${origin()}/v1/me/conversations/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as
    | { accepted: true; thread_id: string; prompt_id: string }
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `conversation prompt ${response.status}`,
    );
  }
  return body as { accepted: true; thread_id: string; prompt_id: string };
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

export async function fetchRecipes(): Promise<RecipeView[]> {
  const response = await fetch(`${origin()}/v1/me/recipes`);
  if (!response.ok) {
    throw new Error(`recipes ${response.status}`);
  }
  const items = (await response.json()) as RecipeView[];
  return Array.isArray(items) ? items : [];
}

export async function installExecutor(
  kind: ExecutorKind,
  config: Record<string, string>,
): Promise<EngineExecutorView> {
  const { name, ...rest } = config;
  const response = await fetch(`${origin()}/v1/me/executors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, name, config: rest }),
  });
  const body = (await response.json()) as
    | EngineExecutorView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `executor install ${response.status}`,
    );
  }
  return body as EngineExecutorView;
}

export async function updateExecutorConfig(
  id: string,
  config: Record<string, string>,
): Promise<EngineExecutorView> {
  const { name, ...rest } = config;
  const response = await fetch(`${origin()}/v1/me/executors/${id}/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, config: rest }),
  });
  const body = (await response.json()) as
    | EngineExecutorView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `executor update ${response.status}`,
    );
  }
  return body as EngineExecutorView;
}

export async function setExecutorStatus(
  id: string,
  status: "enabled" | "disabled",
): Promise<EngineExecutorView> {
  const response = await fetch(
    `${origin()}/v1/me/executors/${id}/${status === "enabled" ? "enable" : "disable"}`,
    { method: "POST" },
  );
  const body = (await response.json()) as
    | EngineExecutorView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `executor status ${response.status}`,
    );
  }
  return body as EngineExecutorView;
}

export async function uninstallExecutor(id: string): Promise<void> {
  const response = await fetch(`${origin()}/v1/me/executors/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `executor uninstall ${response.status}`);
  }
}

export async function fetchExecutors(): Promise<ExecutorCatalogEntry[]> {
  const response = await fetch(`${origin()}/v1/me/executors`);
  if (!response.ok) {
    throw new Error(`executors ${response.status}`);
  }
  const items = (await response.json()) as ExecutorCatalogEntry[];
  return Array.isArray(items) ? items : [];
}

export async function saveRecipe(
  input: {
    name: string;
    match: RecipeView["match"];
    trigger: RecipeView["trigger"];
    executor_type: string;
    executor_config?: Record<string, string>;
    can_write_back: boolean;
    include_context: boolean;
    enabled: boolean;
  },
  id?: string,
): Promise<RecipeView> {
  const response = await fetch(
    id ? `${origin()}/v1/me/recipes/${id}` : `${origin()}/v1/me/recipes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json()) as RecipeView | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `recipe ${response.status}`,
    );
  }
  return body as RecipeView;
}

export async function deleteRecipe(id: string): Promise<void> {
  const response = await fetch(`${origin()}/v1/me/recipes/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `recipe ${response.status}`);
  }
}

export async function runWorkItem(id: string): Promise<void> {
  const response = await fetch(`${origin()}/v1/me/work-items/${id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `work run ${response.status}`);
  }
}

export async function dismissWorkItem(id: string): Promise<void> {
  const response = await fetch(`${origin()}/v1/me/work-items/${id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `work dismiss ${response.status}`);
  }
}

export async function fetchStore(): Promise<StoreView> {
  const response = await fetch(`${origin()}/v1/me/store`);
  if (!response.ok) {
    throw new Error(`store ${response.status}`);
  }
  const body = (await response.json()) as StoreView;
  return {
    events: Number(body.events) || 0,
    conversations: Number(body.conversations) || 0,
    work_items: Number(body.work_items) || 0,
    blobs: Number(body.blobs) || 0,
    recipes: Number(body.recipes) || 0,
    connectors: Number(body.connectors) || 0,
    executors: Number(body.executors) || 0,
  };
}

export async function clearStore(): Promise<StoreClearView> {
  const response = await fetch(`${origin()}/v1/me/store/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json()) as
    | StoreClearView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `store clear ${response.status}`,
    );
  }
  return body as StoreClearView;
}

export async function fetchUiPrefs(): Promise<UiPrefsView> {
  const response = await fetch(`${origin()}/v1/me/prefs`);
  if (!response.ok) {
    throw new Error(`prefs ${response.status}`);
  }
  const body = (await response.json()) as UiPrefsView;
  return { inbox_sort: body.inbox_sort === "attention" ? "attention" : "normal" };
}

export async function saveUiPrefs(input: UiPrefsView): Promise<UiPrefsView> {
  const response = await fetch(`${origin()}/v1/me/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as UiPrefsView | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `prefs ${response.status}`,
    );
  }
  return {
    inbox_sort:
      "inbox_sort" in body && body.inbox_sort === "attention" ? "attention" : "normal",
  };
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
