import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export class DshApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DshApiError";
  }
}

export interface DshHistoryEvent {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
}

export interface DshHistoryPage {
  events: DshHistoryEvent[];
  hasMore: boolean;
}

export interface DshSpawnResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type DshSpawn = (input: {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
}) => Promise<DshSpawnResult>;

export interface DshCliRun {
  run_id: string;
  seq: number;
  task: string;
  stdout: string;
  started_at: string;
  finished_at: string;
}

export interface DshCliClientOptions {
  command?: string;
  profile?: string;
  workdir?: string;
  patch?: string;
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: DshSpawn;
  now?: () => string;
  createId?: () => string;
}

export class DshCliClient {
  private readonly command: string;
  private readonly profile: string;
  private readonly timeoutMs: number;
  private readonly spawn: DshSpawn;
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: DshCliClientOptions = {}) {
    this.command = resolveDshCommand(options.command);
    this.profile = options.profile?.trim() || "headless";
    this.timeoutMs = options.timeout_ms ?? 10 * 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("DSH timeout_ms must be a positive integer");
    }
    this.spawn = options.spawn ?? spawnDshProcess;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomId;
  }

  async run(task: string, seq: number): Promise<DshCliRun> {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      throw new DshApiError("DSH task must be non-empty");
    }
    const argv = [this.command, "--profile", this.profile];
    if (this.options.patch) {
      argv.push("--patch", this.options.patch);
    }
    argv.push(trimmed);
    const startedAt = this.now();
    const result = await this.spawn({
      command: argv,
      cwd: this.options.workdir,
      env: {
        ...this.options.env,
        DSH_PERMISSION_MODE:
          this.options.env?.DSH_PERMISSION_MODE ?? "danger-full-access",
      },
      timeout_ms: this.timeoutMs,
    });
    if (result.exit_code !== 0) {
      throw new DshApiError(
        result.stderr.trim() || `DSH CLI exited with code ${result.exit_code}`,
        "internal",
      );
    }
    return {
      run_id: this.createId(),
      seq,
      task: trimmed,
      stdout: result.stdout.trim(),
      started_at: startedAt,
      finished_at: this.now(),
    };
  }
}

export function resolveDshCommand(configured?: string): string {
  const command = configured?.trim() || "dsh";
  if (isAbsolute(command) && !existsSync(command)) {
    return "dsh";
  }
  return command;
}

export function runsToHistoryPage(runs: DshCliRun[]): DshHistoryPage {
  const events: DshHistoryEvent[] = [];
  for (const run of runs) {
    const started = Date.parse(run.started_at);
    const finished = Date.parse(run.finished_at);
    events.push({
      type: "user/message",
      seq: run.seq * 2,
      time: Number.isFinite(started) ? started : 0,
      data: {
        content: [{ type: "text", text: run.task }],
        source: { kind: "user" },
      },
    });
    if (run.stdout.length > 0) {
      events.push({
        type: "assistant/message",
        seq: run.seq * 2 + 1,
        time: Number.isFinite(finished) ? finished : 0,
        data: {
          message: { content: [{ type: "text", text: run.stdout }] },
        },
      });
    }
  }
  return { events, hasMore: false };
}

function randomId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function spawnDshProcess(input: {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
}): Promise<DshSpawnResult> {
  const [bin, ...args] = input.command;
  if (!bin) {
    throw new DshApiError("DSH command is missing");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new DshApiError(`DSH CLI timed out after ${input.timeout_ms}ms`));
    }, input.timeout_ms);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new DshApiError(
          `Unable to start DeepSeek Harness (is dsh on PATH?): ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: code ?? 1,
      });
    });
  });
}
