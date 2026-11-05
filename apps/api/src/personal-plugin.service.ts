import { watch, type FSWatcher } from "node:fs";
import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
} from "@regenic/domain";
import {
  ensurePluginDirectory,
  beginMarketVersionChange,
  listPluginInventory,
  loadNewExtraPlugins,
  marketVersionHistory,
  markMarketVersionChangePending,
  markMarketPluginRemovalPending,
  retryMarketPluginRegistration as retryPluginRegistration,
  type MarketVersionChange,
} from "./channel-plugins";

const WATCH_DEBOUNCE_MS = 400;

@Injectable()
export class PersonalPluginService implements OnModuleDestroy {
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(LocalExecutorPluginRegistry)
    private readonly executors: LocalExecutorPluginRegistry,
  ) {}

  startAfterListen(env: NodeJS.ProcessEnv = process.env): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.watchPluginDir(env);
  }

  list() {
    return listPluginInventory();
  }

  retryMarketRegistration(packageName: string, env: NodeJS.ProcessEnv = process.env) {
    const installed = this.list().find((item) =>
      item.package_name === packageName && item.install_source === "market",
    );
    if (!installed) {
      throw new NotFoundException({
        error: {
          code: "market_connector_not_found",
          message: "The market connector package was not found.",
        },
      });
    }
    if (installed.status === "update_pending" || installed.status === "uninstall_pending") {
      throw new ConflictException({
        error: {
          code: "market_connector_lifecycle_pending",
          message: "Finish the pending connector update or removal before retrying registration.",
        },
      });
    }

    const result = retryPluginRegistration(packageName, this.drivers, this.executors, env);
    const plugin = this.list().find((item) =>
      item.package_name === packageName && item.install_source === "market",
    );
    const driverTypes = result?.driverTypes ?? [];
    const registeredDriverTypes = result?.registeredDriverTypes ?? [];
    const executorSources = result?.executorSources ?? [];
    const registeredExecutorSources = result?.registeredExecutorSources ?? [];
    const registered = plugin?.status === "loaded" &&
      !plugin.error &&
      driverTypes.length > 0 &&
      registeredDriverTypes.length === driverTypes.length &&
      registeredExecutorSources.length === executorSources.length;

    return {
      package_name: packageName,
      registered,
      plugin_status: plugin?.status ?? "failed",
      driver_types: driverTypes,
      registered_driver_types: registeredDriverTypes,
      executor_sources: executorSources,
      registered_executor_sources: registeredExecutorSources,
      error: registered
        ? null
        : plugin?.error ??
          "One or more connector types or executor sources are already registered by another plugin.",
    };
  }

  retireDrivers(connectorTypes: string[]): void {
    for (const connectorType of connectorTypes) {
      this.drivers.retire(connectorType);
    }
  }

  markMarketRemovalPending(
    packageName: string,
    env: NodeJS.ProcessEnv = process.env,
  ): string[] {
    const connectorTypes = markMarketPluginRemovalPending(packageName, env);
    this.retireDrivers(connectorTypes);
    return connectorTypes;
  }

  marketVersionHistory(packageName: string, env: NodeJS.ProcessEnv = process.env) {
    const directory = ensurePluginDirectory(env);
    return directory ? marketVersionHistory(packageName, directory) : [];
  }

  beginMarketVersionChange(
    change: MarketVersionChange,
    env: NodeJS.ProcessEnv = process.env,
  ): void {
    beginMarketVersionChange(change, env);
    markMarketVersionChangePending(
      change.package_name,
      change.to_version,
      change.operation,
    );
  }

  reload(env: NodeJS.ProcessEnv = process.env) {
    try {
      ensurePluginDirectory(env);
    } catch (error) {
      console.warn("regenic extra connector: cannot create plugin dir", error);
    }

    const loaded = loadNewExtraPlugins(this.drivers, this.executors, env);
    if (loaded.drivers.length > 0 || loaded.executors.length > 0) {
      console.info(
        `regenic extra connector: loaded ${loaded.drivers.join(", ") || "—"} / ${loaded.executors.join(", ") || "—"}`,
      );
    }
    return {
      loaded_drivers: loaded.drivers,
      registered_drivers: loaded.registeredDrivers,
      loaded_executors: loaded.executors,
      registered_executors: loaded.registeredExecutors,
    };
  }

  stopBackground(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    this.started = false;
  }

  onModuleDestroy(): void {
    this.stopBackground();
  }

  private watchPluginDir(env: NodeJS.ProcessEnv): void {
    let dir: string | null;
    try {
      dir = ensurePluginDirectory(env);
    } catch (error) {
      console.warn("regenic extra connector: cannot create plugin dir", error);
      return;
    }
    if (!dir) {
      return;
    }
    try {
      this.watcher = watch(dir, { persistent: false }, () => {
        if (this.debounce) {
          clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          this.reload(env);
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => {
        console.warn("regenic extra connector: plugin dir watch failed", error);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      console.warn("regenic extra connector: cannot watch plugin dir", error);
    }
  }
}
