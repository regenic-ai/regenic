import { readFileSync, writeFileSync } from "node:fs";

// Rebuilds the checked-in LongMemEval subset. The oracle file is not committed.
// Usage: node build-semantic-search-memory.mjs /path/to/longmemeval_oracle.json

const ANAPHORA = /\b(that|those|the one|remind me|previous|last time|earlier)\b/i;
const STOP = new Set("a an the of to and or in on for with me you we our my your that this those these what was were is are be been can could would should how many much when where who whom which about from by at it its as into over after before again last time previous earlier remind conversation chat one did say".split(" "));
const QUOTA = { lookup: 12, anaphora: 12, aggregate: 12, temporal: 12, update: 8 };
const NEGATIVE_QUOTA = 6;
const ANSWER_CHAR_CAP = { lookup: 600, anaphora: 1800, aggregate: 800, temporal: 800, update: 800 };

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error("Pass the LongMemEval oracle JSON path");
}

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const selected = { lookup: [], anaphora: [], aggregate: [], temporal: [], update: [] };
const anaphoraPool = [];
const negatives = [];

for (const item of [...source].sort((left, right) => left.question_id < right.question_id ? -1 : left.question_id > right.question_id ? 1 : 0)) {
  const task = taskOf(item);
  if (!task) {
    continue;
  }
  const answers = answerTurns(item);
  if (answers.length === 0) {
    if (negatives.length < NEGATIVE_QUOTA) {
      negatives.push({ item, task });
    }
    continue;
  }
  if (!eligible(item, task, answers)) {
    continue;
  }
  if (task === "anaphora") {
    const rank = anaphoraRank(item, answers);
    if (rank) {
      anaphoraPool.push({ item, task, ...rank });
    }
    continue;
  }
  if (selected[task].length < QUOTA[task]) {
    selected[task].push({ item, task });
  }
}
anaphoraPool.sort((left, right) => left.overlap - right.overlap || left.item.question_id.localeCompare(right.item.question_id));
selected.anaphora = anaphoraPool.slice(0, QUOTA.anaphora);

for (const [task, quota] of Object.entries(QUOTA)) {
  if (selected[task].length !== quota) {
    throw new Error(`Expected ${quota} ${task} questions, found ${selected[task].length}`);
  }
}
if (negatives.length !== NEGATIVE_QUOTA) {
  throw new Error(`Expected ${NEGATIVE_QUOTA} abstentions, found ${negatives.length}`);
}

const chosen = [...Object.values(selected).flat(), ...negatives];
const events = [];
const cases = [];
for (const { item, task } of chosen) {
  const relevant = [];
  item.haystack_sessions.forEach((session, sessionIndex) => {
    const occurred = parseStamp(item.haystack_dates[sessionIndex], item.question_id);
    session.forEach((turn, turnIndex) => {
      if (typeof turn.content !== "string" || !turn.content.trim()) {
        throw new Error(`Empty turn in ${item.question_id}`);
      }
      const id = `lme-${item.question_id}-s${sessionIndex}-t${turnIndex}`;
      const hasAnswer = String(turn.has_answer).toLowerCase() === "true";
      events.push({
        id,
        question_id: item.question_id,
        thread_id: `lme-${item.question_id}-s${sessionIndex}`,
        role: turn.role,
        occurred_at: new Date(occurred.getTime() + turnIndex * 1000).toISOString(),
        has_answer: hasAnswer,
        text: turn.content,
      });
      if (hasAnswer) {
        relevant.push(id);
      }
    });
  });
  cases.push({
    id: `lme-${item.question_id}`,
    task,
    source_question_id: item.question_id,
    source_question_type: item.question_type,
    query: item.question,
    relevant_event_ids: relevant,
  });
}

const ids = new Set(events.map((event) => event.id));
if (ids.size !== events.length || new Set(cases.map((value) => value.id)).size !== cases.length) {
  throw new Error("Duplicate LongMemEval evaluation ids");
}
for (const value of cases) {
  const marked = events.filter((event) => event.question_id === value.source_question_id && event.has_answer).map((event) => event.id);
  if (marked.join() !== value.relevant_event_ids.join()) {
    throw new Error(`Relevance drift on ${value.id}`);
  }
}

const labels = {
  schema_version: "1.0",
  id: "semantic-search-memory-v1",
  source_dataset: "LongMemEval cleaned oracle (https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)",
  license: "MIT",
  copyright: "Copyright (c) 2024 Di Wu",
  note: "Shared index of selected evidence sessions, not the paper's full haystack. Relevance is the source has_answer flag. single-session-user becomes lookup; multi-session with two or more answer turns becomes aggregate; temporal-reasoning becomes temporal; knowledge-update becomes update. Those four take the first questions in question_id order under the answer-length cap. Anaphora takes referential single-session-assistant questions whose answer words are mostly absent from the question, then the twelve with the lowest content-word overlap between the question and the answer turns. Questions with no answer turn are abstentions. Session time is the source session stamp; a turn adds its index in seconds.",
  cases,
};
writeFileSync(new URL("./semantic-search-memory-v1.json", import.meta.url), `${JSON.stringify(labels, null, 2)}\n`);
writeFileSync(
  new URL("./semantic-search-memory-v1-events.jsonl", import.meta.url),
  `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
);
const chars = events.reduce((sum, event) => sum + event.text.length, 0);
console.log(JSON.stringify({
  questions: cases.length,
  events: events.length,
  chars,
  by_task: Object.fromEntries(Object.entries(QUOTA).map(([task]) => [task, cases.filter((value) => value.task === task && value.relevant_event_ids.length > 0).length])),
  negatives: cases.filter((value) => value.relevant_event_ids.length === 0).length,
  answer_turns: {
    min: Math.min(...cases.filter((value) => value.relevant_event_ids.length).map((value) => value.relevant_event_ids.length)),
    max: Math.max(...cases.map((value) => value.relevant_event_ids.length)),
  },
}, null, 2));

function taskOf(item) {
  if (item.question_type === "single-session-user") return "lookup";
  if (item.question_type === "single-session-assistant" && ANAPHORA.test(item.question)) return "anaphora";
  if (item.question_type === "multi-session") return "aggregate";
  if (item.question_type === "temporal-reasoning") return "temporal";
  if (item.question_type === "knowledge-update") return "update";
  return null;
}

function answerTurns(item) {
  return item.haystack_sessions.flat().filter((turn) => String(turn.has_answer).toLowerCase() === "true");
}

function anaphoraRank(item, answers) {
  const query = contentTokens(item.question);
  const gold = contentTokens(String(item.answer ?? ""));
  if (query.size === 0 || gold.size === 0) {
    return null;
  }
  const goldInQuery = [...gold].filter((token) => query.has(token)).length / gold.size;
  if (goldInQuery >= 0.5) {
    return null;
  }
  const body = contentTokens(answers.map((turn) => turn.content).join(" "));
  return { overlap: [...query].filter((token) => body.has(token)).length / query.size };
}

function contentTokens(value) {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 4 && !STOP.has(token)));
}

function eligible(item, task, answers) {
  const longest = Math.max(...answers.map((turn) => turn.content.length));
  if (longest > ANSWER_CHAR_CAP[task]) {
    return false;
  }
  if (task === "lookup" && answers.some((turn) => turn.role !== "user")) {
    return false;
  }
  if (task === "aggregate" && answers.length < 2) {
    return false;
  }
  return true;
}

function parseStamp(value, questionId) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Unparsed session time ${value} on ${questionId}`);
  }
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ));
}
