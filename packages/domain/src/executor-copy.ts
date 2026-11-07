import { defineLocaleTables } from "./copy";

export const executorLocaleTables = defineLocaleTables({
  en: {
    "http.label": "HTTP API",
    "http.description": "Start, resume, and status go to this HTTP executor.",
    "session.label": "Session",
    "session.description": "The shared task instruction goes on stdin ahead of the work evidence.",
  },
  zh: {
    "http.label": "HTTP API",
    "http.description": "启动、继续和状态都发给这个 HTTP 执行器。",
    "session.label": "会话",
    "session.description": "公共任务说明会写在工作材料前面，从 stdin 送进去。",
  },
});
