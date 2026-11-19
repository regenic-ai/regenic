import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Rebuilds the checked-in TimlMemBench Chinese subset.
// Usage: node build-semantic-search-zh.mjs /path/to/zh/canonical
// That directory needs questions.jsonl, sessions.jsonl, and gold_state_ledger_v1.jsonl.

const DEMONSTRATIVE = /那个|这个|那次|这次|那边|那套|那件|那块|那家|那间|那位|那几|上次|上回|之前说的|刚才/g;
const DATED = /\d{4}-\d{2}|\d+ ?月|\d+ ?号/;
const PUNCTUATION = /[\s，。？！、“”：；（）()?,.!/]/g;
const SPEAKER = /(?<![A-Za-z])[AB](?![A-Za-z])/g;
const STALE_MIN_OVERLAP = 0.15;
const UPDATE_TYPES = new Set(["knowledge_update", "supersede", "revoke_or_update", "revoke_correctness"]);
const AGGREGATE_TYPES = new Set(["information_extraction", "temporal_reasoning", "knowledge_update", "multi_session_reasoning"]);
const QUOTA = { anaphora: 12, aggregate: 12, lookup: 12, temporal: 12, update: 12, boundary: 8 };

const sourceDir = process.argv[2];
if (!sourceDir) {
  throw new Error("Pass the TimlMemBench zh/canonical directory");
}

const questions = readJsonl(join(sourceDir, "questions.jsonl")).sort((left, right) => left.question_id < right.question_id ? -1 : left.question_id > right.question_id ? 1 : 0);
const sessions = readJsonl(join(sourceDir, "sessions.jsonl"));
const ledger = new Map(readJsonl(join(sourceDir, "gold_state_ledger_v1.jsonl")).map((state) => [state.state_id, state]));
const turnById = new Map();
const sessionByTurn = new Map();
for (const session of sessions) {
  for (const turn of session.turns) {
    if (turnById.has(turn.turn_id)) {
      throw new Error(`Duplicate turn ${turn.turn_id}`);
    }
    turnById.set(turn.turn_id, { ...turn, thread_id: session.session_id, world_id: session.world_id });
    sessionByTurn.set(turn.turn_id, session.session_id);
  }
}

const prepared = questions.map((question) => {
  const relevant = unique(question.evidence_turn_ids ?? []);
  if (relevant.some((turnId) => !turnById.has(turnId))) {
    throw new Error(`Missing evidence turn on ${question.question_id}`);
  }
  const relevantSet = new Set(relevant);
  const stale = [];
  for (const stateId of question.forbidden_memory_ids ?? []) {
    const state = ledger.get(stateId);
    if (!state) {
      throw new Error(`Missing forbidden state ${stateId} on ${question.question_id}`);
    }
    stale.push(...statedTurns(state).filter((turnId) => !relevantSet.has(turnId)));
  }
  return {
    question,
    relevant,
    stale: unique(stale),
    sessions: new Set(relevant.map((turnId) => sessionByTurn.get(turnId))).size,
    overlap: overlapWithEvidence(question.prompt, relevant),
  };
});

const taken = new Set();
const selected = {
  anaphora: take("anaphora", (row) => !row.question.unanswerable && isAnaphora(row.question.prompt) && row.relevant.length >= 1 && row.relevant.length <= 4, (left, right) => left.overlap - right.overlap),
  aggregate: take("aggregate", (row) => !row.question.unanswerable && AGGREGATE_TYPES.has(row.question.question_type) && row.sessions >= 2 && row.relevant.length >= 2 && row.relevant.length <= 6),
  lookup: take("lookup", (row) => !row.question.unanswerable && row.question.question_type === "information_extraction" && row.relevant.length >= 1 && row.relevant.length <= 4),
  temporal: take("temporal", (row) => !row.question.unanswerable && row.question.question_type === "temporal_reasoning" && row.relevant.length >= 1 && row.relevant.length <= 6),
  update: take("update", (row) => !row.question.unanswerable && UPDATE_TYPES.has(row.question.question_type) && row.stale.length >= 1 && row.relevant.length >= 1 && row.relevant.length <= 6),
  boundary: take("boundary", (row) => row.question.unanswerable && row.question.question_type === "abstention" && row.relevant.length >= 1 && row.relevant.length <= 4),
};

const chosen = Object.entries(selected).flatMap(([task, rows]) => rows.map((row) => ({ task, ...row })));
const worlds = new Set(chosen.map((row) => row.question.world_id));
const events = [...turnById.values()]
  .filter((turn) => worlds.has(turn.world_id))
  .map((turn) => ({
    id: turn.turn_id,
    world_id: turn.world_id,
    thread_id: turn.thread_id,
    role: turn.speaker_id,
    occurred_at: parseTime(turn.timestamp, turn.turn_id),
    text: turn.text,
  }))
  .sort((left, right) => left.occurred_at < right.occurred_at ? -1 : left.occurred_at > right.occurred_at ? 1 : left.id < right.id ? -1 : 1);
const known = new Set(events.map((event) => event.id));
const latest = events[events.length - 1].occurred_at;
const recordedAt = new Date(Date.parse(latest) + 86_400_000).toISOString();
const cases = chosen.map((row) => {
  for (const turnId of [...row.relevant, ...row.stale]) {
    if (!known.has(turnId)) {
      throw new Error(`Selected turn ${turnId} is outside its world index`);
    }
  }
  return {
    id: `zh-${row.question.question_id}`,
    task: row.task,
    source_question_id: row.question.question_id,
    source_question_type: row.question.question_type,
    query: row.question.prompt,
    relevant_event_ids: row.relevant,
    ...(row.stale.length > 0 ? { stale_event_ids: row.stale } : {}),
  };
});

const labels = {
  schema_version: "1.0",
  id: "semantic-search-zh-v1",
  source_dataset: "TimlMemBench Chinese canonical questions (https://github.com/lyirs/TimlMemBench)",
  license: "CC BY 4.0",
  copyright: "Copyright (c) 2026 TimlMemBench authors",
  recorded_at: recordedAt,
  note: "Short Chinese chats from TimlMemBench. Relevance is evidence_turn_ids. Stale ids are the provenance turns of forbidden_memory_ids whose character-bigram overlap with the forbidden value is at least 0.15, keeping at least the best turn of each state. Anaphora has a demonstrative such as 那个、上次 or 那边, no date, and no 是谁; the twelve with the lowest bigram overlap against their evidence are kept. Aggregate evidence spans at least two sessions. Lookup is information extraction. Temporal and update keep the source question type; update also needs a forbidden memory. Boundary questions are unanswerable in the source; the evidence turns are the messages where the fact was withheld, and retrieving them is the goal. Each task prefers distinct worlds. The index is every turn in the selected worlds. A turn time written as a range uses the start.",
  cases,
};
writeFileSync(new URL("./semantic-search-zh-v1.json", import.meta.url), `${JSON.stringify(labels, null, 2)}\n`);
writeFileSync(new URL("./semantic-search-zh-v1-events.jsonl", import.meta.url), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const lengths = events.map((event) => event.text.length).sort((left, right) => left - right);
console.log(JSON.stringify({
  questions: cases.length,
  events: events.length,
  worlds: worlds.size,
  chars: events.reduce((sum, event) => sum + event.text.length, 0),
  median_chars: lengths[Math.floor(lengths.length / 2)],
  by_task: Object.fromEntries(Object.keys(QUOTA).map((task) => [task, cases.filter((value) => value.task === task).length])),
  with_stale: cases.filter((value) => value.stale_event_ids).length,
  recorded_at: recordedAt,
}, null, 2));

function take(task, predicate, order) {
  const quota = QUOTA[task];
  const picked = [];
  const seenWorlds = new Set();
  const rows = order ? [...prepared].sort((left, right) => order(left, right) || (left.question.question_id < right.question.question_id ? -1 : 1)) : prepared;
  for (const row of rows) {
    if (taken.has(row.question.question_id) || !predicate(row) || seenWorlds.has(row.question.world_id)) {
      continue;
    }
    picked.push(row);
    seenWorlds.add(row.question.world_id);
    taken.add(row.question.question_id);
    if (picked.length === quota) {
      return picked;
    }
  }
  for (const row of rows) {
    if (taken.has(row.question.question_id) || !predicate(row)) {
      continue;
    }
    picked.push(row);
    taken.add(row.question.question_id);
    if (picked.length === quota) {
      return picked;
    }
  }
  throw new Error(`Expected ${quota} ${task} questions, found ${picked.length}`);
}

function isAnaphora(prompt) {
  return new RegExp(DEMONSTRATIVE.source).test(prompt) && !DATED.test(prompt) && !prompt.includes("是谁");
}

function overlapWithEvidence(prompt, turnIds) {
  const query = bigrams(prompt.replace(DEMONSTRATIVE, ""));
  if (query.size === 0) {
    return 1;
  }
  const evidence = new Set(turnIds.flatMap((turnId) => [...bigrams(turnById.get(turnId).text)]));
  return [...query].filter((gram) => evidence.has(gram)).length / query.size;
}

function statedTurns(state) {
  const value = bigrams(String(state.value ?? ""));
  const scored = (state.provenance_turn_ids ?? [])
    .filter((turnId) => turnById.has(turnId))
    .map((turnId) => {
      const text = bigrams(turnById.get(turnId).text);
      return { turnId, score: text.size === 0 ? 0 : [...text].filter((gram) => value.has(gram)).length / text.size };
    });
  if (scored.length === 0) {
    return [];
  }
  const best = Math.max(...scored.map((value) => value.score));
  return scored.filter((value) => value.score >= STALE_MIN_OVERLAP || value.score === best).map((value) => value.turnId);
}

function bigrams(text) {
  const compact = text.replace(PUNCTUATION, "").replace(SPEAKER, "");
  const grams = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

function unique(values) {
  return [...new Set(values)];
}

function parseTime(value, turnId) {
  const stamp = String(value).split("->")[0].trim();
  const parsed = Date.parse(stamp);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unparsed time ${value} on ${turnId}`);
  }
  return new Date(parsed).toISOString();
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
