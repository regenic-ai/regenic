import { randomUUID } from "node:crypto";
import {
  assertConnectorResponseEnvelope,
  assertConnectorStreamDescriptor,
  parseServerAppConnectionResponse,
  parseServerAppManifest,
  SERVER_APP_CONNECT_PATH,
  SERVER_APP_INVOKE_PATH,
  SERVER_APP_MANIFEST_PATH,
  SERVER_APP_PROTOCOL,
  validateIngestBatch,
  type ChannelDriver,
  type ConnectorConnectionContext,
  type ConnectorInstallation,
  type ConnectorJson,
  type ConnectorPollOptions,
  type ConnectorRequestEnvelope,
  type ConnectorResponseEnvelope,
  type ConnectorStreamDescriptor,
  type IngestBatch,
  type JsonValue,
  type NewConnectorInstallation,
  type PollResult,
  type ServerAppManifest,
  type SyncDirectoryPage,
} from "@regenic/connector-contract";
import {
  ChannelDriverError,
  CONNECTOR_PROTOCOL,
  createHttpTaskExecutor,
  normalizeExecutorHttpUrl,
} from "@regenic/domain";
import { serverAppLocaleTables } from "./locales";

export const SERVER_APP_CONNECTOR_TYPE = "server-app";
export const SERVER_APP_SOURCE = "server_app";
const REQUEST_TIMEOUT_MS = 15_000;

export const serverAppDriver: ChannelDriver = {
  connector_type: SERVER_APP_CONNECTOR_TYPE,
  source: SERVER_APP_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  async install(input): Promise<NewConnectorInstallation> {
    const baseUrl = normalizeExecutorHttpUrl(text(input.config.base_url));
    const token =
      text(input.config.token) ||
      (await input.secrets?.read(SERVER_APP_CONNECTOR_TYPE, input.id, "token")) ||
      "";
    const manifest = await discoverServerApp(baseUrl, token);
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: SERVER_APP_CONNECTOR_TYPE,
      status: "enabled",
      config: {
        base_url: baseUrl,
        app_id: manifest.app_id,
        app_name: manifest.name,
        manifest: manifest as unknown as JsonValue,
      },
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return installation.status === "enabled" && thread.source === SERVER_APP_SOURCE;
  },

  ownsThread(installation, thread) {
    const prefix = `${appId(installation)}:`;
    return this.matchesThread(installation, thread) && thread.target.startsWith(prefix);
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    const capabilities = manifestOf(installation).capabilities;
    return {
      sync: Boolean(capabilities.source?.push || capabilities.source?.pull),
      reply: capabilities.source?.reply === true,
      create: capabilities.source?.create === true,
      execute: capabilities.agent === true,
      list_title: capabilities.agent ? "prompt" : "conversation",
    };
  },

  async connectInstallation(installation, host, env, context) {
    const manifest = manifestOf(installation);
    const ingest = manifest.capabilities.source?.push ? context.ingest : undefined;
    if (!ingest) {
      if (manifest.capabilities.source?.push) {
        throw new ChannelDriverError("invalid_config", "public_url_required");
      }
    } else if (
      isLoopback(new URL(ingest.url).hostname) &&
      !isLoopback(new URL(baseUrl(installation)).hostname)
    ) {
      throw new ChannelDriverError("invalid_config", "public_url_required");
    }
    const response = await requestJson(
      endpoint(baseUrl(installation), manifest.endpoints.connect || SERVER_APP_CONNECT_PATH),
      {
        method: "POST",
        token: await accessToken(installation, host, env),
        body: {
          protocol: SERVER_APP_PROTOCOL,
          installation_id: installation.id,
          namespace: {
            source: SERVER_APP_SOURCE,
            id_prefix: `${appId(installation)}:`,
          },
          ...(ingest ? { ingest } : {}),
        },
      },
    );
    const connected = parseServerAppConnectionResponse(response);
    return { connection_id: connected.connection_id };
  },

  async bindExecutor(installation, host, env) {
    const manifest = manifestOf(installation);
    if (!manifest.capabilities.agent) {
      throw new ChannelDriverError("invalid_config", "Server app is not an Agent");
    }
    return createHttpTaskExecutor({
      executor_type: installation.id,
      label: manifest.name,
      description: manifest.description,
      base_url: endpoint(baseUrl(installation), manifest.endpoints.runs)
        .replace(/\/v1\/runs\/?$/, ""),
      auth_token: await accessToken(installation, host, env),
    });
  },

  async resolveStreams(installation, host, env, options) {
    if (!manifestOf(installation).capabilities.source?.pull) return [];
    const result = await invoke(installation, host, env, "resolve_streams", {
      discover: options?.discover === true,
      threads: (options?.threads ?? []).map((thread) => ({
        source: thread.source,
        target: unprefix(installation, thread.target),
      })),
    });
    const record = object(result);
    const streams = Array.isArray(record.streams) ? record.streams : [];
    return streams.map((value) => {
      assertConnectorStreamDescriptor(value);
      return streamFor(installation, host, env, value);
    });
  },

  async resolveThreadStream(installation, thread, host, env) {
    const remoteTarget = unprefix(installation, thread.target);
    const result = await invoke(installation, host, env, "resolve_streams", {
      threads: [{ source: SERVER_APP_SOURCE, target: remoteTarget }],
    });
    const streams = object(result).streams;
    const value = Array.isArray(streams) ? streams[0] : undefined;
    if (!value) {
      throw new ChannelDriverError("sync_failed", "Server app returned no stream");
    }
    assertConnectorStreamDescriptor(value);
    return streamFor(installation, host, env, value);
  },

  async bindSyncSource(installation, host, env) {
    if (!manifestOf(installation).capabilities.source?.pull) return {};
    return {
      listDirectory: async (cursor) => {
        const result = object(
          await invoke(installation, host, env, "list_directory", { cursor }),
        );
        const page = result as unknown as SyncDirectoryPage;
        if (!Array.isArray(page.members) || typeof page.complete !== "boolean") {
          throw new ChannelDriverError("sync_failed", "Invalid server directory page");
        }
        return {
          ...page,
          members: page.members.map((member) => ({
            ...member,
            stream_key: prefix(installation, member.stream_key),
            ...(member.thread_id
              ? { thread_id: prefix(installation, member.thread_id) }
              : {}),
          })),
        };
      },
    };
  },

  installCatalog() {
    return {
      form_version: 2 as const,
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      singleton: false,
      bind_executor: true,
      fields: [
        {
          key: "base_url",
          type: "string" as const,
          label: "field.baseUrl",
          placeholder: "field.baseUrl.placeholder",
          description: "field.baseUrl.description",
          required: true,
        },
        {
          key: "token",
          type: "string" as const,
          widget: "password" as const,
          secret: true,
          label: "field.token",
          placeholder: "field.token.placeholder",
          description: "field.token.description",
          required: false,
        },
      ],
      setup_steps: [
        {
          title: "setup.address.title",
          body: "setup.address.body",
        },
        {
          title: "setup.callback.title",
          body: "setup.callback.body",
        },
      ],
    };
  },

  locales() {
    return serverAppLocaleTables;
  },

  presentInstall(installation) {
    const manifest = manifestOf(installation);
    const source = Boolean(
      manifest.capabilities.source?.push ||
      manifest.capabilities.source?.pull,
    );
    const agent = manifest.capabilities.agent;
    return {
      label: { literal: manifest.name },
      detail: source && agent
        ? "present.sourceAgent"
        : source
          ? "present.source"
          : "present.agent",
    };
  },
};

async function discoverServerApp(base: string, token: string): Promise<ServerAppManifest> {
  const body = await requestJson(endpoint(base, SERVER_APP_MANIFEST_PATH), {
    method: "GET",
    token,
  });
  return parseServerAppManifest(body);
}

function streamFor(
  installation: ConnectorInstallation,
  host: Parameters<NonNullable<ChannelDriver["resolveStreams"]>>[1],
  env: NodeJS.ProcessEnv,
  descriptor: ConnectorStreamDescriptor,
) {
  return {
    stream_key: prefix(installation, descriptor.stream_key),
    ...(descriptor.thread_id
      ? { thread_id: prefix(installation, descriptor.thread_id) }
      : {}),
    ...(descriptor.label ? { label: descriptor.label } : {}),
    ...(descriptor.pace ? { pace: descriptor.pace } : {}),
    connector: {
      source: SERVER_APP_SOURCE,
      async poll(
        cursor: { value: string } | null,
        options?: ConnectorPollOptions,
      ): Promise<PollResult> {
        const result = object(
          await invoke(installation, host, env, "poll", {
            stream: descriptor as unknown as ConnectorJson,
            ...(cursor ? { cursor: cursor.value } : {}),
            ...(options?.older ? { older: true } : {}),
            ...(options?.latest ? { latest: true } : {}),
            ...(options?.media !== undefined ? { media: options.media } : {}),
            ...(options?.before ? { before: options.before } : {}),
            ...(options?.before_external_id
              ? { before_external_id: options.before_external_id }
              : {}),
            ...(options?.push_watermark
              ? { push_watermark: options.push_watermark }
              : {}),
          }),
        );
        const validation = validateIngestBatch(result.batch);
        if (!validation.success) {
          throw new ChannelDriverError("sync_failed", "Invalid server poll batch");
        }
        return {
          ...result,
          batch: namespaceBatch(installation, validation.data),
        } as PollResult;
      },
    },
  };
}

async function invoke(
  installation: ConnectorInstallation,
  host: Parameters<NonNullable<ChannelDriver["resolveStreams"]>>[1],
  env: NodeJS.ProcessEnv,
  kind: ConnectorRequestEnvelope["kind"],
  payload: ConnectorJson,
): Promise<ConnectorJson> {
  const requestId = randomUUID();
  const request: ConnectorRequestEnvelope = {
    protocol: "1.0",
    kind,
    context: {
      request_id: requestId,
      installation_id: installation.id,
      connector_type: SERVER_APP_CONNECTOR_TYPE,
    },
    payload,
  };
  const manifest = manifestOf(installation);
  const body = await requestJson(
    endpoint(baseUrl(installation), manifest.endpoints.invoke || SERVER_APP_INVOKE_PATH),
    {
      method: "POST",
      token: await accessToken(installation, host, env),
      body: request,
    },
  );
  assertConnectorResponseEnvelope(body);
  const response = body as ConnectorResponseEnvelope;
  if (response.request_id !== requestId) {
    throw new ChannelDriverError("sync_failed", "Server response identity mismatch");
  }
  if (!response.ok) {
    throw new ChannelDriverError(
      response.error.retryable ? "throttled" : "sync_failed",
      response.error.message,
    );
  }
  return response.result;
}

function namespaceBatch(
  installation: ConnectorInstallation,
  batch: IngestBatch,
): IngestBatch {
  return {
    ...batch,
    connector_id: installation.id,
    org_id: installation.org_id,
    records: batch.records.map((record) => ({
      ...record,
      source: SERVER_APP_SOURCE,
      external_id: prefix(installation, record.external_id),
      scope: { ...record.scope, id: prefix(installation, record.scope.id) },
      ...(record.thread
        ? { thread: { id: prefix(installation, record.thread.id) } }
        : {}),
      ...(record.parent_external_id
        ? { parent_external_id: prefix(installation, record.parent_external_id) }
        : {}),
    })),
  };
}

async function accessToken(
  installation: ConnectorInstallation,
  host: Parameters<NonNullable<ChannelDriver["resolveStreams"]>>[1],
  _env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await host.secrets.read(
    SERVER_APP_CONNECTOR_TYPE,
    installation.id,
    "token",
  )) ?? "";
}

function manifestOf(installation: ConnectorInstallation): ServerAppManifest {
  return parseServerAppManifest(installation.config.manifest);
}

function baseUrl(installation: ConnectorInstallation): string {
  return normalizeExecutorHttpUrl(text(installation.config.base_url));
}

function appId(installation: ConnectorInstallation): string {
  return text(installation.config.app_id);
}

function prefix(installation: ConnectorInstallation, value: string): string {
  const marker = `${appId(installation)}:`;
  return value.startsWith(marker) ? value : `${marker}${value}`;
}

function unprefix(installation: ConnectorInstallation, value: string): string {
  const marker = `${appId(installation)}:`;
  return value.startsWith(marker) ? value.slice(marker.length) : value;
}

function endpoint(base: string, path: string): string {
  const root = new URL(`${base}/`);
  const target = new URL(path, root);
  if (target.origin !== root.origin) {
    throw new ChannelDriverError(
      "invalid_config",
      "Server app endpoints must use the server origin",
    );
  }
  return target.toString().replace(/\/$/, "");
}

async function requestJson(
  url: string,
  input: { method: "GET" | "POST"; token?: string; body?: unknown },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: input.method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(input.body ? { "content-type": "application/json" } : {}),
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    throw new ChannelDriverError(
      "sync_failed",
      error instanceof Error ? error.message : "Server app request failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function object(value: ConnectorJson): Record<string, ConnectorJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelDriverError("sync_failed", "Server app returned an invalid object");
  }
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
