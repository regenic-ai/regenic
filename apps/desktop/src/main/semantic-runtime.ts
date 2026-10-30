import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { SemanticRuntimeView, SemanticStage } from "../shared/semantic-runtime.ts";

const REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b";

interface RuntimeOptions {
  root: string;
  assets: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch?: typeof fetch;
  startupMs?: number;
}

export class SemanticRuntime {
  private child: ChildProcess | undefined;
  private command: ChildProcess | undefined;
  private stage: SemanticStage = "not_installed";
  private error: string | undefined;
  private healthy = false;
  private origin: string | undefined;
  private working = false;
  private closing = false;
  private readonly launch: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  private readonly request: typeof fetch;
  private readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.launch = options.spawn ?? spawn;
    this.request = options.fetch ?? fetch;
  }

  private python(): string {
    return process.platform === "win32"
      ? join(this.options.root, "venv", "Scripts", "python.exe")
      : join(this.options.root, "venv", "bin", "python");
  }

  private fingerprint(): string {
    return createHash("sha256").update(readFileSync(join(this.options.assets, "requirements.txt")))
      .update(readFileSync(join(this.options.assets, "serve.py"))).digest("hex");
  }

  private installed(): boolean {
    const marker = join(this.options.root, "installed.json");
    if (!existsSync(marker) || !existsSync(this.python())) return false;
    try {
      const value: unknown = JSON.parse(readFileSync(marker, "utf8"));
      if (!value || typeof value !== "object" || !("fingerprint" in value) || typeof value.fingerprint !== "string") {
        console.error("[semantic] invalid installation marker");
        return false;
      }
      return value.fingerprint === this.fingerprint();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.error("[semantic] invalid installation marker");
      return false;
    }
  }

  view(enabled: boolean, canManage: boolean): SemanticRuntimeView {
    const installed = this.installed();
    return {
      stage: this.stage === "not_installed" && installed ? "stopped" : this.stage,
      installed, enabled, healthy: this.healthy, busy: this.working, canManage,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  endpoint(): string | undefined { return this.healthy ? this.origin : undefined; }

  private environment(): NodeJS.ProcessEnv {
    return { ...process.env, HF_HOME: join(this.options.root, "cache"),
      HF_HUB_DISABLE_PROGRESS_BARS: "1", PYTHONUNBUFFERED: "1" };
  }

  private async exclusive(run: () => Promise<void>): Promise<void> {
    if (this.working || this.command || this.closing) throw new Error("semantic.busy");
    this.working = true;
    this.error = undefined;
    try { await run(); } catch (error) {
      this.stage = "error";
      this.error = error instanceof Error && error.message.startsWith("semantic.") ? error.message : "semantic.failed";
      console.error("[semantic]", this.error);
      throw new Error(this.error);
    } finally { this.working = false; }
  }

  private run(binary: string, args: string[], failure: string, timeoutMs: number): Promise<void> {
    if (this.closing) return Promise.reject(new Error("semantic.cancelled"));
    return new Promise((resolve, reject) => {
      const child = this.launch(binary, args, { env: this.environment(), stdio: "ignore", windowsHide: true });
      this.command = child;
      let settled = false;
      let timedOut = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        drainTimer = setTimeout(() => {
          settled = true;
          reject(new Error(failure));
        }, 10_000);
      }, timeoutMs);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        clearTimeout(drainTimer);
        if (this.command === child) this.command = undefined;
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve();
      };
      child.once("error", () => finish(new Error(failure)));
      child.once("exit", (code) => finish(code === 0 && !timedOut && !this.closing ? undefined : new Error(failure)));
    });
  }

  async install(): Promise<void> {
    return this.exclusive(async () => {
      if (this.child) throw new Error("semantic.stopFirst");
      mkdirSync(this.options.root, { recursive: true });
      this.stage = "checking_python";
      const { binary, prefix } = await this.findPython();
      rmSync(join(this.options.root, "installed.json"), { force: true });
      await this.run(binary, [...prefix, "-m", "venv", join(this.options.root, "venv")],
        "semantic.installFailed", 120_000);
      this.stage = "installing";
      await this.run(this.python(), ["-m", "pip", "install", "--disable-pip-version-check", "-r",
        join(this.options.assets, "requirements.txt")], "semantic.installFailed", 30 * 60_000);
      this.stage = "downloading";
      await this.run(this.python(), ["-B", join(this.options.assets, "serve.py"), "--download-only",
        "--device", "cpu", "--precision", "bfloat16"],
        "semantic.downloadFailed", 60 * 60_000);
      writeFileSync(join(this.options.root, "installed.json"), JSON.stringify({ revision: REVISION, fingerprint: this.fingerprint() }));
      this.stage = "stopped";
    });
  }

  private async findPython(): Promise<{ binary: string; prefix: string[] }> {
    const candidates = process.platform === "win32"
      ? [{ binary: "py", prefix: ["-3.12"] }, { binary: "python", prefix: [] }]
      : [{ binary: "python3.12", prefix: [] }, { binary: "python3", prefix: [] }];
    for (const candidate of candidates) {
      try {
        await this.run(candidate.binary, [...candidate.prefix, "-c", "import sys; assert sys.version_info[:2] == (3, 12)"],
          "semantic.pythonRequired", 15_000);
        return candidate;
      } catch (error) {
        if (this.closing || this.command || !(error instanceof Error) || error.message !== "semantic.pythonRequired") throw error;
      }
    }
    throw new Error("semantic.pythonRequired");
  }

  async start(): Promise<void> {
    return this.exclusive(async () => {
      if (this.child && this.healthy) { this.stage = "running"; return; }
      if (!this.installed()) throw new Error("semantic.installFirst");
      await this.stopChild();
      this.stage = "starting";
      const port = await freePort();
      const child = this.launch(this.python(), ["-B", join(this.options.assets, "serve.py"), "--port", String(port),
        "--device", "cpu", "--precision", "bfloat16"],
        { env: { ...this.environment(), HF_HUB_OFFLINE: "1" }, stdio: "ignore", windowsHide: true });
      this.child = child;
      let exited = false;
      child.once("error", () => { exited = true; this.failedChild(child); });
      child.once("exit", () => { exited = true; this.failedChild(child); });
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + (this.options.startupMs ?? 180_000);
      while (!this.closing && !exited && Date.now() < deadline) {
        if (await this.probe(origin) && !exited && !this.closing && this.child === child) {
          this.origin = origin;
          this.healthy = true;
          this.stage = "running";
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await this.stopChild();
      throw new Error("semantic.startFailed");
    });
  }

  private failedChild(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.healthy = false;
    this.origin = undefined;
    if (this.stage !== "stopping" && !this.closing) {
      this.stage = "error";
      this.error = "semantic.processExited";
      console.error("[semantic]", this.error);
    }
  }

  private async probe(origin: string): Promise<boolean> {
    try {
      const response = await this.request(`${origin}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
      if (!response.ok) return false;
      const value = await response.json();
      if (!value || typeof value !== "object" || !("status" in value) || value.status !== "ready" ||
        !("descriptor" in value) || !value.descriptor || typeof value.descriptor !== "object") return false;
      const descriptor = value.descriptor;
      return "model_id" in descriptor && descriptor.model_id === "google/embeddinggemma-2" &&
        "model_revision" in descriptor && descriptor.model_revision === REVISION &&
        "dimensions" in descriptor && descriptor.dimensions === 768;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof SyntaxError) &&
        !(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) throw error;
      return false;
    }
  }

  async refreshHealth(): Promise<void> {
    if (!this.child || !this.origin || this.working) return;
    const child = this.child;
    const origin = this.origin;
    const healthy = await this.probe(origin);
    if (this.closing || this.working || this.child !== child || this.origin !== origin) return;
    this.healthy = healthy;
    if (!this.healthy) { this.stage = "error"; this.error = "semantic.healthFailed"; }
    else { this.stage = "running"; this.error = undefined; }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stage = "stopping";
    this.healthy = false;
    this.origin = undefined;
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
        const onExit = () => { clearTimeout(timer); clearTimeout(deadline); resolve(); };
        const deadline = setTimeout(() => {
          clearTimeout(timer); child.removeListener("exit", onExit); reject(new Error("semantic.stopFailed"));
        }, 10_000);
        child.once("exit", onExit);
      });
    }
    this.child = undefined;
    this.origin = undefined;
    this.healthy = false;
  }

  async stop(): Promise<void> {
    return this.exclusive(async () => { await this.stopChild(); this.stage = "stopped"; });
  }

  shutdown(): void {
    this.closing = true;
    this.command?.kill("SIGKILL");
    this.child?.kill("SIGKILL");
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("semantic.startFailed")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
