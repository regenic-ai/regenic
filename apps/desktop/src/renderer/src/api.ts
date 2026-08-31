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
  ForwardMode,
  ForwardView,
  InboxViewItem,
  KernelSettingsView,
  Locale,
  MessageReceipt,
  PersonalEngineView,
  PluginInventoryItem,
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
import { activeLocale } from "../../shared/i18n.ts";
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

const KERNEL_FETCH_MS = 120_000;

export function isKernelTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.name === "KernelTimeoutError"
  ) {
    return true;
  }
  return /still handling this send|timed out/i.test(error.message);
}

export function isKernelNetworkError(error: unknown): boolean {
  if (isKernelTimeoutError(error)) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch")
    || message.includes("network request failed")
    || message.includes("load failed")
    || message.includes("networkerror")
    || message.includes("cannot reach the kernel")
  );
}

async function kernelFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${origin()}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(KERNEL_FETCH_MS),
    });
  } catch (error) {
    if (isKernelTimeoutError(error)) {
      const wrapped = new Error(`The kernel is still handling this send at ${origin()}`);
      wrapped.name = "KernelTimeoutError";
      throw wrapped;
    }
    if (isKernelNetworkError(error) || error instanceof TypeError) {
      throw new Error(`Cannot reach the kernel at ${origin()}`);
    }
    throw error;
  }
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

export type InboxHeadsPage = {
  pinned: InboxViewItem[];
  live: InboxViewItem[];
  active_work: InboxViewItem[];
  next_before: { before: string; before_id: string } | null;
  has_older: boolean;
  patch?: boolean;
  gone?: string[];
};

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
    list?: "shown" | "hidden";
  } = {},
): Promise<InboxViewItem[]> {
  const response = await fetchInboxResponse(query);
  const items = (await response.json()) as InboxViewItem[];
  if (!Array.isArray(items)) {
    throw new Error("inbox");
  }
  return items.map(normalizeInboxItem);
}

export async function fetchInboxHeads(
  query: {
    before?: string;
    before_id?: string;
    limit?: number;
    list?: "shown" | "hidden";
    changed?: boolean;
    since_digest?: string;
  } = {},
): Promise<InboxHeadsPage> {
  const response = await fetchInboxResponse({
    ...query,
    heads: true,
    split: true,
  });
  const page = (await response.json()) as Partial<InboxHeadsPage>;
  if (!page || !Array.isArray(page.live)) {
    throw new Error("inbox heads");
  }
  const next = page.next_before;
  return {
    pinned: (page.pinned ?? []).map(normalizeInboxItem),
    live: page.live.map(normalizeInboxItem),
    active_work: (page.active_work ?? []).map(normalizeInboxItem),
    next_before:
      next?.before && next.before_id
        ? { before: next.before, before_id: next.before_id }
        : null,
    has_older: page.has_older === true,
    patch: page.patch === true,
    gone: Array.isArray(page.gone) ? page.gone.filter((id) => id.length > 0) : [],
  };
}

async function fetchInboxResponse(
  query: {
    since?: string;
    since_id?: string;
    before?: string;
    before_id?: string;
    heads?: boolean;
    live?: boolean;
    split?: boolean;
    changed?: boolean;
    since_digest?: string;
    thread_id?: string;
    limit?: number;
    list?: "shown" | "hidden";
  },
): Promise<Response> {
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
  if (query.split) {
    params.set("split", "1");
  }
  if (query.changed) {
    params.set("changed", "1");
  }
  if (query.since_digest) {
    params.set("since_digest", query.since_digest);
  }
  if (query.thread_id) {
    params.set("thread_id", query.thread_id);
  }
  if (query.limit) {
    params.set("limit", String(query.limit));
  }
  if (query.list === "hidden") {
    params.set("list", "hidden");
  }
  params.set("locale", activeLocale());
  const encoded = params.toString();
  const suffix = encoded ? `?${encoded}` : "";
  const response = await fetch(`${origin()}/v1/me/inbox${suffix}`);
  if (!response.ok) {
    throw new Error(`inbox ${response.status}`);
  }
  return response;
}

function normalizeInboxItem(item: InboxViewItem): InboxViewItem {
  return {
    ...item,
    channel: item.channel ?? item.event.source,
    channel_label: item.channel_label ?? item.event.source.toUpperCase(),
    kind: item.kind ?? "assistant",
    direction: item.direction ?? "inbound",
    can_send: item.can_send === true,
    await_reply: item.await_reply === true,
    hold_while_working: item.hold_while_working === true,
    list_title: normalizeListTitle(item.list_title),
    thread_id: item.thread_id,
    title: item.title ?? null,
    pinned: item.pinned === true,
    hidden: item.hidden === true,
    conversation_label: item.conversation_label ?? null,
    conversation_kind: item.conversation_kind ?? null,
    unit_kind: item.unit_kind ?? null,
    unit_kind_label: item.unit_kind_label ?? null,
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
  };
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
  const params = new URLSearchParams();
  if (query.detailed === false) {
    params.set("detail", "0");
  }
  params.set("locale", activeLocale());
  const suffix = `?${params.toString()}`;
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
      create_with_task: item.create_with_task === true,
      channel: item.channel,
      channel_label: item.channel_label,
    })),
    catalog: (engine.catalog ?? []).map((item) => ({
      ...item,
      prerequisites: item.prerequisites ?? [],
      setup_steps: catalogSetupSteps(item.setup_steps),
      import_files: catalogImportFiles(item.import_files),
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
    plugins: catalogPlugins(engine.plugins),
    plugin_dir: typeof engine.plugin_dir === "string" ? engine.plugin_dir : null,
  };
}

function catalogPlugins(
  plugins: PersonalEngineView["plugins"],
): PluginInventoryItem[] {
  if (!Array.isArray(plugins)) {
    return [];
  }
  return plugins.flatMap((item) => {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const spec = typeof item.spec === "string" ? item.spec.trim() : "";
    if (!id && !spec) {
      return [];
    }
    return [
      {
        id: id || spec,
        spec: spec || id,
        version: typeof item.version === "string" ? item.version : null,
        display_name:
          typeof item.display_name === "string" ? item.display_name : null,
        origin: item.origin === "extra" ? "extra" : "first_party",
        trust: item.trust === "unsigned" ? "unsigned" : "core",
        status:
          item.status === "skipped" || item.status === "failed"
            ? item.status
            : "loaded",
        path: typeof item.path === "string" ? item.path : null,
        drivers: stringList(item.drivers),
        executors: stringList(item.executors),
        error: typeof item.error === "string" ? item.error : null,
      },
    ];
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

function catalogImportFiles(
  files: PersonalEngineView["catalog"][number]["import_files"] | undefined,
): PersonalEngineView["catalog"][number]["import_files"] | undefined {
  const accept = typeof files?.accept === "string" ? files.accept.trim() : "";
  if (!accept || !files) {
    return undefined;
  }
  const title = typeof files.title === "string" ? files.title.trim() : "";
  const description =
    typeof files.description === "string" ? files.description.trim() : "";
  const maxBytes = files.max_bytes;
  return {
    accept,
    ...(typeof maxBytes === "number" && maxBytes > 0 ? { max_bytes: maxBytes } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function catalogSetupSteps(
  steps: PersonalEngineView["catalog"][number]["setup_steps"] | undefined,
): PersonalEngineView["catalog"][number]["setup_steps"] {
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.flatMap((step) => {
    const title = typeof step.title === "string" ? step.title.trim() : "";
    if (!title) {
      return [];
    }
    const href = typeof step.href === "string" ? step.href.trim() : "";
    const command = typeof step.command === "string" ? step.command.trim() : "";
    const body = typeof step.body === "string" ? step.body.trim() : "";
    return [
      {
        title,
        ...(body ? { body } : {}),
        ...(command ? { command } : {}),
        ...(href.startsWith("http://") || href.startsWith("https://")
          ? { href }
          : {}),
        ...(step.visible_when ? { visible_when: step.visible_when } : {}),
      },
    ];
  });
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

export async function fetchConnectorPairingCode(id: string): Promise<string> {
  const response = await fetch(
    `${origin()}/v1/me/connectors/${id}/pairing-code`,
  );
  const body = (await response.json()) as
    | { pairing_code?: string }
    | { error?: { message?: string } };
  if (!response.ok || !("pairing_code" in body) || !body.pairing_code?.trim()) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `pairing-code ${response.status}`,
    );
  }
  return body.pairing_code.trim();
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

export async function importConnectorFile(
  connectorType: string,
  content: string,
  fileName: string,
): Promise<WhatsAppImportView> {
  const response = await fetch(`${origin()}/v1/me/imports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connector_type: connectorType,
      content,
      file_name: fileName,
    }),
  });
  const body = (await response.json()) as
    | WhatsAppImportView
    | { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `import ${response.status}`,
    );
  }
  return body as WhatsAppImportView;
}

export async function importWhatsAppExport(
  content: string,
  fileName: string,
): Promise<WhatsAppImportView> {
  return importConnectorFile("whatsapp-web-live", content, fileName);
}

export async function createConversation(input: {
  installation_id?: string;
  text?: string;
  client_request_id?: string;
} = {}): Promise<CreatedConversation> {
  const response = await kernelFetch(
    `/v1/me/conversations?locale=${encodeURIComponent(activeLocale())}`,
    {
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
  hidden?: boolean;
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
  const response = await kernelFetch("/v1/me/replies", {
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

export async function sendForward(input: {
  source_thread_id: string;
  event_ids?: string[];
  target: { thread_id: string } | { installation_id: string; create: true };
  mode: ForwardMode;
  attribution?: boolean;
  text?: string;
}): Promise<ForwardView> {
  const response = await kernelFetch("/v1/me/forwards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const raw = await response.text();
  let body: ForwardView | { error?: { message?: string }; message?: string } = {};
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : typeof body.message === "string" && body.message.length > 0
          ? body.message
          : `forward ${response.status}`,
    );
  }
  return body as ForwardView;
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
  const response = await fetch(
    `${origin()}/v1/me/executors?locale=${encodeURIComponent(activeLocale())}`,
  );
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
  return {
    inbox_sort: body.inbox_sort === "attention" ? "attention" : "normal",
    inbox_list: normalizeInboxListView(
      body.inbox_list ??
        (body as { inbox_membership?: string }).inbox_membership,
    ),
  };
}

function normalizeInboxListView(value: unknown): UiPrefsView["inbox_list"] {
  return value === "hidden" || value === "done" ? "hidden" : "shown";
}

export async function saveUiPrefs(input: Partial<UiPrefsView>): Promise<UiPrefsView> {
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
    inbox_list: normalizeInboxListView(
      "inbox_list" in body
        ? body.inbox_list
        : (body as { inbox_membership?: string }).inbox_membership,
    ),
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
