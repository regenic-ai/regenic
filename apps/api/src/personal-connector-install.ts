import { randomUUID } from "node:crypto";
import {
  DEFAULT_COPY_LOCALE,
  persistInstallSecrets,
  loadSyncProgress,
  type ConnectorInstallation,
  type ConnectorRuntimeStore,
} from "@regenic/domain";
import {
  PersonalConnectorError,
} from "./personal-errors";

import { catalogMembersFromStreams } from "./connector-sync-members";
import {
  catalogFromDrivers,
  connectorAllowsMultiple,
  toInstallationView,
  type EngineInstallationView,
} from "./personal-connector-view";
import type { ConnectorInstallState as ConnectorState } from "./personal-connector-state";
import type { ConnectorInstallInput } from "./personal-connector-types";
import {
  wrapDriverError,
} from "./personal-connector-poll";

export async function install(state: ConnectorState, input: ConnectorInstallInput): Promise<EngineInstallationView> {
  const store = state.runtime.requireHost().get("authority");
  if (
    !connectorAllowsMultiple(
      input.connector_type,
      catalogFromDrivers(state.drivers, process.env),
    )
  ) {
    const existing = (await store.listInstallations(state.runtime.orgId())).some(
      (item) => item.connector_type === input.connector_type,
    );
    if (existing) {
      throw new PersonalConnectorError(
        "already_installed",
        `${input.connector_type} is already installed`,
        409,
      );
    }
  }
  const now = new Date().toISOString();
  const drafted = buildInstallation(state, input, now);
  const created = await store.createInstallation({
    ...drafted,
    config: persistInstallSecrets({
      connector_type: drafted.connector_type,
      installation_id: drafted.id,
      catalog: state.drivers.get(drafted.connector_type)?.installCatalog?.({
        env: process.env,
      }),
      incoming: input.config ?? {},
      stored: drafted.config ?? {},
    }),
  });
  void state.catchUp(created.id);
  return viewWithPairingCode(state, store, created);
}

export async function updateConfig(
  state: ConnectorState,
  installationId: string,
  config: Record<string, unknown>,
): Promise<EngineInstallationView> {
  const store = state.runtime.requireHost().get("authority");
  const current = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(current.connector_type);
  if (!driver) {
    throw new PersonalConnectorError(
      "unsupported_connector",
      `Connector type cannot be updated: ${current.connector_type}`,
      400,
    );
  }
  let nextConfig: ConnectorInstallation["config"];
  try {
    nextConfig = driver.install({
      id: current.id,
      org_id: current.org_id,
      config,
      now: new Date().toISOString(),
      secrets: state.installSecrets(),
    }).config;
  } catch (error) {
    throw wrapDriverError(error, "invalid_config");
  }
  await state.drivers.stopInstallation(current, state.runtime.requireHost(), "reconfigure");
  try {
    nextConfig = persistInstallSecrets({
      connector_type: current.connector_type,
      installation_id: current.id,
      catalog: driver.installCatalog?.({ env: process.env }),
      incoming: config,
      stored: nextConfig,
    });
  } catch (error) {
    throw wrapDriverError(error, "invalid_config");
  }
  const updated = await store.updateInstallationConfig({
    id: current.id,
    org_id: state.runtime.orgId(),
    config: nextConfig,
    updated_at: nextUpdatedAt(current),
  });
  if (!updated) {
    throw new PersonalConnectorError(
      "not_found",
      "Connector installation not found",
      404,
    );
  }
  if (updated.status === "enabled") {
    state.drivers.installationLifecycle.resume(updated.id, updated.updated_at);
    void state.catchUp(updated.id);
  }
  return viewOf(state, store, updated);
}

export async function uninstall(state: ConnectorState, installationId: string): Promise<{ id: string; removed: true }> {
  const store = state.runtime.requireHost().get("authority");
  const current = await store.findInstallation(installationId);
  if (!current || current.org_id !== state.runtime.orgId()) {
    return { id: installationId, removed: true };
  }
  await state.drivers.stopInstallation(current, state.runtime.requireHost(), "delete");
  await store.deleteInstallation(current.id, state.runtime.orgId());
  state.kernelRuntime.clearInstallationSnapshots(current.id);
  return { id: current.id, removed: true };
}

export async function setStatus(
  state: ConnectorState,
  installationId: string,
  status: "enabled" | "disabled",
): Promise<EngineInstallationView> {
  const store = state.runtime.requireHost().get("authority");
  const current = await state.requireInstallation(store, installationId);
  if (status === "enabled") {
    state.drivers.installationLifecycle.assertRestartable(current.id);
    if (current.status === "enabled" && state.drivers.get(current.connector_type)?.stopInstallation) {
      state.drivers.installationLifecycle.resume(current.id, current.updated_at);
      void state.catchUp(current.id);
      return viewOf(state, store, current);
    }
  }
  if (status === "disabled") {
    await state.drivers.stopInstallation(current, state.runtime.requireHost(), "disable");
  }
  const updated = await store.setInstallationStatus({
    id: current.id,
    org_id: state.runtime.orgId(),
    status,
    updated_at: nextUpdatedAt(current),
  });
  if (!updated) {
    throw new PersonalConnectorError(
      "not_found",
      "Connector installation not found",
      404,
    );
  }
  if (status === "enabled") {
    state.drivers.installationLifecycle.resume(updated.id, updated.updated_at);
    void state.catchUp(updated.id);
  }
  return viewOf(state, store, updated);
}

function nextUpdatedAt(installation: ConnectorInstallation): string {
  return new Date(Math.max(Date.now(), Date.parse(installation.updated_at) + 1)).toISOString();
}

function buildInstallation(
  state: ConnectorState,
  input: ConnectorInstallInput,
  now: string,
) {
  const driver = state.drivers.get(input.connector_type);
  if (!driver) {
    throw new PersonalConnectorError(
      "unsupported_connector",
      `Connector type cannot be installed: ${input.connector_type}`,
      400,
    );
  }
  try {
    return driver.install({
      id: randomUUID(),
      org_id: state.runtime.orgId(),
      config: input.config ?? {},
      now,
      secrets: state.installSecrets(),
    });
  } catch (error) {
    throw wrapDriverError(error, "invalid_config");
  }
}

export async function revealPairingCode(
  state: ConnectorState,
  installationId: string,
): Promise<{ pairing_code: string }> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(
    host.get("authority"),
    installationId,
  );
  const pairing_code = await pairingCodeOf(state, installation);
  if (!pairing_code) {
    throw new PersonalConnectorError(
      "not_found",
      "Pairing code is not available",
      404,
    );
  }
  return { pairing_code };
}

async function viewWithPairingCode(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
): Promise<EngineInstallationView> {
  const view = await viewOf(state, store, installation);
  const pairing_code = await pairingCodeOf(state, installation);
  return pairing_code ? { ...view, pairing_code } : view;
}

function pairingCodeOf(
  state: ConnectorState,
  installation: ConnectorInstallation,
): Promise<string | undefined> {
  const driver = state.drivers.get(installation.connector_type);
  if (
    !driver?.readPairingCode ||
    !driver.capabilities(installation).pairing_code
  ) {
    return Promise.resolve(undefined);
  }
  return driver.readPairingCode(installation, state.installSecrets());
}

async function viewOf(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
): Promise<EngineInstallationView> {
  const host = state.runtime.requireHost();
  const streams = host.get("connectors").listStreams(installation.id);
  const fallbackMembers = catalogMembersFromStreams(installation.id, streams);
  const [attempt, sync] = await Promise.all([
    store.latestAttempt(installation.id),
    loadSyncProgress(store, installation.id, {
      mountedStreamKeys: new Set(streams.map((stream) => stream.stream_key)),
      fallbackMembers,
    }),
  ]);
  return toInstallationView(installation, attempt, state.drivers, DEFAULT_COPY_LOCALE, {
    sync,
  });
}
