import {
  handleFromWait,
  parseConversationThread,
  waitFromTranscript,
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
      source: "dsh",
      attach: "absentee",
      fields: [],
    };
  },

  async start(input: ExecutorStartInput, ctx: ExecutorContext) {
    const thread = await ctx.spawnSysout();
    const sysoutId = `${thread.source}:${thread.target}`;
    await ctx.writeStdin(thread, input.evidence_text);
    return {
      external_run_id: sysoutId,
      agent_thread_id: sysoutId,
      status: "running" as const,
    };
  },

  async resume(input: ExecutorResumeInput, ctx: ExecutorContext) {
    return this.status(input.run, ctx);
  },

  async status(run: WorkRun, ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    const sysoutId = run.agent_thread_id ?? run.external_run_id;
    if (!sysoutId) {
      return {
        external_run_id: run.id,
        status: run.status === "waiting_human" ? "waiting_human" : "running",
      };
    }
    let thread;
    try {
      thread = parseConversationThread(sysoutId);
    } catch {
      return {
        external_run_id: sysoutId,
        agent_thread_id: sysoutId,
        status: "failed",
      };
    }
    const prompts = await ctx.listPrompts(thread);
    const transcript = await ctx.readTranscript(sysoutId);
    return handleFromWait(waitFromTranscript({ prompts, transcript }), {
      external_run_id: sysoutId,
      sysout_id: sysoutId,
    });
  },
};

export function dshExecutorPrompts(handle: ExecutorRunHandle): ThreadPrompt[] {
  return handle.prompts ?? [];
}
