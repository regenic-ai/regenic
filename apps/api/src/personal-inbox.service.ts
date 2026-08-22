import { Injectable } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  channelLabel,
  conversationId,
  parseConversationThread,
  resolveMessageSurface,
  type ArrangementDecision,
  type ConnectorInstallation,
  type ConversationPref,
  type ConversationThread,
  type EventRecord,
  type MessageDirection,
  type MessageKind,
} from "@regenic/domain";
import { resolveInboxBody, type InboxAttachment } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import {
  connectorCatalog,
  toInstallationView,
  type ConnectorCatalogItem,
  type EngineInstallationView,
} from "./personal-connector-view";
import { pullStatus, type PullStatusView } from "./personal-pull-status";
import {
  PersonalKernelStoppedError,
  PersonalRuntimeService,
} from "./personal-runtime.service";

export interface InboxViewItem {
  decision: ArrangementDecision;
  event: EventRecord;
  body_text?: string;
  media_type?: string;
  attachments?: InboxAttachment[];
  channel: string;
  channel_label: string;
  kind: MessageKind;
  direction: MessageDirection;
  can_send: boolean;
  thread_id: string;
  title: string | null;
  pinned: boolean;
  pref_updated_at: string | null;
}

export interface ConversationPrefView {
  thread_id: string;
  title: string | null;
  pinned: boolean;
  updated_at: string;
}

export interface ConversationPrefInput {
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
}

const MAX_TITLE_LENGTH = 120;

export type { EngineInstallationView } from "./personal-connector-view";

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  pull: PullStatusView;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
}

@Injectable()
export class PersonalInboxService {
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async listInbox(): Promise<InboxViewItem[]> {
    return this.loadThreadInbox();
  }

  async getInboxItem(eventId: string): Promise<InboxViewItem | null> {
    const items = await this.loadThreadInbox();
    return items.find((entry) => entry.event.id === eventId) ?? null;
  }

  async getEngine(): Promise<PersonalEngineView> {
    const options = this.runtime.getOptions();
    const orgId = this.runtime.orgId();
    const catalogReady = async (
      installations: EngineInstallationView[],
    ) =>
      connectorCatalog(installations, {
        env: process.env,
        services: {
          "dsh-web": await probeLocalService(
            process.env.REGENIC_DSH_BASE_URL?.trim() || "http://127.0.0.1:3080",
          ),
        },
      });
    if (!this.runtime.isReady()) {
      return {
        kernel: "stopped",
        org_id: orgId,
        database_path: options?.database ?? null,
        inbox_count: 0,
        pull: { ...pullStatus },
        installations: [],
        catalog: await catalogReady([]),
      };
    }
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const [inbox, installations] = await Promise.all([
      authority.listInbox(orgId),
      authority.listInstallations(orgId),
    ]);
    const views = await Promise.all(
      installations.map(async (installation) => {
        const attempts = await authority.listAttempts(installation.id);
        return toInstallationView(
          installation,
          attempts[0] ?? null,
          this.drivers,
        );
      }),
    );
    return {
      kernel: "running",
      org_id: orgId,
      database_path: options?.database ?? null,
      inbox_count: inbox.length,
      pull: { ...pullStatus },
      installations: views,
      catalog: await catalogReady(views),
    };
  }

  private async loadThreadInbox(): Promise<InboxViewItem[]> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const orgId = this.runtime.orgId();
    const [focused, installations, prefs] = await Promise.all([
      authority.listInbox(orgId),
      authority.listInstallations(orgId),
      authority.listConversationPrefs(orgId),
    ]);
    const prefsByThread = new Map(
      prefs.map((pref) => [pref.thread_id, pref] as const),
    );
    const threadIds = new Set(
      focused.map((item) =>
        conversationId(item.event.source, item.event.external_id, item.event.id),
      ),
    );
    const extras: Array<{ decision: ArrangementDecision; event: EventRecord }> = [];
    if (threadIds.size > 0) {
      const events = await authority.listEvents(orgId);
      const seen = new Set(focused.map((item) => item.event.id));
      for (const event of events) {
        if (seen.has(event.id)) {
          continue;
        }
        if (!threadIds.has(conversationId(event.source, event.external_id, event.id))) {
          continue;
        }
        const decision = await authority.getDisposition(event.id);
        if (!decision) {
          continue;
        }
        extras.push({ decision, event });
      }
    }
    return Promise.all(
      [...focused, ...extras].map(async (item) => {
        const threadId = conversationId(
          item.event.source,
          item.event.external_id,
          item.event.id,
        );
        return decorateInboxItem(
          item,
          await resolveInboxBody(authority, blobs, item.event.content_hash),
          installations,
          this.drivers,
          prefsByThread.get(threadId) ?? null,
        );
      }),
    );
  }

  async updateConversationPrefs(
    input: ConversationPrefInput,
  ): Promise<ConversationPrefView> {
    const host = this.runtime.requireHost();
    const threadId = input.thread_id?.trim() ?? "";
    try {
      parseConversationThread(threadId);
    } catch (error) {
      const message =
        error instanceof ChannelDriverError
          ? error.message
          : "thread_id must look like source:target";
      throw new PersonalConnectorError("invalid_config", message, 400);
    }
    if (input.title === undefined && input.pinned === undefined) {
      throw new PersonalConnectorError(
        "invalid_config",
        "title or pinned is required",
        400,
      );
    }
    const pref = await host.get("authority").putConversationPref({
      org_id: this.runtime.orgId(),
      thread_id: threadId,
      title: input.title !== undefined ? normalizeTitle(input.title) : undefined,
      pinned: input.pinned,
      updated_at: new Date().toISOString(),
    });
    return toPrefView(pref);
  }
}

async function probeLocalService(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(400) });
    return true;
  } catch {
    return false;
  }
}

function decorateInboxItem(
  item: { decision: ArrangementDecision; event: EventRecord },
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  pref: ConversationPref | null,
): InboxViewItem {
  const surface = resolveMessageSurface({
    source: item.event.source,
    external_id: item.event.external_id,
    body_text: body.body_text,
    stored: body.surface,
  });
  const thread = threadOf(item.event);
  const threadId = `${thread.source}:${thread.target}`;
  return {
    ...item,
    ...body,
    channel: surface.channel,
    channel_label: channelLabel(surface.channel),
    kind: surface.kind,
    direction: surface.direction,
    can_send: drivers.canSend(installations, thread),
    thread_id: threadId,
    title: pref?.title ?? null,
    pinned: pref?.pinned === true,
    pref_updated_at: pref?.updated_at ?? null,
  };
}

function normalizeTitle(value: string | null): string | null {
  const title = (value ?? "").replace(/\s+/g, " ").trim();
  if (title.length === 0) {
    return null;
  }
  return title.length > MAX_TITLE_LENGTH
    ? title.slice(0, MAX_TITLE_LENGTH)
    : title;
}

function toPrefView(pref: ConversationPref): ConversationPrefView {
  return {
    thread_id: pref.thread_id,
    title: pref.title,
    pinned: pref.pinned,
    updated_at: pref.updated_at,
  };
}

function threadOf(event: EventRecord): ConversationThread {
  const id = conversationId(event.source, event.external_id, event.id);
  try {
    return parseConversationThread(id);
  } catch {
    return { source: event.source, target: event.external_id };
  }
}

export { PersonalKernelStoppedError };
