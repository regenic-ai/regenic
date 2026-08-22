import { Injectable } from "@nestjs/common";
import type { ArrangementDecision, EventRecord } from "@regenic/domain";
import { resolveInboxBody } from "./inbox-body";
import {
  connectorCatalog,
  toInstallationView,
  type ConnectorCatalogItem,
  type EngineInstallationView,
} from "./personal-connector-view";
import {
  PersonalKernelStoppedError,
  PersonalRuntimeService,
} from "./personal-runtime.service";

export interface InboxViewItem {
  decision: ArrangementDecision;
  event: EventRecord;
  body_text?: string;
  media_type?: string;
}

export type { EngineInstallationView } from "./personal-connector-view";

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
}

@Injectable()
export class PersonalInboxService {
  constructor(private readonly runtime: PersonalRuntimeService) {}

  async listInbox(): Promise<InboxViewItem[]> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const items = await authority.listInbox(this.runtime.orgId());
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        ...(await resolveInboxBody(authority, blobs, item.event.content_hash)),
      })),
    );
  }

  async getInboxItem(eventId: string): Promise<InboxViewItem | null> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const items = await authority.listInbox(this.runtime.orgId());
    const item = items.find((entry) => entry.event.id === eventId);
    if (!item) {
      return null;
    }
    return {
      ...item,
      ...(await resolveInboxBody(authority, blobs, item.event.content_hash)),
    };
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
          "dsh-web": await probeLocalService("http://127.0.0.1:3080"),
        },
      });
    if (!this.runtime.isReady()) {
      return {
        kernel: "stopped",
        org_id: orgId,
        database_path: options?.database ?? null,
        inbox_count: 0,
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
        return toInstallationView(installation, attempts[0] ?? null);
      }),
    );
    return {
      kernel: "running",
      org_id: orgId,
      database_path: options?.database ?? null,
      inbox_count: inbox.length,
      installations: views,
      catalog: await catalogReady(views),
    };
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

export { PersonalKernelStoppedError };
