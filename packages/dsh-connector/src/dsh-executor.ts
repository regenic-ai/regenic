import {
  parseConversationThread,
  type ExecutorContext,
  type ExecutorResumeInput,
  type ExecutorRunHandle,
  type ExecutorStartInput,
  type TaskExecutor,
  type ThreadPrompt,
  type WorkRun,
} from "@regenic/domain";

export const dshTaskExecutor: TaskExecutor = {
  executor_type: "dsh",

  capabilities() {
    return { start: true, resume: true, status: true, prompts: true };
  },

  catalog() {
    return {
      executor_type: "dsh",
      label: "DSH",
      description: "Run the work item in a local DSH session",
      fields: [],
    };
  },

  async start(input: ExecutorStartInput, ctx: ExecutorContext) {
    const thread = await ctx.createThread();
    const agentThreadId = `${thread.source}:${thread.target}`;
    await ctx.sendText(thread, input.evidence_text);
    return {
      external_run_id: agentThreadId,
      agent_thread_id: agentThreadId,
      status: "running" as const,
    };
  },

  async resume(input: ExecutorResumeInput, ctx: ExecutorContext) {
    return this.status(input.run, ctx);
  },

  async status(run: WorkRun, ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    const agentThreadId = run.agent_thread_id ?? run.external_run_id;
    if (!agentThreadId) {
      return {
        external_run_id: run.id,
        status: run.status === "waiting_human" ? "waiting_human" : "running",
      };
    }
    let thread;
    try {
      thread = parseConversationThread(agentThreadId);
    } catch {
      return {
        external_run_id: agentThreadId,
        agent_thread_id: agentThreadId,
        status: "failed",
      };
    }
    const prompts = await ctx.listPrompts(thread);
    if (prompts.length > 0) {
      return {
        external_run_id: agentThreadId,
        agent_thread_id: agentThreadId,
        status: "waiting_human",
        prompts,
      };
    }
    const latest = await ctx.latestVisible(agentThreadId);
    if (latest?.kind === "assistant" && latest.text?.trim()) {
      return {
        external_run_id: agentThreadId,
        agent_thread_id: agentThreadId,
        status: "completed",
        result: { summary: latest.text.trim() },
      };
    }
    return {
      external_run_id: agentThreadId,
      agent_thread_id: agentThreadId,
      status: "running",
      ...(prompts.length > 0 ? { prompts } : {}),
    };
  },
};

export function dshExecutorPrompts(handle: ExecutorRunHandle): ThreadPrompt[] {
  return handle.prompts ?? [];
}
