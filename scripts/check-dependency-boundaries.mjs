import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];

const coreApps = ["apps/api/src", "apps/worker/src", "apps/desktop/src"];
for (const relative of coreApps) {
  scan(relative, (file, source) => {
    for (const spec of importedSpecs(source)) {
      if (
        /^@regenic\/.+-connector$/.test(spec) ||
        spec === "@regenic/whatsapp-personal"
      ) {
        violations.push(
          `${relativePath(file)}: Core application imports concrete connector ${spec}`,
        );
      }
    }
  });
}

for (const entry of readdirSync(path.join(root, "packages"), {
  withFileTypes: true,
})) {
  if (
    !entry.isDirectory() ||
    (!entry.name.endsWith("-connector") &&
      entry.name !== "whatsapp-personal")
  ) {
    continue;
  }
  const relative = path.join("packages", entry.name, "src");
  scan(relative, (file, source) => {
    for (const spec of importedSpecs(source)) {
      if (
        spec === "@regenic/authority-store" ||
        spec === "@regenic/blob-store" ||
        spec.startsWith("@regenic/authority-store/") ||
        spec.startsWith("@regenic/blob-store/") ||
        spec === "@regenic/api"
      ) {
        violations.push(
          `${relativePath(file)}: Connector imports Core persistence ${spec}`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Dependency boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log("Dependency boundaries: ok");
}

function scan(relative, visit) {
  const absolute = path.join(root, relative);
  if (!exists(absolute)) {
    return;
  }
  walk(absolute, (file) => {
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(file)) {
      visit(file, readFileSync(file, "utf8"));
    }
  });
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}

function importedSpecs(source) {
  const specs = [];
  const pattern =
    /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    specs.push(match[1]);
  }
  return specs;
}

function exists(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function relativePath(file) {
  return path.relative(root, file);
}
