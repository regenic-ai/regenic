# Connector marketplace: npm publishing and index

This document defines the npm publishing and static index workflow, plus connector discovery, installation, and registration in Regenic.

- **简体中文:** [../zh/CONNECTOR_MARKETPLACE.md](../zh/CONNECTOR_MARKETPLACE.md)
- **Related:** [Connector catalog](CONNECTOR_CATALOG.md) · [Build a connector](CONNECTOR.md)

## Publish a connector package

Publish connectors as npm packages. Use standard npm metadata and declare Regenic plugin registration in `package.json`:

```json
{
  "name": "@your-scope/regenic-connector-example",
  "version": "1.0.0",
  "description": "Connects Example Chat to Regenic",
  "keywords": ["regenic-connector", "example-chat"],
  "homepage": "https://github.com/your-scope/regenic-connector-example",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-scope/regenic-connector-example"
  },
  "regenic": {
    "plugin": true,
    "id": "@your-scope/regenic-connector-example",
    "displayName": "Example Chat",
    "engines": { "regenic": "1.0" },
    "contributes": { "drivers": ["exampleChatDriver"] }
  }
}
```

`contributes.drivers` must name driver exports present in the package entry point. Market packages may not contribute executors. `engines.regenic` declares the connector protocol version. The current runtime accepts only an exact match (currently `1.0`); it does not yet parse SemVer ranges. The market labels compatibility using this same rule. The generator includes only package versions declaring `regenic.plugin`, `engines.regenic`, and a non-empty `contributes.drivers`, with no executor contributions. Description, author, homepage, repository, and keywords come from that npm version's metadata; the title uses `regenic.displayName` when present.

Publish with SemVer. The market records each exact version, its npm publish time, and `dist.integrity`; it does not use a mutable `latest` tag or a package-supplied download URL. To publish a scoped package publicly:

```sh
npm publish --access public
```

## Generate a static market index

Market maintainers keep an approved package list in a controlled repository, one npm package name per line. Blank lines and lines beginning with `#` are ignored:

```text
# Approved public packages
@your-scope/regenic-connector-example
regenic-connector-another
```

Run from the Regenic repository root:

```sh
node scripts/connectors/generate-market-index.mjs \
  --input connectors.txt \
  --output site/connectors.json \
  --title "Regenic Connectors"
```

The generator reads metadata only from the fixed `https://registry.npmjs.org/` origin, rejects redirects, limits each response to 5 MiB, and uses a 15-second timeout. It never downloads tarballs, installs dependencies, or runs package code. Generation fails as a whole if any listed package is unavailable, has mismatched package identity, has no published version meeting the Regenic plugin contract, or lacks an exact version, publish time, or SHA-512 integrity.

The UTF-8 JSON index uses format `1`, with top-level `title` and `connectors`. Each connector includes its npm package name, display metadata, and releases. Each release includes exact SemVer, publish time, `engines.regenic`, driver export names, and npm SHA-512 `integrity`. Publish the generated file with the static site.

## Configure market discovery

The deployment operator configures one HTTPS JSON index URL with `REGENIC_CONNECTOR_MARKET_INDEX_URL`. The Engine page reads it through the local API and displays connectors, published versions, and compatibility ranges. When unset, the market section explains which setting is missing. Market entries are matched to the local plugin inventory by npm package name and show plugin load status, declared connector types, and local and market versions. Load status reflects the current process's plugin scan; it does not guarantee successful connector registration and is not a security audit or package provenance check. Discovery is read-only: browsing or refreshing never downloads, installs, or executes npm packages.

The API rejects non-HTTPS URLs and HTTP redirects, caps index responses at 2 MiB, uses an 8-second timeout, caches successful results for 60 seconds, and validates the index shape and fields. Third-party text is rendered as text, and links are limited to HTTP(S). The URL is deployment-controlled and must not accept ordinary user input. HTTPS and integrity metadata validate the source transport and published bytes; they do not prove package code is safe.

## Install and register a connector

After selecting a compatible release and confirming installation in Engine, the API immediately returns an installation job ID. Job phases are persisted in the plugin directory and restored after a page refresh. If the API restarts during an install, the next status request marks the job interrupted; it cannot resume the npm process. The status distinguishes an interrupted install from a package already placed in its final directory, but the latter still requires checking plugin registration before retrying.

The API rereads the configured index and accepts only its exact package name and version. It then verifies the name, version, and integrity metadata against the public npm registry, downloads the tarball, and checks its SHA-512 against the index. Extraction permits only regular files and directories and rejects traversal paths, links, oversized archives, and a plugin manifest that differs from the indexed release. The package is staged in a hidden directory under the plugin directory and moved atomically into place only after verification, so the loader does not see a partial install. The market list is paginated, and historical releases are rendered only when expanded; the selected compatible install version is shown separately from the latest published version.

If the package declares runtime dependencies, the installer invokes the `npm` CLI on `PATH`, fixes the registry to the public npm registry, and installs production dependencies with `--ignore-scripts`; npm lifecycle scripts are not run. Packages with dependencies cannot be installed when the npm CLI is unavailable. After the package is in place, the installer invokes the existing plugin reload and driver registration flow. A successful result means the declared drivers entered the current kernel process's registry; it does not create a channel connection instance. Configure that connector separately in Engine. If loading fails or a driver type is already owned elsewhere, the result clearly reports that installation succeeded but registration did not.

The confirmation names the exact version, integrity digest, and in-process execution risk. Connector code still runs inside the Regenic kernel process; disabling npm lifecycle scripts and verifying package integrity are not a code audit or a sandbox. The plugin inventory labels a market install based on a local marker written by the installer; this is a source record, not publisher verification or a security guarantee.

Updates are available for installed market packages when a compatible release is selected. The new package is downloaded and verified using the same exact-version, integrity, manifest, and dependency checks as a fresh install, then staged without replacing the live driver. Existing connector instances are preserved. Restart the API to apply the staged version; review whether the new release remains compatible with existing instance settings. The previous package version is retained locally for one-step rollback, and up to three prior versions are kept. Rollback stages that locally retained package and also requires an API restart.

To uninstall a market connector, first delete all connector instances whose types are contributed by that package. Engine reports how many remain and blocks the request while any exist. The API then writes a pending-removal marker and retires the driver's connector types from the current registry; restart the API to remove the package directory. Local and built-in connectors are not eligible for this operation. Install, update, rollback, and uninstall operations for a package cannot overlap.

## Trust and security boundary

- Inclusion is a market maintainer's curation decision, not a security audit or proof that an npm package is trusted.
- Descriptions, publisher names, homepages, repositories, and keywords come from third-party npm metadata and must be treated as untrusted display content.
- Exact versions and integrity hashes enable later verification that downloaded bytes match the index; they do not prove that the code is safe.
- External connectors still run in the Regenic kernel process. A static index does not change that runtime trust boundary.

## Current scope

The current implementation includes npm publishing conventions, the static index generator, read-only index retrieval, Engine discovery, user-confirmed exact-version installation and updates, durable operation status, restart-required version switching and rollback, package registration through the local plugin loader, and restart-required removal for market installs. Integrity checks do not imply a security audit or kernel sandbox.
