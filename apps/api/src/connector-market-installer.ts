import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { x as extractTar } from "tar";
import {
  ConnectorMarketService,
  type ConnectorMarketRelease,
} from "./connector-market.service";
import { PersonalPluginService } from "./personal-plugin.service";
import {
  ensurePluginDirectory,
  listPluginInventory,
  type MarketVersionChange,
} from "./channel-plugins";
import { PersonalRuntimeService } from "./personal-runtime.service";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const INSTALL_TIMEOUT_MS = 180_000;
const INSTALL_JOB_RETENTION_MS = 30 * 60_000;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const INSTALL_PHASES = [
  "checking",
  "downloading",
  "verifying",
  "installing_dependencies",
  "registering",
  "staging_update",
] as const;

export type ConnectorInstallPhase =
  | typeof INSTALL_PHASES[number]
  | "completed"
  | "failed";

export interface ConnectorInstallResult {
  package_name: string;
  version: string;
  installed: true;
  registered: boolean;
  plugin_status: string;
  driver_types: string[];
  registered_driver_types: string[];
  message: string | null;
  pending_restart?: boolean;
}

export interface ConnectorInstallJob {
  id: string;
  package_name: string;
  version: string;
  operation?: "install" | "update";
  phase: ConnectorInstallPhase;
  installed: boolean;
  started_at: string;
  updated_at: string;
  result?: ConnectorInstallResult;
  error?: string;
}

interface NpmPackageVersion {
  name?: string;
  version?: string;
  regenic?: {
    plugin?: boolean;
    engines?: { regenic?: string };
    contributes?: { drivers?: string[]; executors?: string[] };
  };
  dependencies?: Record<string, string>;
  dist?: { integrity?: string; tarball?: string };
}

@Injectable()
export class ConnectorMarketInstaller {
  private readonly jobs = new Map<string, ConnectorInstallJob>();
  private readonly activeByPackage = new Map<string, string>();
  private jobsPath: string | null = null;
  private jobsLoaded = false;
  private persistence = Promise.resolve();

  constructor(
    private readonly market: ConnectorMarketService,
    private readonly plugins: PersonalPluginService,
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async install(
    input: { package_name?: unknown; version?: unknown; confirmed?: unknown },
    fetchImpl: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
    onPhase: (phase: ConnectorInstallPhase) => void | Promise<void> = () => undefined,
  ): Promise<ConnectorInstallResult> {
    return this.installPackage(input, fetchImpl, env, onPhase, "install");
  }

  private async installPackage(
    input: { package_name?: unknown; version?: unknown; confirmed?: unknown },
    fetchImpl: typeof fetch,
    env: NodeJS.ProcessEnv,
    onPhase: (phase: ConnectorInstallPhase) => void | Promise<void>,
    operation: "install" | "update",
  ): Promise<ConnectorInstallResult> {
    const packageName = typeof input.package_name === "string" ? input.package_name.trim() : "";
    const version = typeof input.version === "string" ? input.version.trim() : "";
    if (input.confirmed !== true) {
      throw new BadRequestException({
        error: { code: "confirmation_required", message: "Connector installation requires explicit confirmation." },
      });
    }
    if (!PACKAGE_NAME.test(packageName) || !SEMVER.test(version)) {
      throw new BadRequestException({
        error: { code: "invalid_market_release", message: "A valid package name and exact version are required." },
      });
    }

    await onPhase("checking");
    const index = await this.market.getMarket(true, env, fetchImpl);
    const connector = index.connectors.find((item) => item.name === packageName);
    const release = connector?.versions.find((item) => item.version === version);
    if (!release || !release.compatible) {
      throw new BadRequestException({
        error: { code: "market_release_unavailable", message: "The selected connector release is not available or compatible." },
      });
    }
    const installedPlugin = listPluginInventory().find((item) =>
      item.package_name === packageName,
    );
    if (operation === "install" && installedPlugin) {
      throw new ConflictException({
        error: { code: "connector_already_present", message: "This connector package is already present locally." },
      });
    }
    if (operation === "update" && (
      installedPlugin?.install_source !== "market" ||
      installedPlugin.status === "uninstall_pending" ||
      installedPlugin.status === "update_pending" ||
      !installedPlugin.version
    )) {
      throw new ConflictException({
        error: { code: "market_connector_not_updatable", message: "Only an installed, idle market connector can be updated." },
      });
    }
    if (operation === "update" && installedPlugin?.version === version) {
      throw new ConflictException({
        error: { code: "market_connector_version_unchanged", message: "The selected version is already installed." },
      });
    }

    const pluginDirectory = ensurePluginDirectory(env);
    if (!pluginDirectory) {
      throw new ServiceUnavailableException({
        error: { code: "plugin_directory_unavailable", message: "The local connector directory is unavailable." },
      });
    }
    const directoryName = `market-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
    const destination = path.join(pluginDirectory, directoryName);
    const stageDirectoryName = `.regenic-market-stage-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
    const stageDestination = path.join(pluginDirectory, stageDirectoryName);
    const staging = await mkdtemp(path.join(pluginDirectory, ".regenic-market-"));
    let installed = false;
    try {
      await onPhase("downloading");
      const packument = await fetchPackageVersion(packageName, version, fetchImpl);
      if (
        packument.name !== packageName ||
        packument.version !== version ||
        !containsIntegrity(packument.dist?.integrity, release.integrity)
      ) {
        throw new Error("npm metadata does not match the selected market release");
      }
      const tarballUrl = safeTarballUrl(packument.dist?.tarball);
      const archive = await fetchBytes(tarballUrl, fetchImpl, MAX_TARBALL_BYTES);
      await onPhase("verifying");
      if (integrityOf(archive) !== release.integrity) {
        throw new Error("Downloaded package integrity does not match the market index");
      }

      const archivePath = path.join(staging, "package.tgz");
      await writeFile(archivePath, archive, { flag: "wx" });
      await extractPackage(archivePath, staging);
      await rm(archivePath, { force: true });

      const manifestPath = path.join(staging, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NpmPackageVersion;
      assertPackageManifest(manifest, packageName, version, release);
      validateDependencySpecs(manifest.dependencies);
      if (Object.keys(manifest.dependencies ?? {}).length > 0) {
        await onPhase("installing_dependencies");
        await installDependencies(staging);
      }
      if (operation === "install" && await pathExists(destination)) {
        throw new ConflictException({
          error: { code: "connector_already_present", message: "This connector package is already present locally." },
        });
      }
      if (operation === "update" && await pathExists(stageDestination)) {
        throw new ConflictException({
          error: { code: "market_connector_update_pending", message: "A connector update is already staged." },
        });
      }
      await writeFile(
        path.join(staging, ".regenic-market-install.json"),
        JSON.stringify({
          package_name: packageName,
          version,
          integrity: release.integrity,
          installed_at: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      if (operation === "install") {
        await rename(staging, destination);
        installed = true;
      } else {
        await onPhase("staging_update");
        await rename(staging, stageDestination);
        const change: MarketVersionChange = {
          package_name: packageName,
          from_version: installedPlugin!.version!,
          to_version: version,
          operation: "update",
          stage_directory: stageDirectoryName,
          previous_directory: randomUUID(),
          target_directory: null,
        };
        try {
          this.plugins.beginMarketVersionChange(change, env);
          installed = true;
        } catch (error) {
          await rm(stageDestination, { recursive: true, force: true });
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({
        error: {
          code: "connector_install_failed",
          message: "The connector package could not be verified and installed.",
        },
      });
    } finally {
      if (!installed) await rm(staging, { recursive: true, force: true });
    }

    if (operation === "update") {
      return {
        package_name: packageName,
        version,
        installed: true,
        registered: false,
        plugin_status: "update_pending",
        driver_types: installedPlugin?.drivers ?? [],
        registered_driver_types: [],
        message: "The update is staged and will apply after the API restarts.",
        pending_restart: true,
      };
    }

    await onPhase("registering");
    const reload = this.plugins.reload(env);
    const plugin = this.plugins.list().find((item) => item.package_name === packageName);
    const registeredDrivers = reload.registered_drivers;
    const expectedDrivers = plugin?.drivers ?? [];
    const registered = plugin?.status === "loaded" &&
      expectedDrivers.length > 0 &&
      expectedDrivers.every((type) => registeredDrivers.includes(type));
    return {
      package_name: packageName,
      version,
      installed: true,
      registered,
      plugin_status: plugin?.status ?? "failed",
      driver_types: expectedDrivers,
      registered_driver_types: registeredDrivers,
      message: registered
        ? null
        : "The package is installed, but one or more connector types were not registered.",
    };
  }

  async startInstall(
    input: { package_name?: unknown; version?: unknown; confirmed?: unknown },
    fetchImpl: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ConnectorInstallJob> {
    return this.startJob(input, fetchImpl, env, "install");
  }

  async startUpdate(
    input: { package_name?: unknown; version?: unknown; confirmed?: unknown },
    fetchImpl: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ConnectorInstallJob> {
    return this.startJob(input, fetchImpl, env, "update");
  }

  private async startJob(
    input: { package_name?: unknown; version?: unknown; confirmed?: unknown },
    fetchImpl: typeof fetch,
    env: NodeJS.ProcessEnv,
    operation: "install" | "update",
  ): Promise<ConnectorInstallJob> {
    const packageName = typeof input.package_name === "string" ? input.package_name.trim() : "";
    const version = typeof input.version === "string" ? input.version.trim() : "";
    if (input.confirmed !== true) {
      throw new BadRequestException({
        error: { code: "confirmation_required", message: "Connector installation requires explicit confirmation." },
      });
    }
    if (!PACKAGE_NAME.test(packageName) || !SEMVER.test(version)) {
      throw new BadRequestException({
        error: { code: "invalid_market_release", message: "A valid package name and exact version are required." },
      });
    }
    if (operation === "update") {
      const current = listPluginInventory().find((item) =>
        item.package_name === packageName,
      );
      if (
        current?.install_source !== "market" ||
        !current.version ||
        current.version === version ||
        current.status === "update_pending" ||
        current.status === "uninstall_pending"
      ) {
        throw new ConflictException({
          error: { code: "market_connector_not_updatable", message: "Only an installed market connector with a different version can be updated." },
        });
      }
    }
    await this.loadJobs(env);
    this.pruneJobs();
    if (this.activeByPackage.has(packageName)) {
      throw new ConflictException({
        error: { code: "connector_install_in_progress", message: "This connector package is already being installed." },
      });
    }

    const now = new Date().toISOString();
    const job: ConnectorInstallJob = {
      id: randomUUID(),
      package_name: packageName,
      version,
      operation,
      phase: "checking",
      installed: false,
      started_at: now,
      updated_at: now,
    };
    this.jobs.set(job.id, job);
    this.activeByPackage.set(packageName, job.id);
    try {
      await this.persistJobs();
    } catch {
      this.jobs.delete(job.id);
      this.activeByPackage.delete(packageName);
      throw new ServiceUnavailableException({
        error: { code: "connector_install_state_unavailable", message: "The connector installation state could not be saved." },
      });
    }
    void this.installPackage(input, fetchImpl, env, async (phase) => {
      job.phase = phase;
      if (phase === "registering" || phase === "staging_update") job.installed = true;
      job.updated_at = new Date().toISOString();
      await this.persistJobs();
    }, operation).then(
      async (result) => {
        job.result = result;
        job.phase = "completed";
        job.updated_at = new Date().toISOString();
        this.activeByPackage.delete(packageName);
        await this.persistJobs();
      },
      async () => {
        job.phase = "failed";
        job.error = job.installed
          ? operation === "update"
            ? job.result?.pending_restart
              ? "The update was staged, but its job status could not be saved. Refresh Engine before retrying."
              : "The update could not be staged. The installed version remains active."
            : "The package was installed, but connector registration could not be confirmed."
          : "Installation failed. Verify the market and npm registry are reachable, then try again.";
        job.updated_at = new Date().toISOString();
        this.activeByPackage.delete(packageName);
        await this.persistJobs();
      },
    ).catch(async () => {
      job.phase = "failed";
      job.error = job.installed
        ? operation === "update"
          ? job.result?.pending_restart
            ? "The update was staged, but its job status could not be saved. Refresh Engine before retrying."
            : "The update could not be staged. The installed version remains active."
          : "The package was installed, but connector registration could not be confirmed."
        : "Installation failed. Verify the market and npm registry are reachable, then try again.";
      job.updated_at = new Date().toISOString();
      this.activeByPackage.delete(packageName);
      await this.persistJobs().catch(() => undefined);
    });
    return { ...job };
  }

  async rollback(
    packageName: string,
    confirmed: unknown,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ package_name: string; version: string; pending_restart: true }> {
    if (confirmed !== true) {
      throw new BadRequestException({
        error: { code: "confirmation_required", message: "Connector rollback requires explicit confirmation." },
      });
    }
    if (this.activeByPackage.has(packageName)) {
      throw new ConflictException({
        error: { code: "connector_install_in_progress", message: "Wait for the current package operation to finish before rolling back." },
      });
    }
    const plugin = listPluginInventory().find((item) =>
      item.package_name === packageName && item.install_source === "market",
    );
    if (
      !plugin?.version ||
      plugin.status === "update_pending" ||
      plugin.status === "uninstall_pending"
    ) {
      throw new ConflictException({
        error: { code: "market_connector_not_rollbackable", message: "This market connector cannot be rolled back right now." },
      });
    }
    const previous = this.plugins.marketVersionHistory(packageName, env)[0];
    if (!previous || previous.version === plugin.version) {
      throw new NotFoundException({
        error: { code: "market_connector_previous_version_not_found", message: "No previously installed version is available for rollback." },
      });
    }
    const directory = ensurePluginDirectory(env);
    if (!directory || !plugin.path) {
      throw new ServiceUnavailableException({
        error: { code: "plugin_directory_unavailable", message: "The local connector directory is unavailable." },
      });
    }
    const change: MarketVersionChange = {
      package_name: packageName,
      from_version: plugin.version,
      to_version: previous.version,
      operation: "rollback",
      stage_directory: null,
      previous_directory: randomUUID(),
      target_directory: path.basename(previous.directory),
    };
    try {
      this.plugins.beginMarketVersionChange(change, env);
    } catch {
      throw new ConflictException({
        error: { code: "market_connector_version_change_pending", message: "A market connector version change is already pending." },
      });
    }
    return { package_name: packageName, version: previous.version, pending_restart: true };
  }

  async getInstall(id: string, env: NodeJS.ProcessEnv = process.env): Promise<ConnectorInstallJob> {
    await this.loadJobs(env);
    await this.persistence;
    this.pruneJobs();
    const job = this.jobs.get(id);
    if (!job) {
      throw new NotFoundException({
        error: { code: "connector_install_not_found", message: "The connector installation is no longer available." },
      });
    }
    return { ...job };
  }

  async uninstall(
    packageName: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ package_name: string; pending_restart: true; removed: false }> {
    if (this.activeByPackage.has(packageName)) {
      throw new ConflictException({
        error: { code: "connector_install_in_progress", message: "Wait for the current package operation to finish before uninstalling." },
      });
    }
    const item = listPluginInventory().find(
      (plugin) =>
        plugin.package_name === packageName &&
        plugin.install_source === "market" &&
        plugin.path,
    );
    if (!item) {
      throw new NotFoundException({
        error: { code: "market_connector_not_found", message: "The market-managed connector package was not found." },
      });
    }
    if (item.status === "update_pending") {
      throw new ConflictException({
        error: { code: "market_connector_version_change_pending", message: "Restart the API to finish the pending version change before uninstalling." },
      });
    }
    if (item.status === "uninstall_pending") {
      throw new ConflictException({
        error: { code: "market_connector_removal_pending", message: "Restart the API to finish the pending connector removal." },
      });
    }
    const pluginDirectory = ensurePluginDirectory(env);
    if (!pluginDirectory || path.resolve(path.dirname(item.path!)) !== path.resolve(pluginDirectory)) {
      throw new ServiceUnavailableException({
        error: { code: "plugin_directory_unavailable", message: "The local connector directory is unavailable." },
      });
    }
    const operationId = `uninstall:${randomUUID()}`;
    this.activeByPackage.set(packageName, operationId);
    try {
      const activeInstallations = await this.runtime.requireHost()
        .get("authority")
        .listInstallations(this.runtime.orgId());
      const conflicts = activeInstallations.filter((installation) =>
        item.drivers.includes(installation.connector_type),
      );
      if (conflicts.length > 0) {
        throw new ConflictException({
          error: {
            code: "connector_instances_must_be_removed",
            message: "Remove all connector instances before uninstalling this package.",
            connector_types: [...new Set(conflicts.map((item) => item.connector_type))],
            installation_count: conflicts.length,
          },
        });
      }
      this.plugins.markMarketRemovalPending(packageName, env);
      return { package_name: packageName, pending_restart: true, removed: false };
    } finally {
      if (this.activeByPackage.get(packageName) === operationId) {
        this.activeByPackage.delete(packageName);
      }
    }
  }

  private async loadJobs(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.jobsLoaded) return;
    const directory = ensurePluginDirectory(env);
    if (!directory) {
      throw new ServiceUnavailableException({
        error: { code: "plugin_directory_unavailable", message: "The local connector directory is unavailable." },
      });
    }
    this.jobsPath = path.join(directory, ".connector-market-install-jobs.json");
    try {
      const saved = JSON.parse(await readFile(this.jobsPath, "utf8")) as unknown;
      if (Array.isArray(saved)) {
        for (const value of saved) {
          if (!isInstallJob(value)) continue;
          if (isActivePhase(value.phase)) {
            const installedPath = marketInstallPath(directory, value.package_name);
            value.installed ||= await pathExists(installedPath);
            value.phase = "failed";
            if (value.operation === "update") {
              const activeVersion = await readInstalledMarketVersion(installedPath, value.package_name);
              value.error = activeVersion === value.version
                ? "The update was applied, but the API restarted before its job status was saved. Verify connector status."
                : "The API restarted during update preparation. The previous version remains installed; verify status before retrying.";
            } else {
              value.error = value.installed
                ? "The package was installed, but the API restarted before registration status was saved."
                : "The API restarted before installation completed. Retry the install.";
            }
            value.updated_at = new Date().toISOString();
          }
          this.jobs.set(value.id, value);
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new ServiceUnavailableException({
          error: { code: "connector_install_state_unavailable", message: "The connector installation state could not be loaded." },
        });
      }
    }
    this.jobsLoaded = true;
    await this.persistJobs();
  }

  private async persistJobs(): Promise<void> {
    if (!this.jobsPath) return;
    const serialized = JSON.stringify([...this.jobs.values()]);
    this.persistence = this.persistence.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.jobsPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, this.jobsPath!);
    });
    await this.persistence;
  }

  private pruneJobs(): void {
    const cutoff = Date.now() - INSTALL_JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.updated_at) < cutoff && job.phase !== "checking" &&
        job.phase !== "downloading" && job.phase !== "verifying" &&
        job.phase !== "installing_dependencies" && job.phase !== "registering") {
        this.jobs.delete(id);
      }
    }

    while (this.jobs.size > 100) {
      const oldest = this.jobs.values().next().value as ConnectorInstallJob | undefined;
      if (!oldest || this.activeByPackage.get(oldest.package_name) === oldest.id) break;
      this.jobs.delete(oldest.id);
    }
  }
}

function isInstallJob(value: unknown): value is ConnectorInstallJob {
  if (!isRecord(value) ||
    (value.operation !== undefined && value.operation !== "install" && value.operation !== "update") ||
    typeof value.id !== "string" ||
    typeof value.package_name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.phase !== "string" ||
    ![...INSTALL_PHASES, "completed", "failed"].includes(value.phase as ConnectorInstallPhase) ||
    typeof value.started_at !== "string" ||
    typeof value.updated_at !== "string" ||
    typeof value.installed !== "boolean") {
    return false;
  }
  value.operation ??= "install";
  return true;
}

function isActivePhase(phase: ConnectorInstallPhase): boolean {
  return phase !== "completed" && phase !== "failed";
}

function marketInstallPath(pluginDirectory: string, packageName: string): string {
  return path.join(
    pluginDirectory,
    `market-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`,
  );
}

async function readInstalledMarketVersion(directory: string, packageName: string): Promise<string | undefined> {
  try {
    const [manifestText, markerText] = await Promise.all([
      readFile(path.join(directory, "package.json"), "utf8"),
      readFile(path.join(directory, ".regenic-market-install.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { name?: unknown; version?: unknown };
    const marker = JSON.parse(markerText) as { package_name?: unknown; version?: unknown };
    if (
      manifest.name === packageName &&
      marker.package_name === packageName &&
      manifest.version === marker.version &&
      typeof manifest.version === "string"
    ) return manifest.version;
  } catch {
    return undefined;
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function fetchPackageVersion(
  name: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<NpmPackageVersion> {
  const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, `${REGISTRY_ORIGIN}/`);
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm package metadata returned HTTP ${response.status}`);
  const value = await readJsonLimited(response, MAX_PACKUMENT_BYTES);
  if (!isRecord(value)) throw new Error("npm package metadata is invalid");
  return value as NpmPackageVersion;
}

async function fetchBytes(
  url: URL,
  fetchImpl: typeof fetch,
  maximumBytes: number,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`npm package download returned HTTP ${response.status}`);
  return readBytesLimited(response, maximumBytes);
}

function safeTarballUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("npm package has no tarball URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== REGISTRY_ORIGIN ||
    url.username ||
    url.password
  ) {
    throw new Error("npm returned a tarball URL outside the public registry");
  }
  return url;
}

async function extractPackage(archivePath: string, destination: string): Promise<void> {
  let invalidEntry = false;
  let entryCount = 0;
  let extractedBytes = 0;
  await extractTar({
    file: archivePath,
    cwd: destination,
    strip: 1,
    preservePaths: false,
    filter: (entryPath, entry) => {
      entryCount += 1;
      extractedBytes += entry.size ?? 0;
      const parts = entryPath.split("/");
      const safePath = parts[0] === "package" &&
        parts.every((part) => part !== "." && part !== ".." && !part.includes("\\"));
      const safeType = "type" in entry &&
        (entry.type === "File" || entry.type === "Directory");
      if (
        !safePath ||
        !safeType ||
        entryCount > MAX_ARCHIVE_ENTRIES ||
        extractedBytes > MAX_EXTRACTED_BYTES
      ) {
        invalidEntry = true;
        return false;
      }
      return true;
    },
  });
  if (invalidEntry) {
    throw new Error("npm package archive contains unsafe or oversized entries");
  }
}

function assertPackageManifest(
  manifest: NpmPackageVersion,
  name: string,
  version: string,
  release: ConnectorMarketRelease,
): void {
  const drivers = manifest.regenic?.contributes?.drivers;
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    manifest.regenic?.plugin !== true ||
    manifest.regenic.engines?.regenic !== release.engines_regenic ||
    (manifest.regenic.contributes?.executors?.length ?? 0) > 0 ||
    !Array.isArray(drivers) ||
    drivers.length === 0 ||
    drivers.some((driver) => typeof driver !== "string" || !driver.trim()) ||
    [...new Set(drivers)].sort().join("\n") !== release.driver_exports.join("\n")
  ) {
    throw new Error("Installed package manifest does not match its market release");
  }
}

function validateDependencySpecs(dependencies: Record<string, string> | undefined): void {
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    if (
      !PACKAGE_NAME.test(name) ||
      typeof spec !== "string" ||
      !spec.trim() ||
      !/^[0-9A-Za-z.*^~<>=|+\- ]+$/u.test(spec)
    ) {
      throw new Error(`Unsupported dependency spec for ${name}`);
    }
  }
}

async function installDependencies(directory: string): Promise<void> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      command,
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--registry=${REGISTRY_ORIGIN}/`,
      ],
      {
        cwd: directory,
        shell: process.platform === "win32",
        env: { ...process.env, npm_config_ignore_scripts: "true" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm dependency installation failed (${code}): ${stderr}`));
    });
  });
}

async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBytesLimited(response, maxBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readBytesLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Response exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function validIntegrity(value: string | undefined): value is string {
  if (!value || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === encoded;
}

function containsIntegrity(value: string | undefined, expected: string): boolean {
  return typeof value === "string" &&
    value.split(/\s+/u).some((token) => token === expected && validIntegrity(token));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await readFile(path.join(value, "package.json"), { flag: "r" });
    return true;
  } catch {
    return false;
  }
}
