import {
  asConnectorHost,
  isActiveWorkStatus,
  parseConversationThread,
  type ChannelDriverRegistry,
  type ConnectorInstallation,
  type ConversationThread,
  type WorkItem,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";

type OpenWindowDriver = {
  releaseOpenWindow?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: ReturnType<typeof asConnectorHost>,
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
};

export async function releaseDriverOpenWindow(
  drivers: ChannelDriverRegistry,
  installations: readonly ConnectorInstallation[],
  item: Pick<WorkItem, "thread_id">,
  host: Host,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const thread = parseConversationThread(item.thread_id);
  const found = drivers.findForThread([...installations], thread);
  const release = (found?.driver as OpenWindowDriver | undefined)?.releaseOpenWindow;
  if (!found || !release) {
    return;
  }
  await release(found.installation, thread, asConnectorHost(host), env);
}

export function createLocallyFinishedLookup(
  host: Host,
  orgId: string,
  threadIdOf: (id: string) => string,
): (ids: readonly string[]) => Promise<string[]> {
  let cachedItems: Promise<WorkItem[]> | null = null;
  return async (ids) => {
    if (ids.length === 0) {
      return [];
    }
    if (!cachedItems) {
      cachedItems = host.get("authority").listWorkItems(orgId);
    }
    const items = await cachedItems;
    const byThread = new Map<string, WorkItem[]>();
    for (const item of items) {
      const related = byThread.get(item.thread_id);
      if (related) {
        related.push(item);
      } else {
        byThread.set(item.thread_id, [item]);
      }
    }
    const finished: string[] = [];
    for (const id of ids) {
      const related = byThread.get(threadIdOf(id));
      if (
        related &&
        related.length > 0 &&
        related.every((item) => !isActiveWorkStatus(item.status))
      ) {
        finished.push(id);
      }
    }
    return finished;
  };
}

const CRM_OPS_CONNECTOR_TYPE = "crm-ops-review";
const CRM_ORDER_CONNECTOR_TYPE = "crm-order-review";

export function openWindowPollHooksForInstallation(
  host: Host,
  installation: ConnectorInstallation,
): { findLocallyFinishedIds?: (ids: readonly string[]) => Promise<string[]> } {
  if (installation.connector_type === CRM_OPS_CONNECTOR_TYPE) {
    return {
      findLocallyFinishedIds: createLocallyFinishedLookup(
        host,
        installation.org_id,
        (id) => `crm:ops_task:${id}`,
      ),
    };
  }
  if (installation.connector_type === CRM_ORDER_CONNECTOR_TYPE) {
    return {
      findLocallyFinishedIds: createLocallyFinishedLookup(
        host,
        installation.org_id,
        (id) => `crm:order:${id}`,
      ),
    };
  }
  return {};
}
