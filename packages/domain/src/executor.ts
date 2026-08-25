import type { JsonValue } from "./ingestion";
import type { ConversationThread } from "./channel-driver";
import type {
  AttachMode,
  InferiorRef,
  Transcript,
  WaitStatus,
} from "./job-control";
import type { PromptAnswer, ThreadPrompt } from "./thread-surface";
import type { Recipe, ResultEnvelope, WorkItem, WorkRun, WorkRunStatus } from "./work";

export interface ExecutorCapabilities {
  start: boolean;
  resume: boolean;
  status: boolean;
  prompts?: boolean;
}

export interface ExecutorCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
}

export interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  source?: string;
  attach?: AttachMode;
  fields: ExecutorCatalogField[];
}

export interface ExecutorContext {
  org_id: string;
  env: NodeJS.ProcessEnv;
  /** Absentee sysout. Not a Session. */
  spawnSysout(): Promise<ConversationThread>;
  writeStdin(thread: ConversationThread, text: string): Promise<void>;
  listPrompts(thread: ConversationThread): Promise<ThreadPrompt[]>;
  readTranscript(sysoutId: string): Promise<Transcript | null>;
}

export interface ExecutorStartInput {
  work_item: WorkItem;
  recipe: Recipe;
  evidence_text: string;
}

export interface ExecutorResumeInput {
  run: WorkRun;
  work_item: WorkItem;
  recipe: Recipe;
  answer?: PromptAnswer;
}

export interface ExecutorRunHandle {
  external_run_id: string;
  agent_thread_id?: string;
  status: WorkRunStatus;
  result?: ResultEnvelope;
  prompts?: ThreadPrompt[];
  transcript?: Transcript;
}

export function handleFromWait(
  wait: WaitStatus,
  ref: InferiorRef,
): ExecutorRunHandle {
  const transcript = wait.transcript;
  if (wait.state === "waiting_human") {
    return {
      external_run_id: ref.external_run_id,
      agent_thread_id: ref.sysout_id,
      status: "waiting_human",
      prompts: wait.prompts,
      transcript,
    };
  }
  if (wait.state === "exited") {
    return {
      external_run_id: ref.external_run_id,
      agent_thread_id: ref.sysout_id,
      status: wait.ok ? "completed" : "failed",
      result: wait.result,
      transcript,
    };
  }
  return {
    external_run_id: ref.external_run_id,
    agent_thread_id: ref.sysout_id,
    status: "running",
    transcript,
  };
}

export interface TaskExecutor {
  readonly executor_type: string;
  capabilities(): ExecutorCapabilities;
  catalog(): ExecutorCatalogEntry;
  start(
    input: ExecutorStartInput,
    ctx: ExecutorContext,
  ): Promise<ExecutorRunHandle>;
  resume(
    input: ExecutorResumeInput,
    ctx: ExecutorContext,
  ): Promise<ExecutorRunHandle>;
  status(run: WorkRun, ctx: ExecutorContext): Promise<ExecutorRunHandle>;
}

export interface ExecutorRegistry {
  register(executor: TaskExecutor): () => void;
  get(executorType: string): TaskExecutor | undefined;
  list(): TaskExecutor[];
  catalog(): ExecutorCatalogEntry[];
}

export class MemoryExecutorRegistry implements ExecutorRegistry {
  private readonly byType = new Map<string, TaskExecutor>();

  register(executor: TaskExecutor): () => void {
    if (this.byType.has(executor.executor_type)) {
      throw new Error(`Executor already registered: ${executor.executor_type}`);
    }
    this.byType.set(executor.executor_type, executor);
    return () => {
      this.byType.delete(executor.executor_type);
    };
  }

  get(executorType: string): TaskExecutor | undefined {
    return this.byType.get(executorType);
  }

  list(): TaskExecutor[] {
    return [...this.byType.values()];
  }

  catalog(): ExecutorCatalogEntry[] {
    return this.list().map((executor) => executor.catalog());
  }
}

export function formatWorkEvidence(input: {
  thread_id: string;
  record_class: string;
  thread_facet: string;
  source: string;
  text?: string;
  extra?: Record<string, JsonValue>;
}): string {
  const lines = [
    `Work item ${input.thread_id}`,
    `record_class=${input.record_class} thread_facet=${input.thread_facet} source=${input.source}`,
  ];
  if (input.text?.trim()) {
    lines.push("", input.text.trim());
  }
  if (input.extra && Object.keys(input.extra).length > 0) {
    lines.push("", JSON.stringify(input.extra));
  }
  return lines.join("\n");
}
