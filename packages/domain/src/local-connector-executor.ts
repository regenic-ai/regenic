import type { TaskExecutor } from "./executor";

export function createLocalConnectorExecutor(input: {
  executor_type: string;
  label: string;
  description?: string;
  source?: string;
  installation_id?: string;
  plugin: TaskExecutor;
}): TaskExecutor {
  return {
    executor_type: input.executor_type,

    capabilities() {
      return input.plugin.capabilities();
    },

    locales() {
      return input.plugin.locales?.() ?? [];
    },

    catalog() {
      const base = input.plugin.catalog();
      return {
        ...base,
        executor_type: input.executor_type,
        label: { literal: input.label },
        description: input.description
          ? { literal: input.description }
          : base.description,
        source: input.source ?? base.source,
        installation_id: input.installation_id,
        kind: "local_connector",
      };
    },

    start(startInput, ctx) {
      return input.plugin.start(startInput, ctx);
    },

    resume(resumeInput, ctx) {
      return input.plugin.resume(resumeInput, ctx);
    },

    status(run, ctx) {
      return input.plugin.status(run, ctx);
    },
  };
}
