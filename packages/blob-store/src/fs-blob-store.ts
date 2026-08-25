import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectAvailableBlobs,
  putUniqueBlobs,
  type BlobObject,
  type BlobStore,
} from "@regenic/domain";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class BlobCorruptionError extends Error {
  constructor(hash: string) {
    super(`Stored Blob does not match its content hash: ${hash}`);
    this.name = "BlobCorruptionError";
  }
}

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(
    hash: string,
    bytes: Uint8Array,
    _mediaType: string,
  ): Promise<void> {
    this.assertHash(hash);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== hash) {
      throw new Error(`Blob hash mismatch: expected ${hash}, received ${actualHash}`);
    }

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

  async putMany(items: readonly BlobObject[]): Promise<void> {
    await putUniqueBlobs(
      (hash, bytes, mediaType) => this.put(hash, bytes, mediaType),
      items,
    );
  }

  async get(hash: string): Promise<Uint8Array> {
    this.assertHash(hash);
    const bytes = new Uint8Array(await readFile(this.pathFor(hash)));
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
    await rm(this.pathFor(hash), { force: true });
  }

  async exists(hash: string): Promise<boolean> {
    this.assertHash(hash);
    try {
      const entry = await stat(this.pathFor(hash));
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

  private assertHash(hash: string): void {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Blob hash must be a lowercase SHA-256 digest");
    }
  }
}