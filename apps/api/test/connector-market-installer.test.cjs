const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const tar = require("tar");
const { describe, it } = require("node:test");
const { ChannelDriverRegistry, LocalExecutorPluginRegistry } = require("@regenic/domain");
const { ConnectorMarketInstaller } = require("../dist/connector-market-installer");
const {
  completePendingMarketVersionChanges,
  createChannelDriverRegistry,
  extraPlugins,
} = require("../dist/channel-plugins");
const { PersonalPluginService } = require("../dist/personal-plugin.service");

const packageName = `regenic-connector-market-test-${process.pid}`;
const version = "1.0.0";
const drivers = ["marketTestDriver"];
const installDirectory = `market-${createHash("sha256").update(packageName).digest("hex").slice(0, 24)}`;
const integrityBytes = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function setupPackage(root, {
  name = packageName,
  contributes = drivers,
  packageVersion = version,
} = {}) {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      version: packageVersion,
      main: "index.cjs",
      scripts: { postinstall: "touch install-script-ran" },
      regenic: {
        plugin: true,
        engines: { regenic: "1.0" },
        contributes: { drivers: contributes },
      },
    }),
  );
  await writeFile(
    join(packageRoot, "index.cjs"),
    "exports.marketTestDriver = { connector_type: 'market-test', source: 'market-test', install() {} };\n",
  );
  const archivePath = join(root, "connector.tgz");
  await tar.c({ cwd: root, gzip: true, file: archivePath }, ["package"]);
  const archive = await readFile(archivePath);
  return { archive, integrity: integrityBytes(archive) };
}

function registryFetch({
  archive,
  integrity,
  name = packageName,
  packageVersion = version,
}) {
  return async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === "registry.npmjs.org" && requestUrl.pathname.endsWith(`/${packageVersion}`)) {
      return Response.json({
        name,
        version: packageVersion,
        dist: {
          integrity: `${integrity} sha1-ignored`,
          tarball: `https://registry.npmjs.org/${name}/-/${name}-${packageVersion}.tgz`,
        },
      });
    }
    if (requestUrl.pathname.endsWith(".tgz")) {
      return new Response(archive);
    }
    throw new Error(`Unexpected registry request: ${requestUrl}`);
  };
}

function runtimeService(installations = []) {
  return {
    requireHost: () => ({
      get: () => ({ listInstallations: async () => installations }),
    }),
    orgId: () => "test-org",
  };
}

describe("ConnectorMarketInstaller", () => {
  it("requires explicit confirmation before contacting the market", async () => {
    let fetched = false;
    const installer = new ConnectorMarketInstaller(
      { getMarket: async () => { fetched = true; throw new Error("should not run"); } },
      { reload() {}, list() { return []; } },
      runtimeService(),
    );
    await assert.rejects(
      installer.install({ package_name: packageName, version, confirmed: "true" }),
      (error) => error.getStatus() === 400,
    );
    assert.equal(fetched, false);
  });

  it("verifies the npm tarball, stages it, and reloads the connector registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-install-"));
    try {
      const { archive, integrity } = await setupPackage(root);
      const pluginDirectory = join(root, "plugins");
      const release = {
        version,
        engines_regenic: "1.0",
        compatible: true,
        integrity,
        driver_exports: drivers,
      };
      const plugins = new PersonalPluginService(
        new ChannelDriverRegistry(),
        new LocalExecutorPluginRegistry(),
      );
      const installer = new ConnectorMarketInstaller(
        {
          getMarket: async () => ({
            configured: true,
            title: "Test market",
            connectors: [{ name: packageName, versions: [release] }],
          }),
        },
        plugins,
        runtimeService(),
      );
      const result = await installer.install(
        { package_name: packageName, version, confirmed: true },
        registryFetch({ archive, integrity }),
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );

      assert.equal(result.installed, true);
      assert.equal(result.registered, true);
      assert.deepEqual(result.driver_types, ["market-test"]);
      assert.equal(plugins.list().find((item) => item.package_name === packageName)?.status, "loaded");
      const visibleDirs = await readdir(pluginDirectory);
      assert.equal(visibleDirs.some((entry) => entry.startsWith(".regenic-market-")), false);
      assert.equal(
        await readFile(join(pluginDirectory, installDirectory, "package.json"), "utf8")
          .then((text) => JSON.parse(text).version),
        version,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks an asynchronous installation through completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-job-"));
    try {
      const name = `${packageName}-job`;
      const { archive, integrity } = await setupPackage(root, { name });
      const pluginDirectory = join(root, "plugins");
      const plugins = new PersonalPluginService(
        new ChannelDriverRegistry(),
        new LocalExecutorPluginRegistry(),
      );
      const installer = new ConnectorMarketInstaller(
        {
          getMarket: async () => ({
            configured: true,
            title: "Test market",
            connectors: [{
              name,
              versions: [{
                version,
                engines_regenic: "1.0",
                compatible: true,
                integrity,
                driver_exports: drivers,
              }],
            }],
          }),
        },
        plugins,
        runtimeService(),
      );
      const job = await installer.startInstall(
        { package_name: name, version, confirmed: true },
        registryFetch({ archive, integrity, name }),
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );
      let status = await installer.getInstall(job.id);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && status.phase !== "completed" &&
        status.phase !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await installer.getInstall(job.id);
      }

      assert.equal(status.phase, "completed");
      assert.equal(status.installed, true);
      assert.equal(status.result?.registered, true);
      assert.equal(status.package_name, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not stage a tarball when its digest differs from the market index", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-integrity-"));
    try {
      const name = `${packageName}-integrity`;
      const { archive, integrity } = await setupPackage(root, { name });
      const pluginDirectory = join(root, "plugins");
      const wrongIntegrity = `sha512-${Buffer.alloc(64, 5).toString("base64")}`;
      const installer = new ConnectorMarketInstaller(
        {
          getMarket: async () => ({
            configured: true,
            title: "Test market",
            connectors: [{
              name,
              versions: [{
                version,
                engines_regenic: "1.0",
                compatible: true,
                integrity: wrongIntegrity,
                driver_exports: drivers,
              }],
            }],
          }),
        },
        { reload() {}, list() { return []; } },
        runtimeService(),
      );
      await assert.rejects(
        installer.install(
          { package_name: name, version, confirmed: true },
          registryFetch({ archive, integrity, name }),
          { REGENIC_PLUGIN_DIR: pluginDirectory },
        ),
        (error) => error.getStatus() === 503,
      );
      assert.deepEqual(await readdir(pluginDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not install a package whose manifest differs from the indexed release", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-manifest-"));
    try {
      const name = `${packageName}-manifest`;
      const { archive, integrity } = await setupPackage(root, {
        name,
        contributes: ["unexpectedDriver"],
      });
      const pluginDirectory = join(root, "plugins");
      const installer = new ConnectorMarketInstaller(
        {
          getMarket: async () => ({
            configured: true,
            title: "Test market",
            connectors: [{
              name,
              versions: [{
                version,
                engines_regenic: "1.0",
                compatible: true,
                integrity,
                driver_exports: drivers,
              }],
            }],
          }),
        },
        { reload() {}, list() { return []; } },
        runtimeService(),
      );
      await assert.rejects(
        installer.install(
          { package_name: name, version, confirmed: true },
          registryFetch({ archive, integrity, name }),
          { REGENIC_PLUGIN_DIR: pluginDirectory },
        ),
        (error) => error.getStatus() === 503,
      );
      assert.deepEqual(await readdir(pluginDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers interrupted installation jobs after an API restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-restart-"));
    try {
      const pluginDirectory = join(root, "plugins");
      await mkdir(pluginDirectory);
      const interrupted = {
        id: "interrupted-job",
        package_name: `${packageName}-interrupted`,
        version,
        phase: "downloading",
        installed: false,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await writeFile(
        join(pluginDirectory, ".connector-market-install-jobs.json"),
        JSON.stringify([interrupted]),
      );
      const installer = new ConnectorMarketInstaller(
        { getMarket: async () => ({ configured: true, title: "Test", connectors: [] }) },
        { reload() {}, list() { return []; } },
        runtimeService(),
      );
      const recovered = await installer.getInstall(
        interrupted.id,
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );
      assert.equal(recovered.phase, "failed");
      assert.match(recovered.error, /API restarted before installation completed/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages updates and rollbacks for API restart without replacing live drivers", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-update-"));
    try {
      const name = `${packageName}-update`;
      const nextVersion = "1.1.0";
      await mkdir(join(root, "current"), { recursive: true });
      await mkdir(join(root, "next"), { recursive: true });
      const currentPackage = await setupPackage(join(root, "current"), { name });
      const nextPackage = await setupPackage(join(root, "next"), {
        name,
        packageVersion: nextVersion,
      });
      const pluginDirectory = join(root, "plugins");
      const driverRegistry = new ChannelDriverRegistry();
      const plugins = new PersonalPluginService(
        driverRegistry,
        new LocalExecutorPluginRegistry(),
      );
      const releases = [
        {
          version: nextVersion,
          engines_regenic: "1.0",
          compatible: true,
          integrity: nextPackage.integrity,
          driver_exports: drivers,
        },
        {
          version,
          engines_regenic: "1.0",
          compatible: true,
          integrity: currentPackage.integrity,
          driver_exports: drivers,
        },
      ];
      const market = {
        getMarket: async () => ({
          configured: true,
          title: "Test market",
          connectors: [{ name, versions: releases }],
        }),
      };
      const runtime = runtimeService([{ connector_type: "market-test" }]);
      const installer = new ConnectorMarketInstaller(market, plugins, runtime);
      await installer.install(
        { package_name: name, version, confirmed: true },
        registryFetch({ archive: currentPackage.archive, integrity: currentPackage.integrity, name }),
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );
      const job = await installer.startUpdate(
        { package_name: name, version: nextVersion, confirmed: true },
        registryFetch({
          archive: nextPackage.archive,
          integrity: nextPackage.integrity,
          name,
          packageVersion: nextVersion,
        }),
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );
      let status = await installer.getInstall(job.id, { REGENIC_PLUGIN_DIR: pluginDirectory });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && status.phase !== "completed" &&
        status.phase !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await installer.getInstall(job.id, { REGENIC_PLUGIN_DIR: pluginDirectory });
      }

      assert.equal(status.phase, "completed");
      assert.equal(status.result?.pending_restart, true);
      assert.equal(driverRegistry.has("market-test"), true);
      const currentDirectory = join(
        pluginDirectory,
        `market-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
      );
      assert.equal(JSON.parse(await readFile(join(currentDirectory, "package.json"), "utf8")).version, version);

      completePendingMarketVersionChanges({ REGENIC_PLUGIN_DIR: pluginDirectory });
      assert.equal(JSON.parse(await readFile(join(currentDirectory, "package.json"), "utf8")).version, nextVersion);
      delete require.cache[require.resolve(join(currentDirectory, "package.json"))];
      extraPlugins({ REGENIC_PLUGIN_DIR: pluginDirectory });
      assert.equal(plugins.list().find((item) => item.package_name === name)?.version, nextVersion);
      assert.equal(plugins.marketVersionHistory(name, { REGENIC_PLUGIN_DIR: pluginDirectory })[0]?.version, version);
      const rollback = await installer.rollback(name, true, { REGENIC_PLUGIN_DIR: pluginDirectory });
      assert.equal(rollback.version, version);
      assert.equal(rollback.pending_restart, true);
      completePendingMarketVersionChanges({ REGENIC_PLUGIN_DIR: pluginDirectory });
      assert.equal(JSON.parse(await readFile(join(currentDirectory, "package.json"), "utf8")).version, version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires connector instances to be removed before marking a market package for removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-uninstall-"));
    try {
      const name = `${packageName}-uninstall`;
      const { archive, integrity } = await setupPackage(root, { name });
      const pluginDirectory = join(root, "plugins");
      const registry = new ChannelDriverRegistry();
      const plugins = new PersonalPluginService(
        registry,
        new LocalExecutorPluginRegistry(),
      );
      const market = {
        getMarket: async () => ({
          configured: true,
          title: "Test market",
          connectors: [{
            name,
            versions: [{
              version,
              engines_regenic: "1.0",
              compatible: true,
              integrity,
              driver_exports: drivers,
            }],
          }],
        }),
      };
      const installer = new ConnectorMarketInstaller(market, plugins, runtimeService([
        { connector_type: "market-test" },
      ]));
      await installer.install(
        { package_name: name, version, confirmed: true },
        registryFetch({ archive, integrity, name }),
        { REGENIC_PLUGIN_DIR: pluginDirectory },
      );

      await assert.rejects(
        installer.uninstall(name, { REGENIC_PLUGIN_DIR: pluginDirectory }),
        (error) => error.getStatus() === 409,
      );
      assert.equal(registry.has("market-test"), true);

      const removable = new ConnectorMarketInstaller(market, plugins, runtimeService());
      const result = await removable.uninstall(name, { REGENIC_PLUGIN_DIR: pluginDirectory });
      assert.equal(result.pending_restart, true);
      assert.equal(plugins.list().find((item) => item.package_name === name)?.status, "uninstall_pending");
      assert.equal(registry.has("market-test"), false);
      createChannelDriverRegistry({ REGENIC_PLUGIN_DIR: pluginDirectory });
      const marketDirectory = `market-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
      assert.equal((await readdir(pluginDirectory)).includes(marketDirectory), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
