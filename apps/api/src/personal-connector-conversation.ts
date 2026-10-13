import { randomUUID } from "node:crypto";
import type { Host } from "@regenic/plugin-host";
import {
  DEFAULT_COPY_LOCALE,
  type CopyLocale,
  INGEST_SCHEMA_VERSION,
  asConnectorHost,
  channelRecord,
  driverCanReply,
  normalizeListTitle,
  requireCreateThread,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConversationThread,
} from "@regenic/domain";
import {
  PersonalConnectorError,
} from "./personal-errors";

import type { ConnectorState } from "./personal-connector-state";
import type { CreatedConversationView } from "./personal-connector.service";
import {
  wrapDriverError,
  pollStream,
} from "./personal-connector-poll";
import {
  catchUp,
} from "./personal-connector-due-work";

export async function createConversation(
  state: ConnectorState,
  input: {
    installation_id?: string;
    source?: string;
    text?: string;
    cwd?: string;
    client_request_id?: string;
    locale?: CopyLocale;
  } = {},
): Promise<CreatedConversationView> {
  const clientKey = createClientKey(state, input.client_request_id);
  if (clientKey) {
    const pending = state.creatingByClient.get(clientKey);
    if (pending) {
      return pending;
    }
  }
  const run = createConversationOnce(state, input).catch((error) => {
    if (clientKey) {
      state.creatingByClient.delete(clientKey);
    }
    throw error;
  });
  if (clientKey) {
    state.creatingByClient.set(clientKey, run);
  }
  return run;
}

function createClientKey(state: ConnectorState, value?: string): string | undefined {
  const id = value?.trim();
  return id ? `${state.runtime.orgId()}:${id}` : undefined;
}

export async function openCreatedThread(state: ConnectorState, input: {
  installation_id?: string;
  source?: string;
  text?: string;
  cwd?: string;
}): Promise<{
  thread: ConversationThread;
  installation: ConnectorInstallation;
  driver: ChannelDriver;
  create_with_task: boolean;
}> {
  const host = state.runtime.requireHost();
  const found = await resolveCreatable(state, input);
  const withTask = found.driver.capabilities(found.installation).create_with_task === true;
  const firstTask = withTask ? input.text?.trim() : undefined;
  try {
    const thread = await requireCreateThread(found.driver)(
      found.installation,
      asConnectorHost(host),
      process.env,
      {
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
        ...(firstTask ? { text: firstTask } : {}),
      },
    );
    if (withTask) {
      void seedCreatedThread(state, found.installation, found.driver, thread, host).catch(
        () => {
          void catchUp(state, found.installation.id);
        },
      );
    } else {
      await seedCreatedThread(state, found.installation, found.driver, thread, host);
    }
    return {
      thread,
      installation: found.installation,
      driver: found.driver,
      create_with_task: withTask,
    };
  } catch (error) {
    throw wrapDriverError(error, "send_failed");
  }
}

async function resolveCreatable(state: ConnectorState, input: {
  installation_id?: string;
  source?: string;
}): Promise<{ installation: ConnectorInstallation; driver: ChannelDriver }> {
  const host = state.runtime.requireHost();
  const installations = await host
    .get("authority")
    .listInstallations(state.runtime.orgId());
  const requested = input.installation_id?.trim();
  if (requested) {
    const installation = installations.find((item) => item.id === requested);
    if (!installation) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    const driver = state.drivers.get(installation.connector_type);
    if (!driver || !driver.capabilities(installation).create) {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "This connector cannot create a conversation",
        501,
      );
    }
    return { installation, driver };
  }
  const found = state.drivers.findCreatable(installations, input.source);
  if (!found) {
    throw new PersonalConnectorError(
      "unsupported_channel",
      "No enabled connector can create a conversation",
      501,
    );
  }
  return found;
}

async function createConversationOnce(
  state: ConnectorState,
  input: {
    installation_id?: string;
    source?: string;
    text?: string;
    cwd?: string;
    locale?: CopyLocale;
  },
): Promise<CreatedConversationView> {
  const host = state.runtime.requireHost();
  const opened = await openCreatedThread(state, input);
  const firstTask = opened.create_with_task ? input.text?.trim() : undefined;
  if (firstTask) {
    try {
      await seedCreatedOutbound(state, 
        opened.installation,
        opened.driver,
        opened.thread,
        firstTask,
        host,
      );
    } catch {
      // Poll below can still land the first task from the connector.
    }
  }
  return {
    thread_id: `${opened.thread.source}:${opened.thread.target}`,
    channel: opened.thread.source,
    channel_label: state.drivers.sourceLabel(
      opened.thread.source,
      process.env,
      input.locale ?? DEFAULT_COPY_LOCALE,
    ),
    can_send: driverCanReply(opened.driver, opened.installation),
    await_reply: opened.driver.capabilities(opened.installation).await_reply === true,
    list_title: normalizeListTitle(
      opened.driver.capabilities(opened.installation).list_title,
    ),
  };
}

async function seedCreatedOutbound(
  state: ConnectorState,
  installation: ConnectorInstallation,
  driver: ChannelDriver,
  thread: ConversationThread,
  text: string,
  host: Host,
): Promise<void> {
  const now = new Date().toISOString();
  const receipt = { accepted: true as const, rpc_id: randomUUID() };
  const externalId = driver.outboundId
    ? driver.outboundId(thread, receipt)
    : `${thread.target}:out:${receipt.rpc_id}`;
  const record = channelRecord({
    channel: driver.source,
    kind: "user",
    direction: "outbound",
    external_id: externalId,
    occurred_at: now,
    actor_id: "local-owner",
    scope_id: thread.target,
    text,
  });
  record.weight_hints = { importance: 1 };
  await host.get("ingest").ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: installation.id,
    org_id: state.runtime.orgId(),
    delivery_id: `create:${externalId}`,
    received_at: now,
    records: [record],
  });
}

async function seedCreatedThread(
  state: ConnectorState,
  installation: ConnectorInstallation,
  driver: ChannelDriver,
  thread: ConversationThread,
  host: Host,
): Promise<void> {
  const stream = await driver.resolveThreadStream(
    installation,
    thread,
    asConnectorHost(host),
    process.env,
  );
  await pollStream(
    host,
    host.get("authority"),
    installation,
    stream,
    1,
    undefined,
    state.quota,
  );
}
