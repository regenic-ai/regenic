import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DshCliRun } from "./dsh-cli-client";

export interface DshRunLog {
  list(): Promise<DshCliRun[]>;
  append(run: DshCliRun): Promise<void>;
}

export class MemoryDshRunLog implements DshRunLog {
  constructor(private readonly runs: DshCliRun[] = []) {}

  async list(): Promise<DshCliRun[]> {
    return [...this.runs].sort((left, right) => left.seq - right.seq);
  }

  async append(run: DshCliRun): Promise<void> {
    this.runs.push(run);
  }
}

export class FileDshRunLog implements DshRunLog {
  constructor(private readonly path: string) {}

  async list(): Promise<DshCliRun[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    return text
      .split(/\r?\n/)
      .flatMap((line) => {
        if (line.trim().length === 0) {
          return [];
        }
        const parsed = JSON.parse(line) as DshCliRun;
        return [parsed];
      })
      .sort((left, right) => left.seq - right.seq);
  }

  async append(run: DshCliRun): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(run)}\n`, "utf8");
  }
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
