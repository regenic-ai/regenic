#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY_URL = "https://registry.npmjs.org/";
const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
    + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
    + `(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export function parsePackageList(text) {
  const packages = [];
  const seen = new Set();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const name = raw.trim();
    if (!name || name.startsWith("#")) continue;
    if (!NPM_PACKAGE_NAME.test(name)) {
      throw new Error(`Invalid npm package name on line ${index + 1}: ${name}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      packages.push(name);
    }
  }
  if (packages.length === 0) {
    throw new Error("The package list contains no npm package names");
  }
  return packages;
}

export async function generateMarketIndex({
  packages,
  title,
  fetchImpl = fetch,
}) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Market title is required");
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("At least one npm package is required");
  }
  if (packages.some((name) => typeof name !== "string" || !NPM_PACKAGE_NAME.test(name))) {
    throw new Error("Package names must be valid npm package identifiers");
  }

  const connectors = [];
  for (const name of new Set(packages)) {
    const response = await fetchImpl(
      new URL(encodeURIComponent(name), REGISTRY_URL),
      {
        // The abbreviated install-v1 representation intentionally omits
        // package-defined metadata (including `regenic`) and publish times.
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Could not read npm package ${name}: HTTP ${response.status}`);
    }
    const packument = await readPackument(response);
    if (!isRecord(packument) || packument.name !== name || !isRecord(packument.versions)) {
      throw new Error(`Invalid npm metadata for ${name}`);
    }

    const releases = Object.entries(packument.versions)
      .filter(([, manifest]) => isMarketConnector(manifest))
      .map(([version, manifest]) => {
        const publishedAt = packument.time?.[version];
        const integrity = sha512Integrity(manifest.dist?.integrity);
        if (manifest.name !== name || manifest.version !== version) {
          throw new Error(`npm metadata for ${name}@${version} has a mismatched package identity`);
        }
        if (!SEMVER.test(version)) {
          throw new Error(`${name}@${version} is not an exact SemVer version`);
        }
        if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) {
          throw new Error(`${name}@${version} has no valid npm publish time`);
        }
        if (integrity === undefined) {
          throw new Error(`${name}@${version} has no valid SHA-512 npm integrity`);
        }
        return {
          version,
          published_at: new Date(publishedAt).toISOString(),
          engines_regenic: manifest.regenic.engines.regenic.trim(),
          integrity,
          driver_exports: [...manifest.regenic.contributes.drivers].sort(),
          executor_exports: Array.isArray(manifest.regenic.contributes.executors)
            ? [...manifest.regenic.contributes.executors].sort()
            : [],
        };
      })
      .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at)
        || left.version.localeCompare(right.version));

    if (releases.length === 0) {
      throw new Error(`${name} has no published Regenic connector releases`);
    }

    const latest = packument.versions[releases[0].version];
    const displayName = typeof latest.regenic.displayName === "string"
      ? latest.regenic.displayName.trim()
      : "";
    const description = typeof latest.description === "string" ? latest.description.trim() : "";
    connectors.push({
      name,
      title: displayName || name,
      description,
      ...(authorName(latest.author) ? { author: authorName(latest.author) } : {}),
      ...(safeWebUrl(latest.homepage) ? { homepage: safeWebUrl(latest.homepage) } : {}),
      ...(repositoryUrl(latest.repository) ? { repository: repositoryUrl(latest.repository) } : {}),
      keywords: Array.isArray(latest.keywords)
        ? [...new Set(latest.keywords.filter((keyword) => typeof keyword === "string" && keyword.trim()))].sort()
        : [],
      versions: releases,
    });
  }

  return { format: 1, title: title.trim(), connectors };
}

export async function writeMarketIndex(outputPath, index) {
  const destination = resolve(outputPath);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isMarketConnector(value) {
  return isRecord(value)
    && isRecord(value.regenic)
    && value.regenic.plugin === true
    && typeof value.regenic.engines?.regenic === "string"
    && value.regenic.engines.regenic.trim().length > 0
    && Array.isArray(value.regenic.contributes?.drivers)
    && value.regenic.contributes.drivers.length > 0
    && value.regenic.contributes.drivers.every((item) => typeof item === "string" && item.trim())
    && (!Array.isArray(value.regenic.contributes?.executors)
      || value.regenic.contributes.executors.every(
        (item) => typeof item === "string" && item.trim(),
      ));
}

function sha512Integrity(value) {
  if (typeof value !== "string") return undefined;
  for (const token of value.trim().split(/\s+/u)) {
    if (!SHA512_INTEGRITY.test(token)) continue;
    const encoded = token.slice("sha512-".length);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 64 && bytes.toString("base64") === encoded) return token;
  }
  return undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readPackument(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKUMENT_BYTES) {
    throw new Error("npm package metadata exceeds the 5 MiB limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("npm returned an empty package metadata response");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PACKUMENT_BYTES) {
      await reader.cancel();
      throw new Error("npm package metadata exceeds the 5 MiB limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("npm returned invalid UTF-8 JSON package metadata", { cause: error });
  }
}

function authorName(author) {
  const value = typeof author === "string"
    ? author.trim()
    : isRecord(author) && typeof author.name === "string" ? author.name.trim() : "";
  return value || undefined;
}

function safeWebUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function repositoryUrl(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^git\+|\.git$/gu, "");
  if (normalized.startsWith("github:")) return safeWebUrl(`https://github.com/${normalized.slice(7)}`);
  return safeWebUrl(normalized);
}

function argumentsFrom(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Usage: generate-market-index.mjs --input <file> --output <file> --title <title>");
    }
    if (options.has(key)) throw new Error(`Duplicate option: ${key}`);
    options.set(key, value);
  }
  for (const key of options.keys()) {
    if (!["--input", "--output", "--title"].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
  }
  const input = options.get("--input");
  const output = options.get("--output");
  const title = options.get("--title");
  if (!input || !output || !title) {
    throw new Error("Usage: generate-market-index.mjs --input <file> --output <file> --title <title>");
  }
  return { input, output, title };
}

async function main(argv) {
  const options = argumentsFrom(argv);
  const packages = parsePackageList(await readFile(options.input, "utf8"));
  const index = await generateMarketIndex({ packages, title: options.title });
  await writeMarketIndex(options.output, index);
  console.log(`Wrote ${index.connectors.length} connector(s) to ${resolve(options.output)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
