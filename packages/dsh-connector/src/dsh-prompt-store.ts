import type { PromptAnswer, ThreadPrompt } from "@regenic/domain";

const stores = new Map<string, DshPromptStore>();

export function dshPromptStoreFor(installationId: string): DshPromptStore {
  let store = stores.get(installationId);
  if (!store) {
    store = new DshPromptStore();
    stores.set(installationId, store);
  }
  return store;
}

export function dropDshPromptStore(installationId: string): void {
  stores.delete(installationId);
}

export class DshPromptStore {
  private readonly bySession = new Map<string, Map<string, ThreadPrompt>>();
  private revision = 0;

  generation(): string {
    return String(this.revision);
  }

  list(sessionId: string): ThreadPrompt[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  put(sessionId: string, prompt: ThreadPrompt): void {
    let bucket = this.bySession.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionId, bucket);
    }
    bucket.set(prompt.prompt_id, prompt);
    this.revision += 1;
  }

  remove(sessionId: string, promptId: string): boolean {
    const bucket = this.bySession.get(sessionId);
    if (!bucket?.delete(promptId)) {
      return false;
    }
    this.revision += 1;
    if (bucket.size === 0) {
      this.bySession.delete(sessionId);
    }
    return true;
  }

  applyEnvelope(rpcId: string, frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    const sessionId =
      typeof frame.sessionId === "string" ? frame.sessionId.trim() : "";
    if (!sessionId) {
      return;
    }
    if (type === "session/subscribed") {
      replaySubscribed(this, sessionId, frame);
      return;
    }
    if (type === "question/requested") {
      const prompt = questionPrompt(rpcId, frame);
      if (prompt) {
        this.put(sessionId, prompt);
      }
      return;
    }
    if (type === "approval/requested") {
      const prompt = approvalPrompt(rpcId, frame);
      if (prompt) {
        this.put(sessionId, prompt);
      }
      return;
    }
    if (type === "question/resolved") {
      const questionRpcId =
        typeof frame.questionRpcId === "string" ? frame.questionRpcId : rpcId;
      this.remove(sessionId, questionPromptId(questionRpcId));
      return;
    }
    if (type === "approval/resolved") {
      const approvalId =
        typeof frame.approvalId === "string" ? frame.approvalId : "";
      this.removeApproval(sessionId, approvalId);
    }
  }

  private removeApproval(sessionId: string, approvalId: string): void {
    if (!approvalId) {
      return;
    }
    const bucket = this.bySession.get(sessionId);
    if (!bucket) {
      return;
    }
    for (const id of [...bucket.keys()]) {
      if (id.endsWith(`:${approvalId}`)) {
        this.remove(sessionId, id);
      }
    }
  }
}

export function questionPromptId(rpcId: string): string {
  return `q:${rpcId}`;
}

export function approvalPromptId(rpcId: string, approvalId: string): string {
  return `a:${rpcId}:${approvalId}`;
}

export function parseDshPromptId(promptId: string):
  | { kind: "question"; rpcId: string }
  | { kind: "approval"; rpcId: string; approvalId: string }
  | undefined {
  if (promptId.startsWith("q:")) {
    const rpcId = promptId.slice(2).trim();
    return rpcId ? { kind: "question", rpcId } : undefined;
  }
  if (promptId.startsWith("a:")) {
    const rest = promptId.slice(2);
    const cut = rest.indexOf(":");
    if (cut <= 0 || cut === rest.length - 1) {
      return undefined;
    }
    return {
      kind: "approval",
      rpcId: rest.slice(0, cut),
      approvalId: rest.slice(cut + 1),
    };
  }
  return undefined;
}

export function questionPrompt(
  rpcId: string,
  frame: Record<string, unknown>,
): ThreadPrompt | undefined {
  const questions = Array.isArray(frame.questions)
    ? frame.questions.flatMap((item, index) => mapQuestion(item, index))
    : [];
  if (questions.length === 0) {
    return undefined;
  }
  const plan = questions.some((question) => question.presentation === "plan_review");
  return {
    prompt_id: questionPromptId(rpcId),
    presentation: plan ? "plan_review" : "choice",
    title: firstHeader(frame.questions),
    detail: firstDetail(frame.questions),
    questions: questions.map(({ presentation: _presentation, ...question }) => question),
  };
}

export function approvalPrompt(
  rpcId: string,
  frame: Record<string, unknown>,
): ThreadPrompt | undefined {
  const approvalId =
    typeof frame.approvalId === "string" ? frame.approvalId.trim() : "";
  if (!approvalId) {
    return undefined;
  }
  const tool =
    typeof frame.toolName === "string" && frame.toolName.trim()
      ? frame.toolName.trim()
      : "this action";
  const reason =
    typeof frame.reason === "string" && frame.reason.trim()
      ? frame.reason.trim()
      : `Allow ${tool}?`;
  return {
    prompt_id: approvalPromptId(rpcId, approvalId),
    presentation: "approval",
    title: tool,
    detail: reason,
    questions: [
      {
        id: "decision",
        prompt: reason,
        options: [{ label: "Allow" }, { label: "Refuse" }],
      },
    ],
  };
}

export function dshRespondValue(
  sessionId: string,
  parsed: NonNullable<ReturnType<typeof parseDshPromptId>>,
  answer: PromptAnswer,
): unknown {
  if (parsed.kind === "question") {
    return {
      sessionId,
      answer: {
        answers: answer.answers.map((item) => ({
          id: item.id,
          selected: item.selected,
          ...(item.custom ? { custom: item.custom } : {}),
        })),
      },
    };
  }
  const selected = answer.answers[0]?.selected ?? [];
  const allowed = selected.some((label) => /^allow$/i.test(label));
  return {
    sessionId,
    approvalId: parsed.approvalId,
    outcome: allowed ? "allowed-once" : "rejected",
  };
}

export function muxFrameFromMessage(message: unknown): {
  rpcId: string;
  frame: Record<string, unknown>;
} | undefined {
  if (!isObject(message)) {
    return undefined;
  }
  if (message.type === "server-request") {
    const rpcId = typeof message.rpcId === "string" ? message.rpcId : "";
    const method = typeof message.method === "string" ? message.method : "";
    const payload = isObject(message.payload) ? message.payload : {};
    if (!rpcId || !method) {
      return undefined;
    }
    return { rpcId, frame: { ...payload, type: method } };
  }
  const type = typeof message.type === "string" ? message.type : "";
  const rpcId = typeof message.rpcId === "string" ? message.rpcId : "";
  if (!type) {
    return undefined;
  }
  return { rpcId, frame: message };
}

function mapQuestion(
  value: unknown,
  index: number,
): Array<ThreadPrompt["questions"][number] & { presentation?: "plan_review" }> {
  if (!isObject(value)) {
    return [];
  }
  const id =
    (typeof value.id === "string" && value.id.trim()) || `question-${index + 1}`;
  const prompt =
    (typeof value.question === "string" && value.question.trim()) ||
    (typeof value.header === "string" && value.header.trim()) ||
    "";
  if (!prompt) {
    return [];
  }
  const intent = isObject(value.intent) ? value.intent : undefined;
  const approve =
    typeof intent?.approve === "string" && intent.approve.trim()
      ? intent.approve.trim()
      : "";
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => {
        if (!isObject(option) || typeof option.label !== "string" || !option.label.trim()) {
          return [];
        }
        const label = option.label.trim();
        return [
          {
            label,
            ...(typeof option.description === "string" && option.description.trim()
              ? { description: option.description.trim() }
              : {}),
            ...(intent?.kind === "plan-review" && approve === label
              ? { emphasized: true as const }
              : {}),
          },
        ];
      })
    : [];
  return [
    {
      id,
      prompt,
      ...(options.length > 0 ? { options } : {}),
      ...(value.multiSelect === true || value.multi_select === true
        ? { multi_select: true }
        : {}),
      ...(intent?.kind === "plan-review" ? { presentation: "plan_review" as const } : {}),
    },
  ];
}

function firstHeader(questions: unknown): string | undefined {
  if (!Array.isArray(questions)) {
    return undefined;
  }
  for (const item of questions) {
    if (isObject(item) && typeof item.header === "string" && item.header.trim()) {
      return item.header.trim();
    }
  }
  return undefined;
}

function firstDetail(questions: unknown): string | undefined {
  if (!Array.isArray(questions)) {
    return undefined;
  }
  for (const item of questions) {
    if (isObject(item) && typeof item.detail === "string" && item.detail.trim()) {
      return item.detail.trim();
    }
  }
  return undefined;
}

function replaySubscribed(
  store: DshPromptStore,
  sessionId: string,
  frame: Record<string, unknown>,
): void {
  const bags = [frame.pending, frame.questions, frame.approvals];
  for (const bag of bags) {
    if (!Array.isArray(bag)) {
      continue;
    }
    for (const item of bag) {
      if (!isObject(item)) {
        continue;
      }
      const type = typeof item.type === "string" ? item.type : "";
      if (type !== "question/requested" && type !== "approval/requested") {
        continue;
      }
      const itemRpcId = typeof item.rpcId === "string" ? item.rpcId : "";
      store.applyEnvelope(itemRpcId, {
        ...item,
        sessionId:
          typeof item.sessionId === "string" && item.sessionId.trim()
            ? item.sessionId
            : sessionId,
      });
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
