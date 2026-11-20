import { randomUUID } from "node:crypto";
import {
  asConnectorHost,
  DEFAULT_COPY_LOCALE,
  deleteKeychainSecret,
  installSecretRef,
  persistInstallSecrets,
  readInstallSecret,
  writeKeychainSecret,
  loadSyncProgress,
  type ConnectorInstallation,
  type ConnectorRuntimeStore,
  type DriverInstallCatalog,
  type JsonValue,
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
import { prepareConnectorForm } from "./personal-connector-form";
import { forgetPushInstallation } from "./personal-connector-push";
import { retainInstallationAgentScope } from "./search-app-class";

export async function install(
  state: ConnectorState,
  input: ConnectorInstallInput,
  options: { deferActivation?: boolean } = {},
): Promise<EngineInstallationView> {
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
  const { drafted, catalog, credentialChanges } = await buildInstallation(state, input, now);
  const created = await store.createInstallation({
    ...drafted,
    config: persistInstallSecrets({
      connector_type: drafted.connector_type,
      installation_id: drafted.id,
      catalog,
      incoming: credentialChanges,
      stored: drafted.config ?? {},
    }),
  });
  if (!options.deferActivation) {
    void state.catchUp(created.id);
  }
  await retainInstallationAgentScope(state.runtime, state.drivers, created);
  return viewWithPairingCode(state, store, created);
}

export async function updateConfig(
  state: ConnectorState,
  installationId: string,
  config: Record<string, unknown>,
  afterPersist?: (
    installation: ConnectorInstallation,
  ) => Promise<Record<string, JsonValue> | void>,
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
  const catalog = driver.installCatalog?.({ env: process.env });
  const previousSecrets = await snapshotInstallSecrets(
    current.connector_type,
    current.id,
    catalog,
  );
  const credentials = await credentialStatus(state, installationId);
  const form = prepareConnectorForm(catalog, config, true, credentials, true);
  let nextConfig: ConnectorInstallation["config"];
  try {
    nextConfig = (await driver.install({
      id: current.id,
      org_id: current.org_id,
      config: form.config,
      now: new Date().toISOString(),
      secrets: state.installSecrets(),
    })).config;
  } catch (error) {
    throw wrapDriverError(error, "invalid_config");
  }
  asConnectorHost(state.runtime.requireHost()).livePush?.stop(current.id);
  await state.drivers.stopInstallation(current, state.runtime.requireHost(), "reconfigure");
  let updated: ConnectorInstallation | null = null;
  try {
    for (const key of Object.keys(form.credentialChanges)) {
      await driver.clearCatalogCredential?.(current, key);
    }
    nextConfig = persistInstallSecrets({
      connector_type: current.connector_type,
      installation_id: current.id,
      catalog,
      incoming: form.credentialChanges,
      stored: nextConfig,
    });
    updated = await store.updateInstallationConfig({
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
    const patch = await afterPersist?.(updated);
    if (patch && Object.keys(patch).length > 0) {
      const patched = await store.updateInstallationConfig({
        id: updated.id,
        org_id: updated.org_id,
        config: { ...updated.config, ...patch },
        updated_at: nextUpdatedAt(updated),
      });
      if (!patched) {
        throw new PersonalConnectorError(
          "not_found",
          "Connector installation not found",
          404,
        );
      }
      updated = patched;
    }
  } catch (error) {
    await restoreInstallSecrets(
      current.connector_type,
      current.id,
      catalog,
      previousSecrets,
    );
    const restored = updated
      ? await store.updateInstallationConfig({
          id: current.id,
          org_id: current.org_id,
          config: current.config,
          updated_at: nextUpdatedAt(updated),
        })
      : await store.findInstallation(current.id);
    if (restored?.status === "enabled") {
      state.drivers.installationLifecycle.resume(restored.id, restored.updated_at);
      void state.catchUp(restored.id);
    }
    throw wrapDriverError(error, "invalid_config");
  }
  if (updated.status === "enabled") {
    state.drivers.installationLifecycle.resume(updated.id, updated.updated_at);
    void state.catchUp(updated.id);
  }
  await retainInstallationAgentScope(state.runtime, state.drivers, updated);
  return viewOf(state, store, updated);
}

export async function credentialStatus(
  state: ConnectorState,
  installationId: string,
): Promise<Record<string, boolean>> {
  const installation = await state.requireInstallation(
    state.runtime.requireHost().get("authority"), installationId,
  );
  const driver = state.drivers.get(installation.connector_type);
  const fields = driver?.installCatalog?.({ env: process.env }).fields ?? [];
  const owned = await driver?.catalogCredentialStatus?.(installation) ?? {};
  return Object.fromEntries(await Promise.all(fields
    .filter((field) => field.secret || field.widget === "password")
    .map(async (field) => [
      field.key,
      Boolean(await readInstallSecret(installation.connector_type, installation.id, field.key)) ||
        owned[field.key] === true ||
        (typeof installation.config[field.key] === "string" && Boolean(installation.config[field.key])),
    ])));
}

export async function uninstall(state: ConnectorState, installationId: string): Promise<{ id: string; removed: true }> {
  const store = state.runtime.requireHost().get("authority");
  const current = await store.findInstallation(installationId);
  if (!current || current.org_id !== state.runtime.orgId()) {
    return { id: installationId, removed: true };
  }
  await state.drivers.stopInstallation(current, state.runtime.requireHost(), "delete");
  await retainInstallationAgentScope(state.runtime, state.drivers, current);
  await store.deleteInstallation(current.id, state.runtime.orgId());
  try {
    await clearInstallSecrets(
      current.connector_type,
      current.id,
      state.drivers.get(current.connector_type)?.installCatalog?.({ env: process.env }),
    );
  } catch (error) {
    console.error("connector credential cleanup failed", {
      installation_id: current.id,
      connector_type: current.connector_type,
      error,
    });
  }
  state.kernelRuntime.clearInstallationSnapshots(current.id);
  forgetPushInstallation(state, current.id);
  return { id: current.id, removed: true };
}

function installSecretKeys(catalog: DriverInstallCatalog | undefined): string[] {
  return (catalog?.fields ?? []).flatMap((field) =>
    (field.secret || field.widget === "password") && field.key.trim()
      ? [field.key.trim()]
      : [],
  );
}

async function snapshotInstallSecrets(
  connectorType: string,
  installationId: string,
  catalog: DriverInstallCatalog | undefined,
): Promise<Record<string, string | undefined>> {
  return Object.fromEntries(await Promise.all(
    installSecretKeys(catalog).map(async (key) => [
      key,
      await readInstallSecret(connectorType, installationId, key),
    ]),
  ));
}

async function restoreInstallSecrets(
  connectorType: string,
  installationId: string,
  catalog: DriverInstallCatalog | undefined,
  values: Record<string, string | undefined>,
): Promise<void> {
  for (const key of installSecretKeys(catalog)) {
    const ref = installSecretRef(connectorType, installationId, key);
    const value = values[key];
    if (value) {
      writeKeychainSecret(ref, value);
    } else {
      deleteKeychainSecret(ref);
    }
  }
}

async function clearInstallSecrets(
  connectorType: string,
  installationId: string,
  catalog: DriverInstallCatalog | undefined,
): Promise<void> {
  await restoreInstallSecrets(connectorType, installationId, catalog, {});
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
    asConnectorHost(state.runtime.requireHost()).livePush?.stop(current.id);
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

async function buildInstallation(
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
  const catalog = driver.installCatalog?.({ env: process.env });
  const form = prepareConnectorForm(catalog, input.config ?? {}, false, {}, true);
  try {
    const drafted = await driver.install({
      id: randomUUID(),
      org_id: state.runtime.orgId(),
      config: form.config,
      now,
      secrets: state.installSecrets(),
    });
    const persisted = {
      ...drafted,
      config: drafted.config ?? {},
    };
    return { drafted: persisted, catalog, credentialChanges: form.credentialChanges };
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
  const hidden = await host.get("authority")
    .listHiddenExecutorThreadIds(state.runtime.orgId());
  const [attempt, sync, pushWatermarks] = await Promise.all([
    store.latestAttempt(installation.id),
    loadSyncProgress(store, installation.id, {
      mountedStreamKeys: new Set(streams.map((stream) => stream.stream_key)),
      fallbackMembers,
      hiddenThreadIds: new Set(hidden),
    }),
    store.summarizePushWatermarks(installation.id),
  ]);
  return toInstallationView(installation, attempt, state.drivers, DEFAULT_COPY_LOCALE, {
    sync,
    ...(pushWatermarks.last_updated_at
      ? { lastPushAt: pushWatermarks.last_updated_at }
      : {}),
  });
}
