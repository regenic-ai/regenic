import { executorLocaleTables } from "./executor-copy";
import {
  composeWorkspaceTaskEvidence,
  formatWorkEvidence,
  handleFromWait,
  stageConversationWorkspace,
} from "./executor";
import type {
  ExecutorContext,
  ExecutorResumeInput,
  ExecutorRunHandle,
  ExecutorStartInput,
  TaskExecutor,
} from "./executor";
import { parseConversationThread } from "./channel-driver";
import { waitFromAbsentee } from "./job-control";
import type { WorkRun } from "./work";

export function composeSessionStdin(input: {
  prompt?: string;
  evidence_text: string;
}): string {
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) {
    return input.evidence_text;
  }
  return [prompt, "", "WORK", input.evidence_text].join("\n");
}

/** Absentee session runner. Uses ExecutorContext only; no private HTTP. */
export function createSessionTaskExecutor(meta?: {
  executor_type?: string;
  label?: string;
  description?: string;
  source?: string;
}): TaskExecutor {
  const executorType = meta?.executor_type ?? "session";
  return {
    executor_type: executorType,

    capabilities() {
      return {
        start: true,
        resume: true,
        status: true,
        prompts: true,
        local_workspace: true,
      };
    },

    locales() {
      return executorLocaleTables;
    },

    catalog() {
      return {
        executor_type: executorType,
        label: meta?.label ? { literal: meta.label } : "session.label",
        description: meta?.description
          ? { literal: meta.description }
          : "session.description",
        source: meta?.source,
        attach: "absentee",
        kind: "local_connector",
        fields: [
          {
            key: "prompt",
            label: "session.field.prompt",
            kind: "textarea",
            hint: "session.field.prompt.hint",
            placeholder: "session.field.prompt.placeholder",
          },
        ],
      };
    },

    async start(input: ExecutorStartInput, ctx: ExecutorContext) {
      const staged = await stageConversationWorkspace(
        ctx,
        input.conversation,
        input.work_item.id,
      );
      const thread = await ctx.spawnSysout(staged?.cwd ? { cwd: staged.cwd } : undefined);
      const sysoutId = `${thread.source}:${thread.target}`;
      const prompt =
        typeof input.recipe.executor_config.prompt === "string"
          ? input.recipe.executor_config.prompt
          : "";
      const evidence_text = staged?.cwd
        ? formatWorkEvidence({
            thread_id: input.work_item.thread_id,
            record_class: input.work_item.record_class,
            thread_facet: input.work_item.thread_facet,
            source: input.work_item.thread_id.split(":")[0] ?? "",
            text: composeWorkspaceTaskEvidence({
              current_line: input.conversation?.current_line,
            }),
          })
        : input.evidence_text;
      await ctx.writeStdin(
        thread,
        composeSessionStdin({
          prompt,
          evidence_text,
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

    async status(
      run: WorkRun,
      ctx: ExecutorContext,
    ): Promise<ExecutorRunHandle> {
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
}

export const sessionTaskExecutor = createSessionTaskExecutor();
