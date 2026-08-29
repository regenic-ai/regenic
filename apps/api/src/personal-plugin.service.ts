import { watch, type FSWatcher } from "node:fs";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
} from "@regenic/domain";
import {
  ensurePluginDirectory,
  listPluginInventory,
  loadNewExtraPlugins,
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
      loaded_executors: loaded.executors,
    };
  }

  onModuleDestroy(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
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
