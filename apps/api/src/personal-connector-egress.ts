import {
  ChannelDriverError,
  readEnvCredential,
  type ChannelDriver,
  type ConnectorInstallation,
} from "@regenic/domain";
import {
  PersonalConnectorError,
} from "./personal-errors";

import type { ConnectorState } from "./personal-connector-state";
import {
  wrapDriverError,
} from "./personal-connector-poll";

export async function listEgressQueue(
  state: ConnectorState,
  installationId: string,
  input: { apiKey?: string; origin?: string } = {},
): Promise<{ commands: ReturnType<NonNullable<ChannelDriver["listEgressQueue"]>> }> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(
    host.get("authority"),
    installationId,
  );
  const driver = state.drivers.get(installation.connector_type);
  if (!driver?.listEgressQueue) {
    throw new PersonalConnectorError(
      "unsupported_channel",
      "Egress queue is not available",
      501,
    );
  }
  await assertInstallSecret(state, installation, input);
  return { commands: driver.listEgressQueue(installation) };
}

export async function ackEgressQueue(
  state: ConnectorState,
  installationId: string,
  commandId: string,
  input: { apiKey?: string; origin?: string } = {},
): Promise<{ acknowledged: boolean }> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(
    host.get("authority"),
    installationId,
  );
  const driver = state.drivers.get(installation.connector_type);
  if (!driver?.ackEgressQueue) {
    throw new PersonalConnectorError(
      "unsupported_channel",
      "Egress queue is not available",
      501,
    );
  }
  await assertInstallSecret(state, installation, input);
  return driver.ackEgressQueue(installation, commandId);
}

async function assertInstallSecret(
  state: ConnectorState,
  installation: ConnectorInstallation,
  input: { apiKey?: string; origin?: string },
): Promise<void> {
  const driver = state.drivers.get(installation.connector_type);
  if (
    driver?.authorizeLiveAccess &&
    driver.capabilities(installation).browser_live
  ) {
    try {
      await driver.authorizeLiveAccess(installation, {
        apiKey: input.apiKey,
        origin: input.origin,
        env: process.env,
        secrets: state.installSecrets(),
      });
    } catch (error) {
      if (
        error instanceof ChannelDriverError &&
        error.code === "missing_credentials"
      ) {
        throw new PersonalConnectorError("unauthorized", error.message, 401);
      }
      throw wrapDriverError(error, "invalid_config");
    }
    return;
  }
  const expected = readEnvCredential(installation.credentials_ref, process.env);
  if (input.origin?.trim() && !expected) {
    throw new PersonalConnectorError(
      "unauthorized",
      "Live connector API key is required for browser access",
      401,
    );
  }
  if (expected && input.apiKey !== expected) {
    throw new PersonalConnectorError(
      "unauthorized",
      "Invalid live connector API key",
      401,
    );
  }
}
