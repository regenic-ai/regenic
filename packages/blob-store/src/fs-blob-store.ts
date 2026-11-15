import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BlobGenerationConflictError,
  collectAvailableBlobs,
  putUniqueBlobs,
  type BlobObject,
  type BlobStoreEntry,
  type FencedBlobStore,
} from "@regenic/domain";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GENERATION_MARKER_PATTERN = /^(\d+)\.(reserved|ready|deleted)$/;
const GENERATION_OBJECT_PATTERN = /^(\d+)\.blob$/;
const GENERATION_TEMP_PATTERN = /^(\d+)\..+\.tmp$/;

type GenerationState = "reserved" | "ready" | "deleted";

interface GenerationMarker {
  generation: number;
  state: GenerationState;
}

export class BlobCorruptionError extends Error {
  constructor(hash: string) {
    super(`Stored Blob does not match its content hash: ${hash}`);
    this.name = "BlobCorruptionError";
  }
}

export class FsBlobStore implements FencedBlobStore {
  constructor(private readonly root: string) {}

  async put(
    hash: string,
    bytes: Uint8Array,
    _mediaType: string,
  ): Promise<void> {
    this.assertHash(hash);
    const generation = await this.latestGeneration(hash);
    if (generation) {
      throw new BlobGenerationConflictError(hash, 0, generation.generation);
    }
    this.assertBytesHash(hash, bytes);

    const target = this.pathFor(hash);
    if (await this.exists(hash)) {
      await this.get(hash);
      return;
    }

    await mkdir(join(this.root, hash.slice(0, 2), hash.slice(2, 4)), {
      recursive: true,
    });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });

    try {
      await rename(temporary, target);
    } catch (error) {
      if (!(await this.exists(hash))) {
        throw error;
      }
      await rm(temporary, { force: true });
    }
  }

  async putFenced(
    hash: string,
    bytes: Uint8Array,
    _mediaType: string,
    generation: number,
  ): Promise<void> {
    this.assertHash(hash);
    this.assertGeneration(generation);
    this.assertBytesHash(hash, bytes);

    const versions = this.versionsPathFor(hash);
    await mkdir(versions, { recursive: true });
    const current = await this.latestGeneration(hash);
    if (current && generation < current.generation) {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    if (current?.generation === generation && current.state === "deleted") {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    if (current?.generation === generation && current.state === "ready") {
      await this.get(hash);
      return;
    }

    await this.createMarker(hash, generation, "reserved");
    const afterReserve = await this.latestGeneration(hash);
    if (afterReserve && generation < afterReserve.generation) {
      throw new BlobGenerationConflictError(hash, generation, afterReserve.generation);
    }
    if (afterReserve?.generation === generation && afterReserve.state === "deleted") {
      throw new BlobGenerationConflictError(hash, generation, afterReserve.generation);
    }

    const target = this.versionPathFor(hash, generation);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    await this.createMarker(hash, generation, "ready");
    const latest = await this.latestGeneration(hash);
    if (latest && generation < latest.generation) {
      throw new BlobGenerationConflictError(hash, generation, latest.generation);
    }
    if (latest?.generation === generation && latest.state !== "ready") {
      throw new BlobGenerationConflictError(hash, generation, latest.generation);
    }
  }

  async putMany(items: readonly BlobObject[]): Promise<void> {
    await putUniqueBlobs(
      (hash, bytes, mediaType) => this.put(hash, bytes, mediaType),
      items,
    );
  }

  async *enumerate(): AsyncIterable<BlobStoreEntry> {
    const firstLevel = await this.readDirectory(this.root);
    for (const first of firstLevel
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const firstPath = join(this.root, first.name);
      const secondLevel = await this.readDirectory(firstPath);
      for (const second of secondLevel
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const secondPath = join(firstPath, second.name);
        const candidates = new Set<string>();
        for (const entry of await this.readDirectory(secondPath)) {
          const hash = entry.name.endsWith(".versions")
            ? entry.name.slice(0, -".versions".length)
            : entry.name;
          if (!SHA256_PATTERN.test(hash)
            || !hash.startsWith(`${first.name}${second.name}`)
            || !(entry.isFile() && entry.name === hash)
              && !(entry.isDirectory() && entry.name === `${hash}.versions`)) {
            continue;
          }
          candidates.add(hash);
        }
        for (const hash of [...candidates].sort()) {
          const generation = await this.latestGeneration(hash);
          const path = generation
            ? generation.state === "ready"
              ? this.versionPathFor(hash, generation.generation)
              : undefined
            : this.pathFor(hash);
          if (!path) continue;
          const size = await this.regularFileSize(path);
          if (size !== undefined) yield { hash, byte_size: size };
        }
      }
    }
  }

  async get(hash: string): Promise<Uint8Array> {
    this.assertHash(hash);
    const generation = await this.latestGeneration(hash);
    if (generation && generation.state !== "ready") {
      throw new Error(`Blob is not available at generation ${generation.generation}: ${hash}`);
    }
    const target = generation
      ? this.versionPathFor(hash, generation.generation)
      : this.pathFor(hash);
    const bytes = new Uint8Array(await readFile(target));
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== hash) {
      throw new BlobCorruptionError(hash);
    }
    return bytes;
  }

  async getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    return collectAvailableBlobs((hash) => this.get(hash), hashes);
  }

  async delete(hash: string): Promise<void> {
    this.assertHash(hash);
    const generation = await this.latestGeneration(hash);
    if (generation) {
      throw new BlobGenerationConflictError(hash, 0, generation.generation);
    }
    await rm(this.pathFor(hash), { force: true });
  }

  async deleteFenced(hash: string, generation: number): Promise<void> {
    this.assertHash(hash);
    this.assertGeneration(generation);
    await mkdir(this.versionsPathFor(hash), { recursive: true });

    const current = await this.latestGeneration(hash);
    if (current && generation < current.generation) {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    if (current?.generation === generation && current.state !== "deleted") {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    await this.createMarker(hash, generation, "deleted");

    const latest = await this.latestGeneration(hash);
    if (latest && generation < latest.generation) {
      throw new BlobGenerationConflictError(hash, generation, latest.generation);
    }
    await rm(this.pathFor(hash), { force: true });
    const versions = this.versionsPathFor(hash);
    let entries: string[];
    try {
      entries = await readdir(versions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.flatMap((entry) => {
      const object = entry.match(GENERATION_OBJECT_PATTERN);
      const temporary = entry.match(GENERATION_TEMP_PATTERN);
      const entryGeneration = Number(object?.[1] ?? temporary?.[1]);
      return (object || temporary) && entryGeneration <= generation
        ? [rm(join(versions, entry), { force: true })]
        : [];
    }));
  }

  async exists(hash: string): Promise<boolean> {
    this.assertHash(hash);
    const generation = await this.latestGeneration(hash);
    if (generation) {
      if (generation.state !== "ready") return false;
      return this.isFile(this.versionPathFor(hash, generation.generation));
    }
    return this.isFile(this.pathFor(hash));
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      const entry = await stat(path);
      return entry.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  private versionsPathFor(hash: string): string {
    return `${this.pathFor(hash)}.versions`;
  }

  private versionPathFor(hash: string, generation: number): string {
    return join(this.versionsPathFor(hash), `${generation}.blob`);
  }

  private markerPathFor(
    hash: string,
    generation: number,
    state: GenerationState,
  ): string {
    return join(this.versionsPathFor(hash), `${generation}.${state}`);
  }

  private async createMarker(
    hash: string,
    generation: number,
    state: GenerationState,
  ): Promise<void> {
    try {
      await writeFile(this.markerPathFor(hash, generation, state), new Uint8Array(), {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async readDirectory(path: string): Promise<Dirent[]> {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async regularFileSize(path: string): Promise<number | undefined> {
    try {
      const entry = await lstat(path);
      return entry.isFile() ? entry.size : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async latestGeneration(hash: string): Promise<GenerationMarker | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.versionsPathFor(hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const states = new Map<number, Set<GenerationState>>();
    for (const entry of entries) {
      const match = entry.match(GENERATION_MARKER_PATTERN);
      if (!match) continue;
      const generation = Number(match[1]);
      if (!Number.isSafeInteger(generation)) {
        throw new Error(`Invalid Blob generation marker: ${entry}`);
      }
      const state = match[2] as GenerationState;
      const generationStates = states.get(generation) ?? new Set<GenerationState>();
      generationStates.add(state);
      states.set(generation, generationStates);
    }
    const latest = Math.max(...states.keys());
    if (!Number.isFinite(latest)) return undefined;
    const generationStates = states.get(latest)!;
    const state: GenerationState = generationStates.has("deleted")
      ? "deleted"
      : generationStates.has("ready")
        ? "ready"
        : "reserved";
    return { generation: latest, state };
  }

  private assertGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Blob generation must be a positive safe integer");
    }
  }

  private assertBytesHash(hash: string, bytes: Uint8Array): void {
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== hash) {
      throw new Error(`Blob hash mismatch: expected ${hash}, received ${actualHash}`);
    }
  }

  private assertHash(hash: string): void {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Blob hash must be a lowercase SHA-256 digest");
    }
  }
}