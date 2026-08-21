import type {
  ConnectorSyncView,
  EngineInstallationView,
  InboxViewItem,
  PersonalEngineView,
} from "./types";

function origin(): string {
  return window.regenic?.apiOrigin ?? "http://127.0.0.1:4370";
}

export async function fetchInbox(): Promise<InboxViewItem[]> {
  const response = await fetch(`${origin()}/v1/me/inbox`);
  if (!response.ok) {
    throw new Error(`inbox ${response.status}`);
  }
  return (await response.json()) as InboxViewItem[];
}

export async function fetchEngine(): Promise<PersonalEngineView> {
  const response = await fetch(`${origin()}/v1/me/engine`);
  if (!response.ok) {
    throw new Error(`engine ${response.status}`);
  }
  const engine = (await response.json()) as PersonalEngineView;
  return {
    ...engine,
    installations: engine.installations ?? [],
    catalog: engine.catalog ?? [],
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
