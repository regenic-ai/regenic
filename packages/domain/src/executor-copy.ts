import { defineLocaleTables } from "./copy";

export const executorLocaleTables = defineLocaleTables({
  en: {
    "http.label": "HTTP API",
    "http.description": "Start, resume, and status go to this HTTP executor.",
    "http.field.prompt": "Prompt",
    "http.field.prompt.hint":
      "Sent in executor_config. The remote executor reads the keys.",
    "http.field.prompt.placeholder": "What this run should do.",
    "session.label": "Session",
    "session.description": "Prompt goes on stdin ahead of the work evidence.",
    "session.field.prompt": "Prompt",
    "session.field.prompt.hint": "Task instruction sent before the work evidence.",
    "session.field.prompt.placeholder": "What this run should do.",
  },
  zh: {
    "http.label": "HTTP API",
    "http.description": "启动、继续和状态都发给这个 HTTP 执行器。",
    "http.field.prompt": "Prompt",
    "http.field.prompt.hint": "写在 executor_config 里。远端执行器自己读这些键。",
    "http.field.prompt.placeholder": "这次要做什么。",
    "session.label": "会话",
    "session.description": "Prompt 会写在工作材料前面，从 stdin 送进去。",
    "session.field.prompt": "Prompt",
    "session.field.prompt.hint": "在工作材料之前送出的任务说明。",
    "session.field.prompt.placeholder": "这次要做什么。",
  },
});
