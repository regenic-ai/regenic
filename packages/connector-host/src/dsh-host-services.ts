import { asConnectorHost, ConnectorRunner } from "@regenic/domain";
import type { ConnectorInstallation } from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  DshApiError,
  DshSessionPollConnector,
  createDshConversation,
  dshSessionDriver,
  dshSessionKey,
  dshStreamKey,
  dshWebRpcClient,
  mountDshSessions,
  resolveEffectiveDshTransport,
  type DshFetch,
  type DshHistoryQuery,
  type DshListedSession,
  type DshRpcServices,
  type DshSpawn,
} from "@regenic/dsh-connector";

export interface DshHostServiceOptions {
  org_id: string;
  spawn?: DshSpawn;
  fetch?: DshFetch;
  access_token?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  createId?: () => string;
  lease_owner?: string;
}

interface DshInstallationStore {
  listInstallations(orgId: string): Promise<ConnectorInstallation[]>;
}

function installationStore(host: Host): DshInstallationStore {
  return host.get("authority") as DshInstallationStore;
}

/**
 * Host implementation of the DSH public RPC. The connector package owns the
 * protocol and the session driver. This file is the only place that lists
 * installations and asks Sync Core to poll.
 */
export function createDshHostRpcServices(
  host: Host,
  options: DshHostServiceOptions,
): DshRpcServices {
  const store = installationStore(host);
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => "dsh-api");
  const env = options.env ?? process.env;
  const clientExtras = {
    fetch: options.fetch,
    access_token: options.access_token,
  };
  const driverHost = asConnectorHost(host);

  return {
    async listSessions(): Promise<DshListedSession[]> {
      const installations = await store.listInstallations(options.org_id);
      const listed: DshListedSession[] = [];
      for (const installation of installations) {
        if (installation.connector_type !== "dsh-session") {
          continue;
        }
        const transport = resolveEffectiveDshTransport(installation.config, env);
        const pinned = configString(installation.config, "session_id");
        if (transport === "cli") {
          listed.push({
            sessionId: dshSessionKey(installation.config, installation.id),
            status: installation.status,
            installationId: installation.id,
          });
          continue;
        }
        if (pinned) {
          listed.push({
            sessionId: pinned,
            status: installation.status,
            installationId: installation.id,
          });
          continue;
        }
        if (installation.status !== "enabled") {
          continue;
        }
        const sessionIds = await dshWebRpcClient(
          installation,
          env,
          clientExtras,
        ).listAllSessionIds();
        for (const sessionId of sessionIds) {
          listed.push({
            sessionId,
            status: installation.status,
            installationId: installation.id,
          });
        }
      }
      return listed;
    },
    async receive(sessionId, query: DshHistoryQuery = {}) {
      const installation = await requireDshInstallation(
        host,
        options.org_id,
        sessionId,
      );
      const connector = await connectorForSession(
        driverHost,
        host,
        installation,
        sessionId,
        options,
      );
      const page = await connector.historyPage(query);
      try {
        const run = await new ConnectorRunner(
          connector,
          host.get("ingest"),
          host.get("authority"),
          now,
        ).poll({
          installation_id: installation.id,
          stream_key: `session:${sessionId}`,
          lease_owner: options.lease_owner ?? `dsh-api:${createId()}`,
          lease_duration_ms: 60_000,
        });
        if (run.status === "lease_unavailable") {
          throw new DshApiError("DSH session is already being synced", "agent-busy");
        }
      } catch (error) {
        if (error instanceof DshApiError && error.code === "agent-busy") {
          throw error;
        }
      }
      return page;
    },
    async send(sessionId, text) {
      const installation = await requireDshInstallation(
        host,
        options.org_id,
        sessionId,
      );
      const egress = await mountedSessionEgress(
        driverHost,
        host,
        installation,
        sessionId,
        options,
      );
      await egress.send({
        installation_id: installation.id,
        content: [{ role: "body", media_type: "text/plain", text }],
      });
      return { accepted: true };
    },
    async createSession() {
      const installations = await store.listInstallations(options.org_id);
      const creatable = installations.find(
        (installation) =>
          installation.connector_type === "dsh-session" &&
          dshSessionDriver.capabilities(installation).create,
      );
      if (!creatable) {
        throw new DshApiError(
          "This DSH installation cannot create a conversation",
          "unsupported_channel",
        );
      }
      const thread = await createDshConversation(creatable, env, clientExtras);
      return { sessionId: thread.target };
    },
  };
}

async function requireDshInstallation(
  host: Host,
  orgId: string,
  sessionId: string,
) {
  const store = installationStore(host);
  const installations = (await store.listInstallations(orgId)).filter(
    (item) => item.connector_type === "dsh-session",
  );
  const thread = { source: "dsh", target: sessionId };
  const exact = installations.find(
    (item) =>
      item.id === sessionId || dshSessionKey(item.config, item.id) === sessionId,
  );
  const owned = installations.find(
    (item) =>
      item.status === "enabled" && dshSessionDriver.ownsThread(item, thread),
  );
  const matched = installations.find(
    (item) =>
      item.status === "enabled" && dshSessionDriver.matchesThread(item, thread),
  );
  const installation = exact ?? owned ?? matched;
  if (!installation) {
    throw new DshApiError("DSH session installation not found", "session-not-found");
  }
  if (installation.status !== "enabled") {
    throw new DshApiError("DSH installation is disabled", "bad-request");
  }
  return installation;
}

async function connectorForSession(
  driverHost: ReturnType<typeof asConnectorHost>,
  host: Host,
  installation: { id: string; org_id: string; config: Record<string, unknown> },
  sessionId: string,
  options: DshHostServiceOptions,
): Promise<DshSessionPollConnector> {
  const env = options.env ?? process.env;
  const streams = await mountDshSessions(
    driverHost,
    installation,
    env,
    [sessionId],
    {
      fetch: options.fetch,
      access_token: options.access_token,
    },
  );
  const connector = streams[0]?.connector ?? host.get("connectors").get(
    installation.id,
    dshStreamKey(sessionId),
  );
  if (!(connector instanceof DshSessionPollConnector)) {
    throw new DshApiError("DSH connector failed to mount", "internal");
  }
  return connector;
}

async function mountedSessionEgress(
  driverHost: ReturnType<typeof asConnectorHost>,
  host: Host,
  installation: { id: string; org_id: string; config: Record<string, unknown> },
  sessionId: string,
  options: DshHostServiceOptions,
) {
  await mountDshSessions(
    driverHost,
    installation,
    options.env ?? process.env,
    [sessionId],
    {
      fetch: options.fetch,
      access_token: options.access_token,
    },
  );
  const egress = host.get("egress").get(installation.id, dshStreamKey(sessionId));
  if (!egress) {
    throw new DshApiError("DSH egress adapter failed to mount", "internal");
  }
  return egress;
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
