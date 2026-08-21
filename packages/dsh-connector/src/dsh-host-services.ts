import { ConnectorRunner } from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import { DshApiError, type DshSpawn } from "./dsh-cli-client";
import type { DshFetch } from "./dsh-rpc-client";
import type { DshListedSession, DshRpcServices } from "./dsh-rpc-handler";
import { DshSessionPollConnector } from "./dsh-session-poll-connector";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
} from "./plugin";

export interface DshHostServiceOptions {
  org_id: string;
  spawn?: DshSpawn;
  fetch?: DshFetch;
  access_token?: string;
  now?: () => string;
  createId?: () => string;
  lease_owner?: string;
}

export function createDshHostRpcServices(
  host: Host,
  options: DshHostServiceOptions,
): DshRpcServices {
  const store = host.get("authority");
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => "dsh-api");

  return {
    async listSessions(): Promise<DshListedSession[]> {
      const installations = await store.listInstallations(options.org_id);
      return installations
        .filter((installation) => installation.connector_type === "dsh-session")
        .map((installation) => ({
          sessionId: dshSessionKey(installation.config, installation.id),
          status: installation.status,
          installationId: installation.id,
        }));
    },
    async receive(sessionId) {
      const installation = await requireDshInstallation(host, options.org_id, sessionId);
      const connector = await mountDshSession(host, installation, options);
      const key = dshSessionKey(installation.config, installation.id);
      const runner = new ConnectorRunner(connector, host.get("ingest"), store, now);
      await runner.poll({
        installation_id: installation.id,
        stream_key: `session:${key}`,
        lease_owner: options.lease_owner ?? `dsh-api:${createId()}`,
        lease_duration_ms: 60_000,
      });
      return connector.lastSurfacePage;
    },
    async send(sessionId, text) {
      const installation = await requireDshInstallation(host, options.org_id, sessionId);
      await mountDshSession(host, installation, options);
      const egress = host.get("egress").get(installation.id);
      if (!egress) {
        throw new DshApiError("DSH egress adapter failed to mount", "internal");
      }
      await egress.send({
        installation_id: installation.id,
        content: [{ role: "body", media_type: "text/plain", text }],
      });
      return { accepted: true };
    },
  };
}

export async function requireDshInstallation(
  host: Host,
  orgId: string,
  sessionId: string,
) {
  const store = host.get("authority");
  const installations = await store.listInstallations(orgId);
  const installation = installations.find(
    (item) =>
      item.connector_type === "dsh-session" &&
      (item.id === sessionId || dshSessionKey(item.config, item.id) === sessionId),
  );
  if (!installation) {
    throw new DshApiError("DSH session installation not found", "session-not-found");
  }
  if (installation.status !== "enabled") {
    throw new DshApiError("DSH installation is disabled", "bad-request");
  }
  return installation;
}

async function mountDshSession(
  host: Host,
  installation: { id: string; org_id: string; config: Record<string, unknown> },
  options: DshHostServiceOptions,
) {
  if (!host.get("connectors").get(installation.id)) {
    await host.plugin(
      dshSessionPlugin,
      dshSessionPluginConfigFromInstallation(installation, {
        spawn: options.spawn,
        fetch: options.fetch,
        access_token: options.access_token,
        now: options.now,
        createId: options.createId,
      }),
    );
  }
  const connector = host.get("connectors").get(installation.id);
  if (!(connector instanceof DshSessionPollConnector)) {
    throw new DshApiError("DSH connector failed to mount", "internal");
  }
  return connector;
}
