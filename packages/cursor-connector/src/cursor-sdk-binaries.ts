import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";

const requireFromHere = createRequire(__filename);

/**
 * `@cursor/sdk` looks for `rg` next to the Node/Electron binary, then on PATH.
 * pnpm keeps `@cursor/sdk-<platform>` beside `@cursor/sdk` in the virtual store,
 * which that walk never reaches. The desktop sidecar then logs
 * "Ripgrep path not configured" and local send/poll cannot see the workspace.
 */
export function resolveCursorRipgrepPath(): string | undefined {
  const fromEnv = usablePath(process.env.CURSOR_RIPGREP_PATH);
  if (fromEnv) {
    return fromEnv;
  }
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  return existingPlatformPath(join("bin", binary));
}

export function resolveCursorTreeSitterVendorDir(): string | undefined {
  const fromEnv = usablePath(process.env.CURSOR_TREE_SITTER_VENDOR_DIR);
  if (fromEnv) {
    return fromEnv;
  }
  return existingPlatformPath("vendor");
}

export function ensureCursorSdkPlatformBinaries(): void {
  const ripgrep = resolveCursorRipgrepPath();
  if (ripgrep) {
    process.env.CURSOR_RIPGREP_PATH = ripgrep;
  }
  const vendor = resolveCursorTreeSitterVendorDir();
  if (vendor) {
    process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
  }
}

function existingPlatformPath(relative: string): string | undefined {
  const root = platformPackageRoot();
  if (!root) {
    return undefined;
  }
  const candidate = join(root, relative);
  return existsSync(candidate) ? candidate : undefined;
}

function platformPackageRoot(): string | undefined {
  const sdkRoot = cursorSdkPackageRoot();
  if (!sdkRoot) {
    return undefined;
  }
  const root = join(dirname(sdkRoot), `sdk-${process.platform}-${process.arch}`);
  return existsSync(join(root, "package.json")) ? root : undefined;
}

function cursorSdkPackageRoot(): string | undefined {
  try {
    let dir = dirname(requireFromHere.resolve("@cursor/sdk"));
    for (;;) {
      if (basename(dir) === "sdk" && basename(dirname(dir)) === "@cursor") {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function usablePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed) || !existsSync(trimmed)) {
    return undefined;
  }
  return trimmed;
}
