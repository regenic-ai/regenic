import {
  handleFromWait,
  parseConversationThread,
  waitFromAbsentee,
  type ExecutorContext,
  type ExecutorResumeInput,
  type ExecutorRunHandle,
  type ExecutorStartInput,
  type JsonValue,
  type TaskExecutor,
  type ThreadPrompt,
  type WorkRun,
} from "@regenic/domain";

export const DSH_PROMPT_FIELD = "prompt";
export const DSH_SKILL_FIELD = "skill";
/** @deprecated Use DSH_PROMPT_FIELD. */
export const DSH_INSTRUCTION_FIELD = DSH_PROMPT_FIELD;

export function dshConfigText(
  config: Record<string, JsonValue> | undefined,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = config?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export function dshPromptOf(config: Record<string, JsonValue> | undefined): string {
  return dshConfigText(config, DSH_PROMPT_FIELD, "instruction");
}

export function dshSkillOf(config: Record<string, JsonValue> | undefined): string {
  return dshConfigText(config, DSH_SKILL_FIELD);
}

/** @deprecated Use dshPromptOf. */
export function dshInstructionOf(
  config: Record<string, JsonValue> | undefined,
): string {
  return dshPromptOf(config);
}

export function composeDshStdin(input: {
  skill?: string;
  prompt?: string;
  instruction?: string;
  evidence_text: string;
}): string {
  const skill = input.skill?.trim() ?? "";
  const prompt = (input.prompt ?? input.instruction)?.trim() ?? "";
  const blocks = [
    ...(skill ? [`SKILL ${skill}`] : []),
    ...(prompt ? [prompt] : []),
  ];
  if (blocks.length === 0) {
    return input.evidence_text;
  }
  return [...blocks, "", "WORK", input.evidence_text].join("\n");
}

export const dshTaskExecutor: TaskExecutor = {
  executor_type: "dsh",

  capabilities() {
    return { start: true, resume: true, status: true, prompts: true };
  },

  catalog() {
    return {
      executor_type: "dsh",
      label: "DSH",
      description: "Skill and prompt go on stdin ahead of the work evidence.",
      source: "dsh",
      attach: "absentee",
      fields: [
        {
          key: DSH_SKILL_FIELD,
          label: "Skill",
          kind: "text",
          hint: "Optional DSH skill or preset for this run.",
          placeholder: "review",
        },
        {
          key: DSH_PROMPT_FIELD,
          label: "Prompt",
          kind: "textarea",
          hint: "Sent before the work evidence. If the recipe writes back, line 1 must be the exact prompt option.",
          placeholder: "option-label\nReason on the following lines.",
        },
      ],
    };
  },

  async start(input: ExecutorStartInput, ctx: ExecutorContext) {
    const thread = await ctx.spawnSysout();
    const sysoutId = `${thread.source}:${thread.target}`;
    await ctx.writeStdin(
      thread,
      composeDshStdin({
        skill: dshSkillOf(input.recipe.executor_config),
        prompt: dshPromptOf(input.recipe.executor_config),
        evidence_text: input.evidence_text,
      }),
    );
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
    return handleFromWait(waitFromAbsentee({ prompts, transcript }), {
      external_run_id: sysoutId,
      sysout_id: sysoutId,
    });
  },
};

export function dshExecutorPrompts(handle: ExecutorRunHandle): ThreadPrompt[] {
  return handle.prompts ?? [];
}
