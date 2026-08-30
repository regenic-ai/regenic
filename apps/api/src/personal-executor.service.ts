import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  DEFAULT_COPY_LOCALE,
  DEFAULT_LOCAL_EXECUTOR_ID,
  resolveExecutorCatalog,
  type CopyLocale,
  EXECUTOR_DEFAULTS_SEEDED_PREF,
  LocalExecutorPluginRegistry,
  createHttpTaskExecutor,
  createLocalConnectorExecutor,
  createSessionTaskExecutor,
  defaultLocalExecutorInstallation,
  executorConfigText,
  isExecutorKind,
  isExecutorInstallStatus,
  normalizeExecutorInstallConfig,
  type ConnectorInstallation,
  type ExecutorCatalogEntry,
  type ExecutorInstallation,
  type ExecutorInstallStatus,
  type ExecutorKind,
  type JsonValue,
} from "@regenic/domain";
import { EXECUTOR_INSTALL_DOCS, type CatalogDocRef } from "./install-docs";
import { PersonalConnectorError } from "./personal-errors";
import { toInstallationView } from "./personal-connector-view";
import { PersonalRuntimeService } from "./personal-runtime.service";

export interface ExecutorInput {
  kind?: string;
  name?: string;
  config?: Record<string, unknown>;
}

export interface EngineExecutorView {
  id: string;
  kind: ExecutorKind;
  name: string;
  status: ExecutorInstallStatus;
  label: string;
  detail: string | null;
  connector_id?: string;
  base_url?: string;
  auth_env?: string;
}

export interface ExecutorKindField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ExecutorKindCatalogItem {
  kind: ExecutorKind;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  fields: ExecutorKindField[];
  docs: CatalogDocRef[];
}

@Injectable()
export class PersonalExecutorService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(LocalExecutorPluginRegistry)
    private readonly localPlugins: LocalExecutorPluginRegistry,
  ) {}

  async ensureMounted(): Promise<void> {
    const next = this.queue.then(() => this.remount());
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async listCatalog(locale: CopyLocale = DEFAULT_COPY_LOCALE): Promise<ExecutorCatalogEntry[]> {
    await this.ensureMounted();
    return this.runtime
      .requireHost()
      .get("executors")
      .list()
      .map((executor) =>
        resolveExecutorCatalog(
          executor.catalog(),
          executor.locales?.() ?? [],
          locale,
        ),
      );
  }

  async listViews(): Promise<EngineExecutorView[]> {
    await this.ensureMounted();
    const orgId = this.runtime.orgId();
    const host = this.runtime.requireHost();
    const [rows, connectors] = await Promise.all([
      host.get("authority").listExecutorInstallations(orgId),
      host.get("authority").listInstallations(orgId),
    ]);
    return rows.map((row) => this.toView(row, connectors));
  }

  kindCatalog(
    installations: EngineExecutorView[],
    connectorOptions: Array<{ value: string; label: string }>,
  ): ExecutorKindCatalogItem[] {
    return [
      {
        kind: "local_connector",
        title: "Local connector",
        description:
          "Bind a creatable local connector. The executor starts a session on that installation.",
        credential_hint: "Uses the connector's credentials",
        installed: installations.some((item) => item.kind === "local_connector"),
        instance_count: installations.filter((item) => item.kind === "local_connector")
          .length,
        setup_ready: connectorOptions.length > 0,
        fields: [
          {
            key: "name",
            label: "Name",
            required: false,
            placeholder: "Office DSH",
          },
          {
            key: "installation_id",
            label: "Connector",
            required: true,
            options: connectorOptions,
          },
        ],
        docs: EXECUTOR_INSTALL_DOCS,
      },
      {
        kind: "http",
        title: "HTTP API",
        description:
          "Call an external executor. POST /v1/runs, GET /v1/runs/:id, POST /v1/runs/:id/resume.",
        credential_hint: "Bearer token from an environment variable",
        installed: installations.some((item) => item.kind === "http"),
        instance_count: installations.filter((item) => item.kind === "http").length,
        setup_ready: true,
        fields: [
          {
            key: "name",
            label: "Name",
            required: false,
            placeholder: "Remote agent",
          },
          {
            key: "base_url",
            label: "Base URL",
            required: true,
            placeholder: "https://agent.example/executor",
          },
          {
            key: "auth_env",
            label: "Token environment variable",
            required: false,
            hint: "Name of the env var that holds the Bearer token. The form does not accept the token.",
            placeholder: "REGENIC_EXECUTOR_TOKEN",
          },
        ],
        docs: EXECUTOR_INSTALL_DOCS,
      },
    ];
  }

  async creatableConnectorOptions(
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): Promise<Array<{ value: string; label: string }>> {
    if (!this.runtime.isReady()) {
      return [];
    }
    const installations = await this.runtime
      .requireHost()
      .get("authority")
      .listInstallations(this.runtime.orgId());
    return installations.flatMap((installation) => {
      const driver = this.drivers.get(installation.connector_type);
      if (!driver?.capabilities(installation).create) {
        return [];
      }
      const view = toInstallationView(installation, null, this.drivers, locale);
      return [{ value: installation.id, label: view.label }];
    });
  }

  async install(input: ExecutorInput): Promise<EngineExecutorView> {
    const kind = input.kind?.trim();
    if (!isExecutorKind(kind)) {
      throw new PersonalConnectorError(
        "invalid_config",
        "kind must be local_connector or http",
        400,
      );
    }
    const now = new Date().toISOString();
    const config = await this.validatedConfig(kind, input.config, {
      requirePin: true,
    });
    const installation: ExecutorInstallation = {
      id: randomUUID(),
      org_id: this.runtime.orgId(),
      kind,
      name: this.resolveName(kind, input.name, config),
      status: "enabled",
      config,
      created_at: now,
      updated_at: now,
    };
    await this.runtime
      .requireHost()
      .get("authority")
      .putExecutorInstallation(installation);
    await this.ensureMounted();
    return this.viewOf(installation);
  }

  async update(id: string, input: ExecutorInput): Promise<EngineExecutorView> {
    const existing = await this.requireInstallation(id);
    const now = new Date().toISOString();
    const config =
      input.config !== undefined
        ? await this.validatedConfig(existing.kind, input.config, {
            requirePin: existing.id !== DEFAULT_LOCAL_EXECUTOR_ID,
          })
        : existing.config;
    const updated: ExecutorInstallation = {
      ...existing,
      name: this.resolveName(
        existing.kind,
        input.name ?? existing.name,
        config,
      ),
      config,
      updated_at: now,
    };
    await this.runtime
      .requireHost()
      .get("authority")
      .putExecutorInstallation(updated);
    await this.ensureMounted();
    return this.viewOf(updated);
  }

  async setStatus(
    id: string,
    status: ExecutorInstallStatus,
  ): Promise<EngineExecutorView> {
    if (!isExecutorInstallStatus(status)) {
      throw new PersonalConnectorError("invalid_config", "Invalid status", 400);
    }
    const existing = await this.requireInstallation(id);
    const updated: ExecutorInstallation = {
      ...existing,
      status,
      updated_at: new Date().toISOString(),
    };
    await this.runtime
      .requireHost()
      .get("authority")
      .putExecutorInstallation(updated);
    await this.ensureMounted();
    return this.viewOf(updated);
  }

  async uninstall(id: string): Promise<void> {
    const existing = await this.requireInstallation(id);
    const removed = await this.runtime
      .requireHost()
      .get("authority")
      .deleteExecutorInstallation(existing.org_id, existing.id);
    if (!removed) {
      throw new PersonalConnectorError("not_found", "Executor not found", 404);
    }
    await this.ensureMounted();
  }

  private async remount(): Promise<void> {
    if (!this.runtime.isReady()) {
      return;
    }
    try {
      const host = this.runtime.requireHost();
      const orgId = this.runtime.orgId();
      const authority = host.get("authority");
      await this.ensureDefaults(orgId);
      if (!this.runtime.isReady()) {
        return;
      }
      const rows = await authority.listExecutorInstallations(orgId);
      const registry = host.get("executors");
      registry.clear();
      for (const row of rows) {
        if (row.status !== "enabled") {
          continue;
        }
        registry.register(await this.createRuntime(row));
      }
    } catch (error) {
      if (!this.runtime.isReady() || isClosedStore(error)) {
        return;
      }
      throw error;
    }
  }

  private async ensureDefaults(orgId: string): Promise<void> {
    const authority = this.runtime.requireHost().get("authority");
    const seeded = await authority.getUiPref(orgId, EXECUTOR_DEFAULTS_SEEDED_PREF);
    if (seeded) {
      return;
    }
    const existing = await authority.listExecutorInstallations(orgId);
    const now = new Date().toISOString();
    if (existing.length === 0) {
      await authority.putExecutorInstallation(
        defaultLocalExecutorInstallation(orgId, now),
      );
    }
    await authority.putUiPref(orgId, EXECUTOR_DEFAULTS_SEEDED_PREF, "1", now);
  }

  private async createRuntime(row: ExecutorInstallation) {
    if (row.kind === "http") {
      const timeout = row.config.timeout_ms;
      return createHttpTaskExecutor({
        executor_type: row.id,
        label: row.name,
        base_url: executorConfigText(row.config, "base_url"),
        auth_env: executorConfigText(row.config, "auth_env") || undefined,
        timeout_ms:
          typeof timeout === "number" && timeout > 0 ? timeout : undefined,
      });
    }
    const pin = executorConfigText(row.config, "installation_id");
    const source = pin ? await this.sourceOf(pin) : undefined;
    const plugin =
      (source ? this.localPlugins.forSource(source) : undefined) ??
      this.localPlugins.default() ??
      createSessionTaskExecutor({ source });
    return createLocalConnectorExecutor({
      executor_type: row.id,
      label: row.name,
      source: plugin.catalog().source ?? source,
      installation_id: pin || undefined,
      plugin,
    });
  }

  private async sourceOf(installationId: string): Promise<string | undefined> {
    const connector = await this.runtime
      .requireHost()
      .get("authority")
      .findInstallation(installationId);
    const driver = connector
      ? this.drivers.get(connector.connector_type)
      : undefined;
    return driver?.source;
  }

  private async validatedConfig(
    kind: ExecutorKind,
    config: Record<string, unknown> | undefined,
    options: { requirePin: boolean },
  ): Promise<Record<string, JsonValue>> {
    try {
      const normalized = normalizeExecutorInstallConfig(kind, config);
      if (kind === "local_connector") {
        const pin = executorConfigText(normalized, "installation_id");
        if (options.requirePin && !pin) {
          throw new PersonalConnectorError(
            "invalid_config",
            "Select a local connector that can create an executor session",
            400,
          );
        }
        if (pin) {
          await this.assertCreatableConnector(pin);
        }
      }
      return normalized;
    } catch (error) {
      if (error instanceof PersonalConnectorError) {
        throw error;
      }
      throw new PersonalConnectorError(
        "invalid_config",
        error instanceof Error ? error.message : "Invalid executor config",
        400,
      );
    }
  }

  private async assertCreatableConnector(installationId: string): Promise<void> {
    const installation = await this.runtime
      .requireHost()
      .get("authority")
      .findInstallation(installationId);
    if (!installation || installation.org_id !== this.runtime.orgId()) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Connector installation not found",
        400,
      );
    }
    const driver = this.drivers.get(installation.connector_type);
    if (!driver?.capabilities(installation).create) {
      throw new PersonalConnectorError(
        "invalid_config",
        "That connector cannot create an executor session",
        400,
      );
    }
  }

  private resolveName(
    kind: ExecutorKind,
    name: string | undefined,
    config: Record<string, JsonValue>,
  ): string {
    const trimmed = name?.trim() ?? "";
    if (trimmed) {
      return trimmed;
    }
    if (kind === "http") {
      return hostOf(executorConfigText(config, "base_url")) || "HTTP API";
    }
    return "Local connector";
  }

  private async requireInstallation(id: string): Promise<ExecutorInstallation> {
    const found = await this.runtime
      .requireHost()
      .get("authority")
      .getExecutorInstallation(this.runtime.orgId(), id);
    if (!found) {
      throw new PersonalConnectorError("not_found", "Executor not found", 404);
    }
    return found;
  }

  private async viewOf(
    row: ExecutorInstallation,
  ): Promise<EngineExecutorView> {
    const connectors = await this.runtime
      .requireHost()
      .get("authority")
      .listInstallations(this.runtime.orgId());
    return this.toView(row, connectors);
  }

  private toView(
    row: ExecutorInstallation,
    connectors: ConnectorInstallation[],
  ): EngineExecutorView {
    const pin = executorConfigText(row.config, "installation_id");
    const connector = pin
      ? connectors.find((item) => item.id === pin)
      : undefined;
    let detail: string | null = null;
    if (row.kind === "http") {
      detail = hostOf(executorConfigText(row.config, "base_url"));
    } else if (connector) {
      detail = toInstallationView(connector, null, this.drivers).label;
    } else if (row.id === DEFAULT_LOCAL_EXECUTOR_ID) {
      detail = "Auto · first creatable connector";
    } else if (pin) {
      detail = "Connector missing";
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      label: row.name,
      detail,
      connector_id: pin || undefined,
      base_url:
        row.kind === "http"
          ? executorConfigText(row.config, "base_url") || undefined
          : undefined,
      auth_env:
        row.kind === "http"
          ? executorConfigText(row.config, "auth_env") || undefined
          : undefined,
    };
  }
}

function isClosedStore(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database connection is not open/i.test(message);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
