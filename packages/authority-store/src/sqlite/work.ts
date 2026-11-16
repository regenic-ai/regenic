import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Recipe,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkRunStartCommand,
  WorkRunStartReplay,
  CancellationJob,
  ClaimCancellationJobs,
  CommitCancellationJobObservation,
  CommitCancellationJobObservationResult,
  RetryCancellationJob,
  RetryCancellationJobResult,
  RenewCancellationJob,
  SettleCancellationJob,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
  WorkDelivery,
  ExecutorInstallation,
  SearchAnswerRecord,
} from "@regenic/domain";
import {
  conversationId,
  isWorkTriggerDecision,
  isFinishedWorkTriggerDecision,
  recipeTriggerOf,
  isRecipeTriggerKind,
  pullScheduleColumns,
  pullScheduleFromColumns,
  isWorkDeliveryStatus,
  isWorkWriteBackState,
  type WorkItemStatus,
  prepareWorkObservation,
  prepareCancellationJobObservation,
  prepareWorkAcknowledgment,
  assertWorkAcknowledgmentAttentionBinding,
  sameWorkAcknowledgmentCommand,
  workDeliveryLifecycleEvent,
  workObservationLifecycleEvents,
  workRunStartLifecycleEvent,
  assertWorkItemVersionWrite,
  assertWorkItemStatusWrite,
  assertWorkRunExecutionIdentityWrite,
  assertWorkRunStartStateWrite,
  assertWorkRunStatusWrite,
  assertWorkRunVersionWrite,
  assertWorkRunWrite,
  canClaimWorkRunStartItem,
  prepareWorkRunStartCheckpoint,
  prepareWorkRunStartFailure,
  prepareWorkDismissal,
  sameWorkDismissalCommand,
  sameWorkRunStartCommand,
  sameWorkDeliveryRetryCommand,
  workRunStartCommand,
  prepareWorkItemCreation,
  prepareWorkItemObservation,
  workItemObservationLifecycleEvent,
  type WorkItemCreation,
  type WorkItemCreationResult,
  type WorkItemObservation,
  type WorkItemObservationResult,
  prepareWorkItemCreationAbort,
  type WorkItemCreationAbort,
  type WorkItemCreationAbortResult,
  type WorkDismissal,
  type WorkDismissalResult,
  type WorkAcknowledgment,
  type WorkAcknowledgmentResult,
  type WorkRunStartFailure,
  type WorkRunStartFailureResult,
  type WorkRunStartCheckpoint,
  type WorkRunStartCheckpointResult,
  assertWorkDeliveryWrite,
  planWorkDeliveryCommand,
  canonicalContextJson,
  automaticWorkCompletionReady,
  type CommitWorkObservation,
  type CommitWorkObservationResult,
} from "@regenic/domain";
import {
  hasCurrentWorkForThread,
  hasUnfinishedWorkForThread,
  putConversationPrefUnlocked,
  refreshThreadHeadWithinTransaction,
  setConversationPolicyVisibilityUnlocked,
} from "./inbox";
import {
  claimCancellationJobs as claimJobs,
  enqueueCancellationJob,
  getCancellationJob,
  listCancellationJobs as listJobs,
  retryCancellationJob as retryJob,
  renewCancellationJob as renewJob,
  settleCancellationJob as settleJob,
} from "./lifecycle-jobs";

export async function listRecipes(db: Database.Database, orgId: string): Promise<Recipe[]> {
    const rows = db
      .prepare(
        `SELECT * FROM recipes WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as RecipeRow[];
    return rows.map(toRecipe);
  }

export async function getRecipe(db: Database.Database, orgId: string, id: string): Promise<Recipe | null> {
    const row = db
      .prepare(`SELECT * FROM recipes WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as RecipeRow | undefined;
    return row ? toRecipe(row) : null;
  }

export async function putRecipe(db: Database.Database, recipe: Recipe): Promise<Recipe> {
    writeRecipe(db, recipe);
    return recipe;
  }

export async function putRecipeIfUnchanged(
  db: Database.Database,
  input: import("@regenic/domain").RecipeWrite,
): Promise<import("@regenic/domain").RecipeWriteResult> {
  if (
    input.expected_recipe &&
    (input.expected_recipe.id !== input.recipe.id ||
      input.expected_recipe.org_id !== input.recipe.org_id)
  ) {
    return { outcome: "conflict" };
  }
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`)
      .get(input.recipe.id) as RecipeRow | undefined;
    const current = row ? toRecipe(row) : null;
    if (
      input.expected_recipe === null
        ? current !== null
        : !current || !isDeepStrictEqual(current, input.expected_recipe)
    ) {
      return { outcome: "conflict" as const };
    }
    if (!writeRecipe(db, input.recipe, input.expected_recipe === null)) {
      return { outcome: "conflict" as const };
    }
    return { outcome: "applied" as const, recipe: input.recipe };
  }).immediate();
}

export async function advanceRecipePullSchedule(
  db: Database.Database,
  input: { expected_recipe: Recipe; next_run_at: string; updated_at: string },
): Promise<boolean> {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM recipes WHERE org_id = ? AND id = ?`)
      .get(input.expected_recipe.org_id, input.expected_recipe.id) as RecipeRow | undefined;
    if (!row || !isDeepStrictEqual(toRecipe(row), input.expected_recipe)) {
      return false;
    }
    db.prepare(`UPDATE recipes SET next_run_at = ?, updated_at = ? WHERE org_id = ? AND id = ?`)
      .run(
        input.next_run_at,
        input.updated_at,
        input.expected_recipe.org_id,
        input.expected_recipe.id,
      );
    return true;
  }).immediate();
}

function writeRecipe(db: Database.Database, recipe: Recipe, insertOnly = false): boolean {
    const trigger = recipeTriggerOf(recipe);
    const pull = pullScheduleColumns(trigger);
    const result = db
      .prepare(
        `
          INSERT INTO recipes (
            id, org_id, name, match_json, executor_type, executor_config_json,
            can_write_back, include_context, enabled, trigger_kind,
            trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone,
            trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at,
            write_back_thread_id, hide_on_success
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO ${insertOnly ? "NOTHING" : `UPDATE SET
            name = excluded.name,
            match_json = excluded.match_json,
            executor_type = excluded.executor_type,
            executor_config_json = excluded.executor_config_json,
            can_write_back = excluded.can_write_back,
            write_back_thread_id = excluded.write_back_thread_id,
            include_context = excluded.include_context,
            enabled = excluded.enabled,
            trigger_kind = excluded.trigger_kind,
            trigger_interval_ms = excluded.trigger_interval_ms,
            trigger_at_minute = excluded.trigger_at_minute,
            trigger_weekdays = excluded.trigger_weekdays,
            trigger_timezone = excluded.trigger_timezone,
            trigger_coalesce = excluded.trigger_coalesce,
            max_concurrent = excluded.max_concurrent,
            next_run_at = excluded.next_run_at,
            hide_on_success = excluded.hide_on_success,
            updated_at = excluded.updated_at`}
        `,
      )
      .run(
        recipe.id,
        recipe.org_id,
        recipe.name,
        JSON.stringify(recipe.match),
        recipe.executor_type,
        JSON.stringify(recipe.executor_config),
        recipe.can_write_back ? 1 : 0,
        recipe.include_context ? 1 : 0,
        recipe.enabled ? 1 : 0,
        trigger.kind,
        pull.interval_ms,
        pull.at_minute,
        pull.weekdays,
        pull.timezone,
        trigger.kind === "push" && trigger.coalesce !== false ? 1 : 0,
        recipe.max_concurrent ?? null,
        recipe.next_run_at ?? null,
        recipe.created_at,
        recipe.updated_at,
        recipe.write_back_thread_id ?? null,
        recipe.hide_on_success === false ? 0 : 1,
      );
    return result.changes > 0;
  }

export async function deleteRecipe(db: Database.Database, orgId: string, id: string): Promise<boolean> {
    
    const result = db
      .prepare(`DELETE FROM recipes WHERE org_id = ? AND id = ?`)
      .run(orgId, id);
    return result.changes > 0;
  }

export async function listWorkItems(db: Database.Database, orgId: string, options?: { statuses?: readonly WorkItemStatus[] }): Promise<WorkItem[]> {
    const statuses = options?.statuses;
    const rows = statuses?.length
      ? (db
          .prepare(
            `SELECT * FROM work_items WHERE org_id = ? AND status IN (${statuses.map(() => "?").join(", ")}) ORDER BY updated_at DESC, id`,
          )
          .all(orgId, ...statuses) as WorkItemRow[])
      : (db
          .prepare(
            `SELECT * FROM work_items WHERE org_id = ? ORDER BY updated_at DESC, id`,
          )
          .all(orgId) as WorkItemRow[]);
    return rows.map(toWorkItem);
  }

export async function getWorkItem(db: Database.Database, orgId: string, id: string): Promise<WorkItem | null> {
    const row = db
      .prepare(`SELECT * FROM work_items WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

export async function getWorkItemByThread(db: Database.Database, orgId: string, threadId: string): Promise<WorkItem | null> {
    const row = db
      .prepare(
        `SELECT * FROM work_items WHERE org_id = ? AND thread_id = ?
         ORDER BY CASE WHEN status IN ('open', 'running', 'waiting_human') THEN 0 ELSE 1 END,
                  created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(orgId, threadId) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

export async function getWorkItemByUnitKey(db: Database.Database, orgId: string, threadId: string, unitKey: string): Promise<WorkItem | null> {
    const row = db
      .prepare(
        `SELECT * FROM work_items WHERE org_id = ? AND thread_id = ? AND unit_key = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(orgId, threadId, unitKey) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

async function putWorkItem(db: Database.Database, item: WorkItem): Promise<WorkItem> {
    return db.transaction(() => {
      const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(item.id) as WorkItemRow | undefined;
      const current = row ? toWorkItem(row) : undefined;
      assertWorkItemVersionWrite(item, current);
      assertWorkItemStatusWrite(item, current);
      return writeWorkItem(db, item, true);
    }).immediate();
  }

export async function createWorkItem(db: Database.Database, input: WorkItemCreation): Promise<WorkItemCreationResult> {
  return db.transaction((): WorkItemCreationResult => {
    const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(input.recipe.id) as RecipeRow | undefined;
    const transition = input.search_answer_transition;
    const previousAnswer = transition ? db.prepare("SELECT * FROM search_answers WHERE id = ?")
      .get(transition.expected_answer.id) as SearchAnswerRow | undefined : undefined;
    const previousItem = transition ? db.prepare("SELECT * FROM work_items WHERE id = ?")
      .get(transition.expected_item.id) as WorkItemRow | undefined : undefined;
    const previousRun = transition ? db.prepare("SELECT * FROM work_runs WHERE id = ?")
      .get(transition.expected_run.id) as WorkRunRow | undefined : undefined;
    const result = prepareWorkItemCreation(input, {
      item_exists: Boolean(db.prepare("SELECT id FROM work_items WHERE id = ?").get(input.item.id)),
      recipe: recipe ? toRecipe(recipe) : null,
      search_answer_exists: input.search_answer
        ? Boolean(db.prepare("SELECT id FROM search_answers WHERE id = ?").get(input.search_answer.id)) : false,
      search_answer: previousAnswer ? toSearchAnswer(previousAnswer) : null,
      answer_item: previousItem ? toWorkItem(previousItem) : null,
      answer_run: previousRun ? toWorkRun(previousRun) : null,
    });
    if (result.outcome !== "applied") return result;
    writeRecipe(db, result.recipe);
    writeWorkItem(db, result.item);
    const savedItem = db.prepare("SELECT * FROM work_items WHERE id = ?").get(result.item.id) as WorkItemRow | undefined;
    const savedRecipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(result.recipe.id) as RecipeRow | undefined;
    if (!savedRecipe || !savedItem) throw new Error("Created work disappeared inside its transaction");
    const answer = result.search_answer;
    const savedAnswer = answer ? db.prepare(`INSERT INTO search_answers (
      id, org_id, work_item_id, query, event_ids_json, scope_json, outcome, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ${transition ? `ON CONFLICT(id) DO UPDATE SET
      work_item_id = excluded.work_item_id, scope_json = excluded.scope_json,
      updated_at = excluded.updated_at` : ""}
    RETURNING *`).get(
      answer.id, answer.org_id, answer.work_item_id, answer.query, JSON.stringify(answer.event_ids),
      answer.scope ? JSON.stringify(answer.scope) : null,
      answer.created_at, answer.updated_at,
    ) as SearchAnswerRow | undefined : undefined;
    if (answer && !savedAnswer) throw new Error("Created search answer disappeared inside its transaction");
    return {
      outcome: "applied", item: toWorkItem(savedItem), recipe: toRecipe(savedRecipe),
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
  }).immediate();
}

export async function observeWorkItem(
  db: Database.Database,
  input: WorkItemObservation,
): Promise<WorkItemObservationResult> {
  return db.transaction(() => observeWorkItemUnlocked(db, input)).immediate();
}

export function observeWorkItemUnlocked(
  db: Database.Database,
  input: WorkItemObservation,
): WorkItemObservationResult {
  const orgId = input.item.org_id;
  const expected = input.expected_item;
  const expectedRow = expected
    ? db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?").get(
        orgId, expected.id,
      ) as WorkItemRow | undefined
    : undefined;
  const currentRow = db.prepare("SELECT * FROM work_items WHERE id = ?").get(
    input.item.id,
  ) as WorkItemRow | undefined;
  const unitExists = Boolean(db.prepare(`SELECT id FROM work_items
    WHERE org_id = ? AND thread_id = ? AND unit_key = ? AND id <> ? LIMIT 1`)
    .get(orgId, input.item.thread_id, input.item.unit_key, input.item.id));
  const trigger = input.item.head_event_id
    ? db.prepare(`SELECT e.id, e.org_id, e.source, e.external_id, e.thread_id,
        e.operation, d.disposition, d.reason_codes_json
        FROM events e LEFT JOIN message_dispositions d ON d.event_id = e.id
        WHERE e.id = ? AND EXISTS (
          SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
        )`)
        .get(input.item.head_event_id) as {
          id: string;
          org_id: string;
          source: string;
          external_id: string;
          thread_id: string | null;
          operation: string;
          disposition: string | null;
          reason_codes_json: string;
        } | undefined
    : undefined;
  const triggerRecipe = trigger?.disposition === "pending" && input.item.recipe_id
    ? db.prepare("SELECT * FROM recipes WHERE org_id = ? AND id = ?")
      .get(orgId, input.item.recipe_id) as RecipeRow | undefined
    : undefined;
  const triggerIsCurrentWork = Boolean(
    trigger &&
    trigger.org_id === orgId &&
    trigger.operation !== "tombstone" &&
    isWorkTriggerDecision(trigger.disposition,
      trigger.reason_codes_json ? JSON.parse(trigger.reason_codes_json) : [],
      input.item, triggerRecipe ? toRecipe(triggerRecipe) : null) &&
    (trigger.thread_id ?? conversationId(
      trigger.source,
      trigger.external_id,
      trigger.id,
    )) === input.item.thread_id,
  );
  const result = prepareWorkItemObservation(input, {
    expected_item: expectedRow ? toWorkItem(expectedRow) : null,
    current_item: currentRow ? toWorkItem(currentRow) : null,
    unit_exists: unitExists,
    trigger_is_current_work: triggerIsCurrentWork,
  });
  if (result.outcome !== "applied") return result;
  const saved = writeWorkItem(db, result.item, true);
  const savedRow = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
    .get(orgId, saved.id) as WorkItemRow | undefined;
  if (!savedRow) throw new Error("Observed work item disappeared inside its transaction");
  const savedItem = toWorkItem(savedRow);
  const event = workItemObservationLifecycleEvent(expected, savedItem);
  db.prepare(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
    randomUUID(), orgId, event.thread_id, event.aggregate_type, event.aggregate_id,
    event.aggregate_version, event.event_type, event.dedupe_key, JSON.stringify(event.payload),
    savedItem.updated_at, savedItem.updated_at,
  );
  return { outcome: "applied", item: savedItem };
}

export async function abortWorkItemCreation(db: Database.Database, input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult> {
  return db.transaction((): WorkItemCreationAbortResult => {
    const expected = input.expected_item;
    const item = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?").get(
      expected.org_id, expected.id,
    ) as WorkItemRow | undefined;
    const answer = db.prepare("SELECT * FROM search_answers WHERE org_id = ? AND work_item_id = ?").get(
      expected.org_id, expected.id,
    ) as SearchAnswerRow | undefined;
    const result = prepareWorkItemCreationAbort(input, {
      item: item ? toWorkItem(item) : null,
      has_run: Boolean(db.prepare("SELECT id FROM work_runs WHERE org_id = ? AND work_item_id = ? LIMIT 1")
        .get(expected.org_id, expected.id)),
      has_delivery: Boolean(db.prepare("SELECT id FROM work_deliveries WHERE org_id = ? AND work_item_id = ? LIMIT 1")
        .get(expected.org_id, expected.id)),
      search_answer: answer ? toSearchAnswer(answer) : null,
    });
    if (result.outcome !== "applied") return result;
    if (result.search_answer) db.prepare("DELETE FROM search_answers WHERE org_id = ? AND id = ?")
      .run(expected.org_id, result.search_answer.id);
    const deleted = db.prepare("DELETE FROM work_items WHERE org_id = ? AND id = ? RETURNING *")
      .get(expected.org_id, expected.id) as WorkItemRow | undefined;
    if (!deleted) throw new Error("Aborted work item disappeared inside its transaction");
    return { outcome: "applied", item: toWorkItem(deleted), ...(result.search_answer ? { search_answer: result.search_answer } : {}) };
  }).immediate();
}

function writeWorkItem(db: Database.Database, item: WorkItem, advanceVersion = false): WorkItem {
    const result = db
      .prepare(
        `
          INSERT INTO work_items (
            id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
            status, recipe_id, created_at, updated_at, current_run_id, version,
            visibility_intent_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id,
            unit_key = excluded.unit_key,
            head_event_id = excluded.head_event_id,
            record_class = excluded.record_class,
            thread_facet = excluded.thread_facet,
            status = excluded.status,
            recipe_id = excluded.recipe_id,
            updated_at = excluded.updated_at,
            current_run_id = work_items.current_run_id,
            version = ${advanceVersion ? "work_items.version + 1" : "excluded.version"}
          WHERE work_items.org_id = excluded.org_id
            AND work_items.thread_id = excluded.thread_id
            AND work_items.unit_key = excluded.unit_key
        `,
      )
      .run(
        item.id,
        item.org_id,
        item.thread_id,
        item.unit_key,
        item.head_event_id ?? null,
        item.record_class,
        item.thread_facet,
        item.status,
        item.recipe_id ?? null,
        item.created_at,
        item.updated_at,
        null,
        item.version ?? 0,
        item.visibility_intent_version ?? 0,
      );
    if (result.changes === 0) {
      throw new Error("Work item ID, organization, thread, and unit are immutable");
    }
    if (!advanceVersion) return item;
    const saved = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(item.org_id, item.id) as WorkItemRow | undefined;
    if (!saved) throw new Error("Work item disappeared inside its write");
    return toWorkItem(saved);
  }

export async function listWorkRuns(db: Database.Database, orgId: string, workItemId?: string): Promise<WorkRun[]> {
    const rows = workItemId
      ? (db
          .prepare(
            `SELECT * FROM work_runs WHERE org_id = ? AND work_item_id = ?
             ORDER BY updated_at DESC, id`,
          )
          .all(orgId, workItemId) as WorkRunRow[])
      : (db
          .prepare(
            `SELECT * FROM work_runs WHERE org_id = ? ORDER BY updated_at DESC, id`,
          )
          .all(orgId) as WorkRunRow[]);
    return rows.map(toWorkRun);
  }

export async function getWorkRun(db: Database.Database, orgId: string, id: string): Promise<WorkRun | null> {
    const row = db
      .prepare(`SELECT * FROM work_runs WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkRunRow | undefined;
    return row ? toWorkRun(row) : null;
  }

export async function getActiveWorkRun(db: Database.Database, orgId: string, workItemId: string): Promise<WorkRun | null> {
    const row = db
      .prepare(
        `SELECT r.* FROM work_runs r
         JOIN work_items w ON w.org_id = r.org_id AND w.id = r.work_item_id
           AND w.current_run_id = r.id
         WHERE r.org_id = ? AND r.work_item_id = ?
           AND r.status IN ('running', 'waiting_human')
         LIMIT 1`,
      )
      .get(orgId, workItemId) as WorkRunRow | undefined;
    return row ? toWorkRun(row) : null;
  }

export async function listHiddenExecutorThreadIds(db: Database.Database, orgId: string): Promise<string[]> {
    const rows = db
      .prepare(
        `
          SELECT DISTINCT r.agent_thread_id AS thread_id
          FROM work_runs r
          WHERE r.org_id = ?
            AND r.agent_thread_id IS NOT NULL
            AND r.agent_thread_id <> ''
            AND NOT EXISTS (
              SELECT 1 FROM work_items w
              WHERE w.org_id = r.org_id AND w.thread_id = r.agent_thread_id
            )
        `,
      )
      .all(orgId) as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

async function putWorkRun(db: Database.Database, run: WorkRun): Promise<WorkRun> {
    return db.transaction(() => {
      const row = db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
        .get(run.org_id, run.id) as WorkRunRow | undefined;
      const current = row ? toWorkRun(row) : undefined;
      assertWorkRunVersionWrite(run, current);
      assertWorkRunExecutionIdentityWrite(run, current);
      assertWorkRunStartStateWrite(run, current);
      assertWorkRunWrite(run, current);
      assertWorkRunStatusWrite(run, current);
      return writeWorkRun(db, run, true);
    }).immediate();
  }

export async function checkpointWorkRunStart(
  db: Database.Database, input: WorkRunStartCheckpoint,
): Promise<WorkRunStartCheckpointResult> {
  return db.transaction((): WorkRunStartCheckpointResult => {
    const orgId = input.expected_item.org_id;
    const item = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(orgId, input.expected_item.id) as WorkItemRow | undefined;
    const run = db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
      .get(orgId, input.expected_run.id) as WorkRunRow | undefined;
    const currentItem = item ? toWorkItem(item) : null;
    const result = prepareWorkRunStartCheckpoint(input, {
      item: currentItem, run: run ? toWorkRun(run) : null,
    });
    if (result.outcome !== "applied") return result;
    writeWorkRun(db, result.run);
    if (result.item.status !== currentItem?.status) writeWorkItem(db, result.item);
    const event = workRunStartLifecycleEvent(input, result.run);
    if (event) {
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        randomUUID(),
        orgId,
        event.thread_id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
        event.event_type,
        event.dedupe_key,
        JSON.stringify(event.payload),
        input.now,
        input.now,
      );
    }
    if (result.cancellation_requested) {
      enqueueCancellationJob(db, {
        run: result.run,
        thread_id: result.item.thread_id,
        now: input.now,
      });
    }
    return result;
  }).immediate();
}

export async function commitWorkObservation(
  db: Database.Database,
  input: CommitWorkObservation,
): Promise<CommitWorkObservationResult> {
  return db.transaction((): CommitWorkObservationResult => {
    const orgId = input.expected_item.org_id;
    const item = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(orgId, input.expected_item.id) as WorkItemRow | undefined;
    const run = db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
      .get(orgId, input.expected_run.id) as WorkRunRow | undefined;
    const delivery = db.prepare(`SELECT * FROM work_deliveries WHERE org_id = ? AND work_item_id = ?
      AND (run_id = ? OR (run_id IS NULL AND ? IS NULL))`)
      .get(orgId, input.expected_item.id,
        input.expected_run.write_back_required === undefined ? null : input.expected_run.id,
        input.expected_run.write_back_required === undefined ? null : input.expected_run.id) as WorkDeliveryRow | undefined;
    const prepared = prepareWorkObservation(input, {
      item: item ? toWorkItem(item) : null,
      run: run ? toWorkRun(run) : null,
      delivery: delivery ? toWorkDelivery(delivery) : null,
    });
    if (prepared.outcome !== "applied") return prepared;
    writeWorkRun(db, prepared.transition.run);
    if (prepared.delivery) writeWorkDelivery(db, prepared.delivery, true);
    if (prepared.transition.item.status !== input.expected_item.status) {
      writeWorkItem(db, prepared.transition.item);
    }
    for (const event of workObservationLifecycleEvents(
      input, prepared.transition, delivery ? toWorkDelivery(delivery) : null, prepared.delivery,
    )) {
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        randomUUID(),
        orgId,
        event.thread_id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
        event.event_type,
        event.dedupe_key,
        JSON.stringify(event.payload),
        input.now,
        input.now,
      );
    }
    if (input.expected_run.status !== "completed" && prepared.transition.run.status === "completed") {
      finishSuccessfulWorkWithinTransaction(db, orgId, input.expected_item.id, input.expected_run.id, input.now);
    }
    return { outcome: "applied", transition: prepared.transition };
  }).immediate();
}

function writeWorkRun(db: Database.Database, run: WorkRun, advanceVersion = false): WorkRun {
    const current = db.prepare("SELECT * FROM work_runs WHERE id = ?").get(run.id) as WorkRunRow | undefined;
    assertWorkRunWrite(run, current ? toWorkRun(current) : undefined);
    const row = db
      .prepare(
        `
          INSERT INTO work_runs (
            id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
            agent_thread_id, status, start_state, result_json, created_at, updated_at, version,
            write_back_required, write_back_target_json, trigger_kind, executor_config_json,
            include_context, completion_policy_version, hide_on_success
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            recipe_id = excluded.recipe_id,
            executor_type = excluded.executor_type,
            external_run_id = excluded.external_run_id,
            agent_thread_id = excluded.agent_thread_id,
            status = excluded.status,
            start_state = excluded.start_state,
            result_json = excluded.result_json,
            updated_at = excluded.updated_at,
            version = ${advanceVersion ? "work_runs.version + 1" : "excluded.version"}
          WHERE work_runs.org_id = excluded.org_id
            AND work_runs.work_item_id = excluded.work_item_id
            AND work_runs.recipe_id = excluded.recipe_id
            AND work_runs.executor_type = excluded.executor_type
            AND work_runs.write_back_required IS excluded.write_back_required
            AND work_runs.write_back_target_json IS excluded.write_back_target_json
            AND work_runs.trigger_kind IS excluded.trigger_kind
            AND work_runs.executor_config_json IS excluded.executor_config_json
            AND work_runs.include_context IS excluded.include_context
            AND work_runs.completion_policy_version IS excluded.completion_policy_version
            AND work_runs.hide_on_success IS excluded.hide_on_success
          RETURNING *
        `,
      )
      .get(
        run.id,
        run.org_id,
        run.work_item_id,
        run.recipe_id,
        run.executor_type,
        run.external_run_id ?? null,
        run.agent_thread_id ?? null,
        run.status,
        run.start_state ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.created_at,
        run.updated_at,
        run.version ?? 0,
        run.write_back_required === undefined ? null : Number(run.write_back_required),
        run.write_back_target ? canonicalContextJson(run.write_back_target) : null,
        run.trigger_kind ?? null,
        run.executor_config ? canonicalContextJson(run.executor_config) : null,
        run.include_context === undefined ? null : Number(run.include_context),
        run.completion_policy_version ?? null,
        run.hide_on_success === undefined ? null : Number(run.hide_on_success),
      ) as WorkRunRow | undefined;
    if (!row) throw new Error("Work run identity and write-back snapshot are immutable");
    return toWorkRun(row);
  }

export async function dismissWorkItem(db: Database.Database, input: WorkDismissal): Promise<WorkDismissalResult> {
  return db.transaction((): WorkDismissalResult => {
    const { org_id: orgId, id } = input.expected_item;
    if (input.command_id !== undefined) {
      const event = db.prepare(`SELECT aggregate_type, aggregate_id, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
        .get(orgId, input.command_id) as
        | { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string }
        | undefined;
      if (event) {
        const payload = JSON.parse(event.payload_json) as {
          command?: unknown;
          item?: WorkItem;
        };
        if (
          event.aggregate_type !== "work_item" ||
          event.aggregate_id !== id ||
          event.event_type !== "work_item_transitioned" ||
          !sameWorkDismissalCommand(payload.command, input) ||
          !payload.item
        ) {
          return { outcome: "conflict", reason: "stale_dismissal" };
        }
        return { outcome: "replayed", item: payload.item };
      }
    }
    const item = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(orgId, id) as WorkItemRow | undefined;
    const run = item?.current_run_id
      ? db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
        .get(orgId, item.current_run_id) as WorkRunRow | undefined : undefined;
    const deliveries = db.prepare(`SELECT * FROM work_deliveries
      WHERE org_id = ? AND work_item_id = ? AND status <> 'acked' ORDER BY id`).all(orgId, id) as WorkDeliveryRow[];
    const searchAnswer = input.search_answer_timeout
      ? db.prepare("SELECT * FROM search_answers WHERE org_id = ? AND id = ?")
        .get(orgId, input.search_answer_timeout.id) as SearchAnswerRow | undefined : undefined;
    const result = prepareWorkDismissal(input, {
      item: item ? toWorkItem(item) : null, run: run ? toWorkRun(run) : null,
      deliveries: deliveries.map(toWorkDelivery),
      search_answer: searchAnswer ? toSearchAnswer(searchAnswer) : null,
    });
    if (result.outcome !== "applied") return result;
    const savedDeliveries = result.deliveries.map((delivery) => writeWorkDelivery(db, delivery, true));
    const savedItem = db.prepare(`UPDATE work_items SET status = 'skipped', version = ?, updated_at = ?
      WHERE org_id = ? AND id = ? RETURNING *`)
      .get(result.item.version, input.now, orgId, id) as WorkItemRow | undefined;
    if (!savedItem) throw new Error("Dismissed work item disappeared inside its transaction");
    const savedWorkItem = toWorkItem(savedItem);
    if (input.command_id !== undefined && input.issued_at !== undefined) {
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, 'work_item', ?, ?, 'work_item_transitioned', ?, ?, 1, ?, ?, ?)`)
        .run(
          randomUUID(),
          orgId,
          savedWorkItem.thread_id,
          id,
          savedWorkItem.version ?? 0,
          input.command_id,
          JSON.stringify(["work_item", id, savedWorkItem.version ?? 0, "work_item_transitioned"]),
          JSON.stringify({
            command: {
              work_item_id: id,
              expected_version: input.expected_version ?? input.expected_item.version ?? 0,
              fold_visibility: input.fold_visibility !== false,
              issued_at: input.issued_at,
            },
            before_status: input.expected_item.status,
            after_status: savedWorkItem.status,
            item: savedWorkItem,
          }),
          input.issued_at,
          input.now,
        );
    }
    const savedAnswer = result.search_answer
      ? db.prepare(`UPDATE search_answers SET outcome = ?, updated_at = ?
        WHERE org_id = ? AND id = ? RETURNING *`)
        .get(result.search_answer.outcome, input.now, orgId, result.search_answer.id) as SearchAnswerRow | undefined : undefined;
    if (result.search_answer && !savedAnswer) throw new Error("Terminal search answer disappeared inside its transaction");
    if (result.run) {
      enqueueCancellationJob(db, {
        run: result.run,
        thread_id: savedWorkItem.thread_id,
        now: input.now,
      });
    }
    if (input.fold_visibility !== false) {
      foldWorkThreadWithinTransaction(
        db, orgId, savedWorkItem.thread_id,
        savedWorkItem.visibility_intent_version ?? 0, input.now,
        savedWorkItem.head_event_id,
      );
    }
    return {
      outcome: "applied", item: savedWorkItem, run: result.run, deliveries: savedDeliveries,
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
  }).immediate();
}

function foldWorkThreadWithinTransaction(
  db: Database.Database,
  orgId: string,
  threadId: string,
  expectedVisibilityVersion: number | undefined,
  now: string,
  dismissedTriggerEventId?: string,
): void {
  const pref = db.prepare(`SELECT visibility_version FROM conversation_prefs
    WHERE org_id = ? AND thread_id = ?`).get(orgId, threadId) as
    | { visibility_version: number }
    | undefined;
  setConversationPolicyVisibilityUnlocked(db, {
    org_id: orgId,
    thread_id: threadId,
    hidden: true,
    expected_visibility_version: expectedVisibilityVersion ?? pref?.visibility_version ?? 0,
    updated_at: now,
    ...(dismissedTriggerEventId
      ? { fold_excluded_current_work_event_id: dismissedTriggerEventId }
      : {}),
  });
}

function finishSuccessfulWorkWithinTransaction(
  db: Database.Database, orgId: string, workItemId: string, runId: string, now: string,
): void {
  const itemRow = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
    .get(orgId, workItemId) as WorkItemRow | undefined;
  if (!itemRow || itemRow.current_run_id !== runId) return;
  const runRow = db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
    .get(orgId, itemRow.current_run_id) as WorkRunRow | undefined;
  const deliveryRow = db.prepare("SELECT * FROM work_deliveries WHERE org_id = ? AND run_id = ?")
    .get(orgId, itemRow.current_run_id) as WorkDeliveryRow | undefined;
  const item = toWorkItem(itemRow);
  const run = runRow ? toWorkRun(runRow) : null;
  if (!run || !automaticWorkCompletionReady(item, run, deliveryRow ? toWorkDelivery(deliveryRow) : null)) return;
  const dedupeKey = JSON.stringify(["source_event", item.head_event_id, "work_completed", run.id, 1]);
  if (db.prepare("SELECT 1 FROM conversation_lifecycle_events WHERE org_id = ? AND dedupe_key = ?")
    .get(orgId, dedupeKey)) return;
  const trigger = db.prepare(`SELECT d.version, d.disposition, d.reason_codes_json FROM message_dispositions d
    JOIN events e ON e.id = d.event_id AND e.org_id = d.org_id
    WHERE d.org_id = ? AND d.event_id = ?
      AND e.operation <> 'tombstone'
      AND COALESCE(e.thread_id, conversation_id(e.source, e.external_id, e.id)) = ?
      AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id)`)
    .get(orgId, item.head_event_id, item.thread_id) as {
      version: number; disposition: string; reason_codes_json: string;
    } | undefined;
  if (!trigger || !isFinishedWorkTriggerDecision(trigger.disposition,
    JSON.parse(trigger.reason_codes_json), item, run)) return;
  const reasonCodes = [...new Set([
    ...JSON.parse(trigger.reason_codes_json) as string[], "work_completed",
  ])];
  db.prepare(`UPDATE message_dispositions SET disposition = 'outside_current_work',
    version = version + 1, reason_codes_json = ?, decided_at = ? WHERE org_id = ? AND event_id = ?`)
    .run(JSON.stringify(reasonCodes), now, orgId, item.head_event_id);
  refreshThreadHeadWithinTransaction(db, orgId, item.thread_id);
  const lifecycleVersion = db.prepare(`SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS version
    FROM conversation_lifecycle_events WHERE org_id = ? AND aggregate_type = 'source_event'
      AND aggregate_id = ?`).get(orgId, item.head_event_id) as { version: number };
  db.prepare(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, 'source_event', ?, ?, 'current_work_changed', ?, 1, ?, ?, ?)`)
    .run(randomUUID(), orgId, item.thread_id, item.head_event_id, lifecycleVersion.version,
      dedupeKey,
      JSON.stringify({ work_item_id: item.id, run_id: run.id, completion_policy_version: 1,
        disposition_version: trigger.version + 1,
        disposition: "outside_current_work", reason: "work_completed" }), now, now);
  if (run.hide_on_success !== false) {
    foldWorkThreadWithinTransaction(db, orgId, item.thread_id, item.visibility_intent_version ?? 0, now);
  }
}

export async function claimCancellationJobs(
  db: Database.Database,
  input: ClaimCancellationJobs,
): Promise<CancellationJob[]> {
  return claimJobs(db, input);
}

export async function renewCancellationJob(
  db: Database.Database,
  input: RenewCancellationJob,
): Promise<boolean> {
  return renewJob(db, input);
}

export async function settleCancellationJob(
  db: Database.Database,
  input: SettleCancellationJob,
): Promise<boolean> {
  return settleJob(db, input);
}

export async function listCancellationJobs(
  db: Database.Database,
  orgId: string,
  limit?: number,
  statuses?: CancellationJob["status"][],
): Promise<CancellationJob[]> {
  return listJobs(db, orgId, limit, statuses);
}

export async function retryCancellationJob(
  db: Database.Database,
  input: RetryCancellationJob,
): Promise<RetryCancellationJobResult> {
  return retryJob(db, input);
}

export async function commitCancellationJobObservation(
  db: Database.Database,
  input: CommitCancellationJobObservation,
): Promise<CommitCancellationJobObservationResult> {
  return db.transaction((): CommitCancellationJobObservationResult => {
    const job = getCancellationJob(db, input.org_id, input.id);
    if (!hasCancellationJobLease(job, input)) return { outcome: "conflict" };
    const runRow = db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
      .get(input.org_id, input.expected_run.id) as WorkRunRow | undefined;
    const run = runRow ? toWorkRun(runRow) : null;
    const itemRow = run ? db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(input.org_id, run.work_item_id) as WorkItemRow | undefined : undefined;
    const item = itemRow ? toWorkItem(itemRow) : null;
    if (!run || !item || item.status !== "skipped" || item.current_run_id !== run.id
      || job.run_id !== run.id || run.work_item_id !== item.id) return { outcome: "conflict" };
    const prepared = prepareCancellationJobObservation(input, run);
    if (prepared.outcome === "conflict") return prepared;
    if (prepared.outcome === "already_terminal") {
      const settled = db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
        lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, outcome_code = 'already_finished',
        completed_at = ?, updated_at = ?
        WHERE org_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
          AND claim_token = ? AND lease_expires_at > ?`)
        .run(input.now, input.now, input.org_id, input.id, input.owner, input.claim_token, input.now);
      return settled.changes === 1 ? prepared : { outcome: "conflict" };
    }
    const savedRun = writeWorkRun(db, prepared.run, true);
    db.prepare(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES (?, ?, ?, 'work_run', ?, ?, 'work_run_transitioned', ?, 1, ?, ?, ?)`)
      .run(
        randomUUID(), input.org_id, item.thread_id, savedRun.id, savedRun.version ?? 0,
        JSON.stringify(["work_run", savedRun.id, savedRun.version ?? 0, "work_run_transitioned"]),
        JSON.stringify({
          work_item_id: item.id,
          run_id: savedRun.id,
          from_status: run.status,
          to_status: savedRun.status,
          reason: "cancellation_job",
        }),
        input.now, input.now,
      );
    const settled = db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = NULL, outcome_code = ?, completed_at = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
        AND claim_token = ? AND lease_expires_at > ?`)
      .run(`observed_${savedRun.status}`, input.now, input.now, input.org_id,
        input.id, input.owner, input.claim_token, input.now);
    if (settled.changes !== 1) throw new Error("Cancellation job lease changed during observation commit");
    return { outcome: "applied", run: savedRun };
  }).immediate();
}

function hasCancellationJobLease(
  job: CancellationJob | null,
  input: { owner: string; claim_token: string; now: string },
): job is CancellationJob {
  return Boolean(job?.status === "running" && job.lease_owner === input.owner
    && job.claim_token === input.claim_token && job.lease_expires_at
    && job.lease_expires_at > input.now);
}

export async function acknowledgeWorkResult(
  db: Database.Database,
  input: WorkAcknowledgment,
): Promise<WorkAcknowledgmentResult> {
  assertWorkAcknowledgmentAttentionBinding(input);
  return db.transaction((): WorkAcknowledgmentResult => {
    const orgId = input.expected_item.org_id;
    if (input.conversation_attention) {
      putConversationPrefUnlocked(db, input.conversation_attention);
    }
    const priorEvent = db.prepare(`SELECT aggregate_type, aggregate_id, event_type, payload_json
      FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
      .get(orgId, input.command_id) as
      | { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string }
      | undefined;
    if (priorEvent) {
      const payload = JSON.parse(priorEvent.payload_json) as { command?: unknown; item?: WorkItem };
      if (priorEvent.aggregate_type !== "work_item" || priorEvent.aggregate_id !== input.expected_item.id
        || priorEvent.event_type !== "work_acknowledged"
        || !sameWorkAcknowledgmentCommand(payload.command, input) || !payload.item) {
        return { outcome: "conflict", reason: "command_conflict" };
      }
      return { outcome: "replayed", item: payload.item };
    }
    const row = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(orgId, input.expected_item.id) as WorkItemRow | undefined;
    const item = row ? toWorkItem(row) : null;
    const runRow = item?.current_run_id
      ? db.prepare("SELECT * FROM work_runs WHERE org_id = ? AND id = ?")
        .get(orgId, item.current_run_id) as WorkRunRow | undefined : undefined;
    const deliveryRow = db.prepare(`SELECT * FROM work_deliveries
      WHERE org_id = ? AND work_item_id = ? AND run_id = ?`)
      .get(orgId, input.expected_item.id, input.run_id) as WorkDeliveryRow | undefined;
    const triggerRow = db.prepare(`SELECT e.thread_id, e.source, e.external_id, d.disposition, d.layer,
        d.reason_codes_json, d.score
      FROM events e JOIN message_dispositions d ON d.event_id = e.id
      WHERE e.org_id = ? AND e.id = ? AND d.org_id = ?`)
      .get(orgId, input.trigger_event_id, orgId) as {
        thread_id: string | null; source: string; external_id: string; disposition: string; layer: string;
        reason_codes_json: string; score: number;
      } | undefined;
    const result = prepareWorkAcknowledgment(input, {
      item,
      run: runRow ? toWorkRun(runRow) : null,
      delivery: deliveryRow ? toWorkDelivery(deliveryRow) : null,
      trigger_is_current_work: Boolean(triggerRow && item
        && (triggerRow.thread_id ?? conversationId(triggerRow.source, triggerRow.external_id, input.trigger_event_id)) === item.thread_id
        && isFinishedWorkTriggerDecision(triggerRow.disposition,
          JSON.parse(triggerRow.reason_codes_json), item, runRow ? toWorkRun(runRow) : null)),
      trigger_is_completed_work: Boolean(triggerRow && item
        && (triggerRow.thread_id ?? conversationId(triggerRow.source, triggerRow.external_id, input.trigger_event_id)) === item.thread_id
        && triggerRow.disposition === "outside_current_work"
        && (JSON.parse(triggerRow.reason_codes_json) as string[]).includes("work_completed")
        && automaticWorkCompletionReady(item, runRow ? toWorkRun(runRow) : null,
          deliveryRow ? toWorkDelivery(deliveryRow) : null)),
    });
    if (result.outcome !== "applied") return result;
    const reasonCodes = [...new Set([
      ...(triggerRow ? JSON.parse(triggerRow.reason_codes_json) as string[] : []),
      "result_acknowledged",
    ])];
    const dispositionChanged = db.prepare(`UPDATE message_dispositions SET disposition = 'outside_current_work',
      reason_codes_json = ?, decided_at = ?, version = version + 1
      WHERE org_id = ? AND event_id = ? AND disposition IN ('current_work', 'pending')`)
      .run(JSON.stringify(reasonCodes), input.now, orgId, input.trigger_event_id).changes > 0;
    refreshThreadHeadWithinTransaction(db, orgId, item!.thread_id);
    const savedRow = db.prepare(`UPDATE work_items SET acknowledged_run_id = ?, version = ?, updated_at = ?
      WHERE org_id = ? AND id = ? RETURNING *`)
      .get(input.run_id, result.item.version, input.now, orgId, input.expected_item.id) as WorkItemRow | undefined;
    if (!savedRow) throw new Error("Acknowledged work item disappeared inside its transaction");
    const savedItem = toWorkItem(savedRow);
    const remainingCurrentWork = hasCurrentWorkForThread(db, orgId, item!.thread_id);
    const unfinishedWork = hasUnfinishedWorkForThread(db, orgId, item!.thread_id);
    const unresolvedDelivery = db.prepare(`SELECT 1 FROM work_deliveries
      WHERE org_id = ? AND work_item_id IN (
        SELECT id FROM work_items WHERE org_id = ? AND thread_id = ?
      ) AND status <> 'acked' LIMIT 1`).get(orgId, orgId, item!.thread_id);
    const pref = db.prepare(`SELECT hidden, hidden_reason, visibility_version
      FROM conversation_prefs WHERE org_id = ? AND thread_id = ?`)
      .get(orgId, item!.thread_id) as {
        hidden: number; hidden_reason: string | null; visibility_version: number;
      } | undefined;
    const visibilityVersion = pref?.visibility_version ?? 0;
    const recipeVisibility = item?.recipe_id
      ? db.prepare("SELECT hide_on_success FROM recipes WHERE org_id = ? AND id = ?")
        .get(orgId, item.recipe_id) as { hide_on_success: number } | undefined
      : undefined;
    const hideOnSuccess = (runRow?.hide_on_success ?? recipeVisibility?.hide_on_success ?? 1) === 1;
    if (savedItem.status === "done" && dispositionChanged
      && hideOnSuccess
      && !remainingCurrentWork && !unfinishedWork && !unresolvedDelivery
      && visibilityVersion === (item!.visibility_intent_version ?? 0)
      && !(pref?.hidden === 1 && pref.hidden_reason !== "policy")) {
      const folded = putConversationPrefUnlocked(db, {
        org_id: orgId, thread_id: item!.thread_id, hidden: true,
        hidden_reason: "policy", updated_at: input.now,
      });
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, 'conversation', ?, ?, 'visibility_changed', NULL, ?, 1, ?, ?, ?)`)
        .run(
          randomUUID(), orgId, item!.thread_id, item!.thread_id, visibilityVersion,
          JSON.stringify(["conversation", item!.thread_id, "policy_fold", savedItem.id, savedItem.version]),
          JSON.stringify({ hidden: folded.hidden, hidden_reason: folded.hidden_reason, cause: "result_acknowledged" }),
          input.issued_at, input.now,
        );
    }
    if (dispositionChanged) db.prepare(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES (?, ?, ?, 'source_event', ?, ?, 'current_work_changed', NULL, ?, 1, ?, ?, ?)`)
      .run(
        randomUUID(), orgId, item!.thread_id, input.trigger_event_id, savedItem.version ?? 0,
        JSON.stringify(["source_event", input.trigger_event_id, savedItem.version ?? 0, "current_work_changed"]),
        JSON.stringify({ work_item_id: savedItem.id, disposition: "outside_current_work", reason: "result_acknowledged" }),
        input.issued_at, input.now,
      );
    db.prepare(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES (?, ?, ?, 'work_item', ?, ?, 'work_acknowledged', ?, ?, 1, ?, ?, ?)`).run(
      randomUUID(), orgId, savedItem.thread_id, savedItem.id, savedItem.version ?? 0,
      input.command_id,
      JSON.stringify(["work_item", savedItem.id, savedItem.version ?? 0, "work_acknowledged"]),
      JSON.stringify({ command: input, item: savedItem }),
      input.issued_at, input.now,
    );
    return { outcome: "applied", item: savedItem };
  }).immediate();
}

export async function recordWorkRunStartFailure(
  db: Database.Database, input: WorkRunStartFailure,
): Promise<WorkRunStartFailureResult> {
  return db.transaction((): WorkRunStartFailureResult => {
    const { run } = input;
    const item = db.prepare("SELECT * FROM work_items WHERE org_id = ? AND id = ?")
      .get(run.org_id, run.work_item_id) as WorkItemRow | undefined;
    const result = prepareWorkRunStartFailure(input, {
      item: item ? toWorkItem(item) : null,
      recipe_exists: Boolean(db.prepare("SELECT id FROM recipes WHERE org_id = ? AND id = ?")
        .get(run.org_id, run.recipe_id)),
      active_run: Boolean(db.prepare(`SELECT id FROM work_runs WHERE org_id = ? AND work_item_id = ?
        AND status IN ('running', 'waiting_human') LIMIT 1`).get(run.org_id, run.work_item_id)),
      unresolved_delivery: Boolean(db.prepare(`SELECT id FROM work_deliveries
        WHERE org_id = ? AND work_item_id = ? AND status <> 'acked' LIMIT 1`).get(run.org_id, run.work_item_id)),
    });
    if (result.outcome !== "applied") return result;
    if (db.prepare("SELECT id FROM work_runs WHERE id = ?").get(run.id)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    const savedRun = writeWorkRun(db, result.run);
    const savedItem = db.prepare(`UPDATE work_items SET status = ?, current_run_id = ?, version = ?, updated_at = ?
      WHERE org_id = ? AND id = ? RETURNING *`).get(
      result.item.status, result.item.current_run_id ?? null, result.item.version,
      result.item.updated_at, run.org_id, run.work_item_id,
    ) as WorkItemRow | undefined;
    if (!savedItem) throw new Error("Work start failure item disappeared inside its transaction");
    return { outcome: "applied", item: toWorkItem(savedItem), run: savedRun };
  }).immediate();
}

export async function getWorkRunStartReplay(
  db: Database.Database,
  command: WorkRunStartCommand,
): Promise<WorkRunStartReplay> {
  const event = db.prepare(`SELECT aggregate_type, aggregate_id, event_type, payload_json
    FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
    .get(command.org_id, command.command_id) as
    | { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string }
    | undefined;
  if (!event) return { outcome: "not_found" };
  const payload = JSON.parse(event.payload_json) as { command?: unknown; run_id?: unknown };
  if (event.aggregate_type !== "work_item" || event.aggregate_id !== command.work_item_id
    || event.event_type !== "work_run_transitioned" || !sameWorkRunStartCommand(payload.command, command)
    || typeof payload.run_id !== "string") {
    return { outcome: "conflict" };
  }
  const run = await getWorkRun(db, command.org_id, payload.run_id);
  if (!run || run.work_item_id !== command.work_item_id) {
    throw new Error("Reserved work start command references a missing or mismatched run");
  }
  return { outcome: "replayed", run };
}

export async function claimWorkRunStart(db: Database.Database, input: WorkRunStartClaim): Promise<boolean> {
  const { run, max_concurrent } = input;
  return db.transaction(() => {
    const command = workRunStartCommand(input);
    if (command && db.prepare(
      "SELECT id FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?",
    ).get(command.org_id, command.command_id)) return false;
    const item = db.prepare(`
      SELECT w.* FROM work_items w JOIN recipes r ON r.org_id = w.org_id AND r.id = ?
      WHERE w.org_id = ? AND w.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM work_runs WHERE org_id = w.org_id AND work_item_id = w.id
            AND status IN ('running', 'waiting_human')
        )
    `).get(run.recipe_id, run.org_id, run.work_item_id) as WorkItemRow | undefined;
    if (!item) return false;
    if (input.expected_recipe !== undefined) {
      if (
        input.expected_recipe.id !== run.recipe_id ||
        input.expected_recipe.org_id !== run.org_id
      ) {
        return false;
      }
      const recipe = db.prepare(`SELECT * FROM recipes WHERE org_id = ? AND id = ?`)
        .get(run.org_id, run.recipe_id) as RecipeRow | undefined;
      if (!recipe || !isDeepStrictEqual(toRecipe(recipe), input.expected_recipe)) {
        return false;
      }
    }
    const workItem = toWorkItem(item);
    const trigger = input.require_current_work_trigger && workItem.head_event_id
      ? db.prepare(`SELECT e.id, e.org_id, e.source, e.external_id, e.thread_id,
          e.operation, d.disposition, d.reason_codes_json
          FROM events e JOIN message_dispositions d ON d.event_id = e.id
          WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
          )`)
          .get(workItem.head_event_id) as {
            id: string;
            org_id: string;
            source: string;
            external_id: string;
            thread_id: string | null;
            operation: string;
            disposition: string;
            reason_codes_json: string;
          } | undefined
      : undefined;
    const triggerRecipe = trigger?.disposition === "pending"
      ? db.prepare("SELECT * FROM recipes WHERE org_id = ? AND id = ?")
        .get(run.org_id, run.recipe_id) as RecipeRow | undefined
      : undefined;
    const triggerIsCurrentWork = Boolean(
      trigger &&
      trigger.org_id === run.org_id &&
      trigger.operation !== "tombstone" &&
      isWorkTriggerDecision(trigger.disposition, JSON.parse(trigger.reason_codes_json),
        workItem, triggerRecipe ? toRecipe(triggerRecipe) : null) &&
      (trigger.thread_id ?? conversationId(
        trigger.source,
        trigger.external_id,
        trigger.id,
      )) === workItem.thread_id,
    );
    if (!canClaimWorkRunStartItem(input, workItem, triggerIsCurrentWork)) return false;
    if (input.visibility_intent_version !== undefined) {
      const currentVisibility = db.prepare(
        "SELECT visibility_version FROM conversation_prefs WHERE org_id = ? AND thread_id = ?",
      ).get(run.org_id, workItem.thread_id) as { visibility_version: number } | undefined;
      if ((currentVisibility?.visibility_version ?? 0) !== input.visibility_intent_version) {
        return false;
      }
    }
    if (db.prepare(
      "SELECT id FROM work_deliveries WHERE org_id = ? AND work_item_id = ? AND status <> 'acked' LIMIT 1",
    ).get(run.org_id, run.work_item_id)) return false;
    if (max_concurrent !== undefined) {
      const occupied = db.prepare(`
        SELECT COUNT(*) AS count FROM work_items
        WHERE org_id = ? AND recipe_id = ? AND status IN ('running', 'waiting_human')
      `).get(run.org_id, run.recipe_id) as { count: number };
      if (occupied.count >= max_concurrent) return false;
    }
    if (db.prepare("SELECT 1 FROM work_runs WHERE id = ?").get(run.id)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    if (input.retry === "manual" && workItem.current_run_id
      && workItem.acknowledged_run_id === workItem.current_run_id && workItem.head_event_id) {
      const trigger = db.prepare(`SELECT e.id, e.thread_id, e.source, e.external_id, e.operation,
          d.disposition, d.reason_codes_json, d.version
        FROM events e JOIN message_dispositions d ON d.event_id = e.id
        WHERE e.org_id = ? AND e.id = ? AND d.org_id = ?
          AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id)`)
        .get(run.org_id, workItem.head_event_id, run.org_id) as {
          id: string;
          thread_id: string | null;
          source: string;
          external_id: string;
          operation: string;
          disposition: string;
          reason_codes_json: string;
          version: number;
        } | undefined;
      const triggerThreadId = trigger && (trigger.thread_id ?? conversationId(
        trigger.source,
        trigger.external_id,
        trigger.id,
      ));
      const reasonCodes = trigger ? JSON.parse(trigger.reason_codes_json) as string[] : [];
      if (trigger && triggerThreadId === workItem.thread_id && trigger.operation !== "tombstone"
        && trigger.disposition === "outside_current_work"
        && reasonCodes.includes("result_acknowledged")) {
        const nextReasonCodes = reasonCodes.filter((reason) => reason !== "result_acknowledged");
        const nextVersion = trigger.version + 1;
        const restored = db.prepare(`UPDATE message_dispositions SET disposition = 'current_work',
          reason_codes_json = ?, decided_at = ?, version = ?
          WHERE org_id = ? AND event_id = ? AND disposition = 'outside_current_work' AND version = ?`)
          .run(JSON.stringify(nextReasonCodes), run.created_at, nextVersion,
            run.org_id, trigger.id, trigger.version);
        if (restored.changes !== 1) {
          throw new Error("Acknowledged trigger changed inside its run-start transaction");
        }
        refreshThreadHeadWithinTransaction(db, run.org_id, workItem.thread_id);
        db.prepare(`INSERT INTO conversation_lifecycle_events (
          id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
          event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
        ) VALUES (?, ?, ?, 'source_event', ?, ?, 'current_work_changed', NULL, ?, 1, ?, ?, ?)`)
          .run(
            randomUUID(), run.org_id, workItem.thread_id, trigger.id, nextVersion,
            JSON.stringify(["source_event", trigger.id, nextVersion, "current_work_changed"]),
            JSON.stringify({
              source: "manual_retry",
              work_item_id: workItem.id,
              previous: { disposition: "outside_current_work", reason_codes: reasonCodes },
              result: { disposition: "current_work", reason_codes: nextReasonCodes },
            }),
            run.created_at, run.created_at,
          );
      }
    }
    writeWorkRun(db, run);
    db.prepare("UPDATE work_items SET status = 'running', recipe_id = ?, current_run_id = ?, acknowledged_run_id = NULL, visibility_intent_version = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND id = ?")
      .run(run.recipe_id, run.id, input.visibility_intent_version ?? workItem.visibility_intent_version ?? 0,
        run.updated_at, run.org_id, run.work_item_id);
    if (command) {
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, 'work_item', ?, ?, 'work_run_transitioned', ?, ?, 1, ?, ?, ?)`)
        .run(
          `lifecycle-${randomUUID()}`,
          command.org_id,
          workItem.thread_id,
          command.work_item_id,
          (workItem.version ?? 0) + 1,
          command.command_id,
          JSON.stringify(["work_item", command.work_item_id, (workItem.version ?? 0) + 1, "work_run_transitioned"]),
          JSON.stringify({ command, run_id: run.id }),
          run.created_at,
          run.created_at,
        );
    }
    return true;
  }).immediate();
}

export async function getSearchAnswer(
  db: Database.Database,
  orgId: string,
  id: string,
): Promise<SearchAnswerRecord | null> {
  const row = db.prepare(
    `SELECT * FROM search_answers WHERE org_id = ? AND id = ?`,
  ).get(orgId, id) as SearchAnswerRow | undefined;
  return row ? toSearchAnswer(row) : null;
}

export async function putSearchAnswer(
  db: Database.Database,
  record: SearchAnswerRecord,
): Promise<SearchAnswerRecord> {
  const saved = db.prepare(`
    INSERT INTO search_answers (
      id, org_id, work_item_id, query, event_ids_json, scope_json, outcome, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      work_item_id = excluded.work_item_id,
      query = excluded.query,
      event_ids_json = excluded.event_ids_json,
      scope_json = excluded.scope_json,
      outcome = excluded.outcome,
      updated_at = excluded.updated_at
    WHERE search_answers.org_id = excluded.org_id
      AND search_answers.work_item_id = excluded.work_item_id
      AND search_answers.outcome IS excluded.outcome
    RETURNING *
  `).get(
    record.id,
    record.org_id,
    record.work_item_id,
    record.query,
    JSON.stringify(record.event_ids),
    record.scope ? JSON.stringify(record.scope) : null,
    record.outcome ?? null,
    record.created_at,
    record.updated_at,
  ) as SearchAnswerRow | undefined;
  if (!saved) throw new Error("Search answer identity and outcome cannot be changed through ordinary writes");
  return toSearchAnswer(saved);
}

export async function deleteSearchAnswer(
  db: Database.Database,
  orgId: string,
  id: string,
): Promise<boolean> {
  return db.prepare(
    "DELETE FROM search_answers WHERE org_id = ? AND id = ?",
  ).run(orgId, id).changes > 0;
}

export async function listWorkDeliveries(db: Database.Database, orgId: string): Promise<WorkDelivery[]> {
    const rows = db
      .prepare(
        `SELECT * FROM work_deliveries WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as WorkDeliveryRow[];
    return rows.map(toWorkDelivery);
  }

export async function listDueWorkDeliveries(db: Database.Database, orgId: string, now: string): Promise<WorkDelivery[]> {
    const rows = db
      .prepare(
        `
          SELECT * FROM work_deliveries
          WHERE org_id = ?
            AND payload_json IS NOT NULL
            AND status NOT IN ('acked', 'dead')
            AND (
              (status = 'uncertain' AND json_extract(channel_receipt_json, '$.accepted') = 1)
              OR (
                status = 'queued'
                AND (
                  write_back IS NULL
                  OR write_back <> 'failed'
                  OR next_retry_at IS NULL
                  OR next_retry_at <= ?
                )
              )
              OR (
                write_back = 'failed'
                AND (next_retry_at IS NULL OR next_retry_at <= ?)
              )
              OR (
                status IN ('running', 'write_back')
                AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
              )
            )
          ORDER BY updated_at, id
        `,
      )
      .all(orgId, now, now, now) as WorkDeliveryRow[];
    return rows.map(toWorkDelivery);
  }

export async function getWorkDelivery(db: Database.Database, orgId: string, id: string): Promise<WorkDelivery | null> {
    const row = db
      .prepare(`SELECT * FROM work_deliveries WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkDeliveryRow | undefined;
    return row ? toWorkDelivery(row) : null;
  }

export async function getWorkDeliveryByItem(db: Database.Database, orgId: string, workItemId: string): Promise<WorkDelivery | null> {
    const row = db
      .prepare(
        `SELECT d.* FROM work_deliveries d
         LEFT JOIN work_items w ON w.org_id = d.org_id AND w.id = d.work_item_id
         LEFT JOIN work_runs r ON r.org_id = w.org_id AND r.id = w.current_run_id
         WHERE d.org_id = ? AND d.work_item_id = ?
           AND (d.run_id = w.current_run_id OR (d.run_id IS NULL AND r.write_back_required IS NULL))
         ORDER BY d.created_at, d.id LIMIT 1`,
      )
      .get(orgId, workItemId) as WorkDeliveryRow | undefined;
    return row ? toWorkDelivery(row) : null;
  }

async function putWorkDelivery(db: Database.Database, delivery: WorkDelivery): Promise<WorkDelivery> {
    return db.transaction(() => writeWorkDelivery(db, delivery)).immediate();
  }

export async function transitionWorkDelivery(
  db: Database.Database, input: WorkDeliveryCommand,
): Promise<WorkDeliveryCommandResult> {
  return db.transaction((): WorkDeliveryCommandResult => {
    if (input.kind === "retry" || input.kind === "reconcile") {
      const event = db.prepare(`SELECT aggregate_type, aggregate_id, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
        .get(input.org_id, input.command_id) as
        | { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string }
        | undefined;
      if (event) {
        const payload = JSON.parse(event.payload_json) as { command?: unknown; delivery?: WorkDelivery };
        const replayDelivery = payload.delivery;
        if (event.aggregate_type !== "work_delivery" || event.aggregate_id !== input.delivery_id
          || event.event_type !== "delivery_transitioned"
          || !sameWorkDeliveryRetryCommand(payload.command, input)
          || replayDelivery?.id !== input.delivery_id) {
          return { outcome: "conflict", reason: "not_claimable" };
        }
        return { outcome: "replayed", delivery: replayDelivery };
      }
    }
    const row = db.prepare("SELECT * FROM work_deliveries WHERE org_id = ? AND id = ?")
      .get(input.org_id, input.delivery_id) as WorkDeliveryRow | undefined;
    const item = row ? db.prepare("SELECT status, version, thread_id FROM work_items WHERE org_id = ? AND id = ?")
      .get(input.org_id, row.work_item_id) as { status: string; version: number; thread_id: string } | undefined : undefined;
    if ((input.kind === "retry" || input.kind === "reconcile") &&
      item?.version !== input.expected_item_version) {
      return { outcome: "conflict", reason: "not_claimable" };
    }
    let result = planWorkDeliveryCommand(row ? toWorkDelivery(row) : null, item?.status, input);
    if (result.outcome === "applied") {
      const savedDelivery = writeWorkDelivery(db, result.delivery, true);
      result = { ...result, delivery: savedDelivery };
      if (row && item) {
        const lifecycleVersion = db.prepare(`SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS version
          FROM conversation_lifecycle_events WHERE org_id = ? AND aggregate_type = 'work_delivery'
            AND aggregate_id = ?`).get(input.org_id, input.delivery_id) as { version: number };
        const event = workDeliveryLifecycleEvent({
          thread_id: item.thread_id,
          previous: toWorkDelivery(row),
          next: result.delivery,
          command: input,
          aggregate_version: lifecycleVersion.version,
        });
        if (event) {
          const commandResult = input.kind === "retry" || input.kind === "reconcile"
            ? { command: input, delivery: result.delivery } : {};
        db.prepare(`INSERT INTO conversation_lifecycle_events (
          id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
          event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
        ) VALUES (?, ?, ?, 'work_delivery', ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .run(
            randomUUID(), input.org_id, event.thread_id, input.delivery_id,
            event.aggregate_version, event.event_type,
            "command_id" in input ? input.command_id : null,
            event.dedupe_key,
            JSON.stringify({ ...event.payload, ...commandResult }),
            "issued_at" in input ? input.issued_at : input.now, input.now,
          );
        }
      }
      if (savedDelivery.run_id && savedDelivery.status === "acked" && savedDelivery.write_back === "sent"
        && (row?.status !== "acked" || row.write_back !== "sent")) finishSuccessfulWorkWithinTransaction(
        db, input.org_id, savedDelivery.work_item_id, savedDelivery.run_id, input.now,
      );
    }
    return result;
  }).immediate();
}

function writeWorkDelivery(db: Database.Database, delivery: WorkDelivery, commandWrite = false): WorkDelivery {
    const current = db.prepare("SELECT * FROM work_deliveries WHERE id = ?").get(delivery.id) as WorkDeliveryRow | undefined;
    const run = delivery.run_id
      ? db.prepare(`SELECT r.* FROM work_runs r
          JOIN work_items w ON w.id = r.work_item_id AND w.org_id = r.org_id
          WHERE r.org_id = ? AND r.id = ?`).get(delivery.org_id, delivery.run_id) as WorkRunRow | undefined
      : undefined;
    assertWorkDeliveryWrite(delivery, current ? toWorkDelivery(current) : null, run ? toWorkRun(run) : null, commandWrite);
    const row = db
      .prepare(
        `
          INSERT INTO work_deliveries (
            id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
            status, write_back, attempts, last_error, next_retry_at,
            payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
            created_at, updated_at, run_id, target_json, lease_owner, claim_token, cancel_requested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            version = work_deliveries.version + 1,
            recipe_id = excluded.recipe_id,
            kind = excluded.kind,
            unit_key = excluded.unit_key,
            event_id = excluded.event_id,
            status = excluded.status,
            write_back = excluded.write_back,
            attempts = excluded.attempts,
            last_error = excluded.last_error,
            next_retry_at = excluded.next_retry_at,
            payload_json = excluded.payload_json,
            lease_expires_at = excluded.lease_expires_at,
            idempotency_key = excluded.idempotency_key,
            channel_receipt_json = excluded.channel_receipt_json,
            lease_owner = excluded.lease_owner,
            claim_token = excluded.claim_token,
            cancel_requested_at = excluded.cancel_requested_at,
            updated_at = excluded.updated_at
          WHERE work_deliveries.org_id = excluded.org_id
            AND work_deliveries.work_item_id = excluded.work_item_id
            AND work_deliveries.run_id IS excluded.run_id
            AND (work_deliveries.run_id IS NULL OR (
              work_deliveries.payload_json IS excluded.payload_json
              AND work_deliveries.target_json IS excluded.target_json
              AND work_deliveries.idempotency_key IS excluded.idempotency_key
            ))
          RETURNING *
        `,
      )
      .get(
        delivery.id,
        delivery.org_id,
        delivery.work_item_id,
        delivery.version ?? 0,
        delivery.recipe_id,
        delivery.kind,
        delivery.unit_key,
        delivery.event_id ?? null,
        delivery.status,
        delivery.write_back,
        delivery.attempts,
        delivery.last_error ?? null,
        delivery.next_retry_at ?? null,
        delivery.payload ? (delivery.run_id ? canonicalContextJson(delivery.payload) : JSON.stringify(delivery.payload)) : null,
        delivery.lease_expires_at ?? null,
        delivery.idempotency_key ?? null,
        delivery.channel_receipt ? JSON.stringify(delivery.channel_receipt) : null,
        delivery.created_at,
        delivery.updated_at,
        delivery.run_id ?? null,
        delivery.target ? canonicalContextJson(delivery.target) : null,
        delivery.lease_owner ?? null,
        delivery.claim_token ?? null,
        delivery.cancel_requested_at ?? null,
      ) as WorkDeliveryRow | undefined;
    if (!row) {
      throw new Error("work delivery upsert returned no row");
    }
    return toWorkDelivery(row);
  }

export async function listExecutorInstallations(db: Database.Database, orgId: string): Promise<ExecutorInstallation[]> {
    const rows = db
      .prepare(
        `
          SELECT * FROM executor_installations
          WHERE org_id = ? ORDER BY updated_at DESC, id
        `,
      )
      .all(orgId) as ExecutorRow[];
    return rows.map(toExecutorInstallation);
  }

export async function getExecutorInstallation(db: Database.Database, orgId: string, id: string): Promise<ExecutorInstallation | null> {
    const row = db
      .prepare(
        `SELECT * FROM executor_installations WHERE org_id = ? AND id = ?`,
      )
      .get(orgId, id) as ExecutorRow | undefined;
    return row ? toExecutorInstallation(row) : null;
  }

export async function putExecutorInstallation(db: Database.Database, installation: ExecutorInstallation): Promise<ExecutorInstallation> {
    
    db
      .prepare(
        `
          INSERT INTO executor_installations (
            id, org_id, kind, name, status, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            name = excluded.name,
            status = excluded.status,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        installation.id,
        installation.org_id,
        installation.kind,
        installation.name,
        installation.status,
        JSON.stringify(installation.config),
        installation.created_at,
        installation.updated_at,
      );
    return installation;
  }

export async function deleteExecutorInstallation(db: Database.Database, orgId: string, id: string): Promise<boolean> {
    
    const result = db
      .prepare(`DELETE FROM executor_installations WHERE org_id = ? AND id = ?`)
      .run(orgId, id);
    return result.changes > 0;
  }

interface ExecutorRow {
  id: string;
  org_id: string;
  kind: ExecutorInstallation["kind"];
  name: string;
  status: ExecutorInstallation["status"];
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface RecipeRow {
  id: string;
  org_id: string;
  name: string;
  match_json: string;
  executor_type: string;
  executor_config_json: string;
  can_write_back: number;
  write_back_thread_id: string | null;
  include_context: number;
  hide_on_success: number;
  enabled: number;
  trigger_kind: string | null;
  trigger_interval_ms: number | null;
  trigger_at_minute: number | null;
  trigger_weekdays: string | null;
  trigger_timezone: string | null;
  trigger_coalesce: number | null;
  max_concurrent: number | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: string;
  org_id: string;
  thread_id: string;
  unit_key: string;
  head_event_id: string | null;
  record_class: WorkItem["record_class"];
  thread_facet: WorkItem["thread_facet"];
  status: WorkItem["status"];
  recipe_id: string | null;
  current_run_id: string | null;
  acknowledged_run_id: string | null;
  version: number;
  visibility_intent_version: number;
  created_at: string;
  updated_at: string;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
  version: number;
  run_id: string | null;
  lease_owner: string | null;
  claim_token: string | null;
  cancel_requested_at: string | null;
  target_json: string | null;
  recipe_id: string;
  kind: string;
  unit_key: string;
  event_id: string | null;
  status: string;
  write_back: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  payload_json: string | null;
  lease_expires_at: string | null;
  idempotency_key: string | null;
  channel_receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkRunRow {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  executor_type: string;
  external_run_id: string | null;
  agent_thread_id: string | null;
  status: WorkRun["status"];
  start_state: WorkRun["start_state"] | null;
  result_json: string | null;
  version: number;
  write_back_required: number | null;
  write_back_target_json: string | null;
  trigger_kind: WorkRun["trigger_kind"] | null;
  executor_config_json: string | null;
  include_context: number | null;
  completion_policy_version: WorkRun["completion_policy_version"] | null;
  hide_on_success: number | null;
  created_at: string;
  updated_at: string;
}

interface SearchAnswerRow {
  id: string;
  org_id: string;
  work_item_id: string;
  query: string;
  event_ids_json: string;
  scope_json: string | null;
  outcome: SearchAnswerRecord["outcome"] | null;
  created_at: string;
  updated_at: string;
}

function toExecutorInstallation(row: ExecutorRow): ExecutorInstallation {
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: JSON.parse(row.config_json) as ExecutorInstallation["config"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRecipe(row: RecipeRow): Recipe {
  const match = JSON.parse(row.match_json) as Recipe["match"];
  const kind = isRecipeTriggerKind(row.trigger_kind) ? row.trigger_kind : undefined;
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    match,
    trigger: recipeTriggerOf({
      match,
      trigger: kind
        ? {
            kind,
            ...(kind === "pull" ? pullScheduleFromColumns(row) : {}),
            ...(kind === "push" ? { coalesce: row.trigger_coalesce !== 0 } : {}),
          }
        : undefined,
    }),
    executor_type: row.executor_type,
    executor_config: JSON.parse(row.executor_config_json) as Recipe["executor_config"],
    can_write_back: row.can_write_back === 1,
    ...(row.write_back_thread_id !== null
      ? { write_back_thread_id: row.write_back_thread_id }
      : {}),
    include_context: row.include_context === 1,
    hide_on_success: row.hide_on_success === 1,
    enabled: row.enabled === 1,
    ...(row.max_concurrent && row.max_concurrent > 0
      ? { max_concurrent: row.max_concurrent }
      : {}),
    ...(row.next_run_at ? { next_run_at: row.next_run_at } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    org_id: row.org_id,
    thread_id: row.thread_id,
    unit_key: row.unit_key,
    head_event_id: row.head_event_id ?? undefined,
    record_class: row.record_class,
    thread_facet: row.thread_facet,
    status: row.status,
    recipe_id: row.recipe_id ?? undefined,
    current_run_id: row.current_run_id ?? undefined,
    acknowledged_run_id: row.acknowledged_run_id ?? undefined,
    version: row.version,
    visibility_intent_version: row.visibility_intent_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toWorkRun(row: WorkRunRow): WorkRun {
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    recipe_id: row.recipe_id,
    executor_type: row.executor_type,
    external_run_id: row.external_run_id ?? undefined,
    agent_thread_id: row.agent_thread_id ?? undefined,
    status: row.status,
    start_state: row.start_state ?? undefined,
    result: row.result_json
      ? (JSON.parse(row.result_json) as WorkRun["result"])
      : undefined,
    version: row.version,
    ...(row.write_back_required !== null ? { write_back_required: row.write_back_required === 1 } : {}),
    ...(row.write_back_target_json ? { write_back_target: JSON.parse(row.write_back_target_json) } : {}),
    ...(row.trigger_kind ? { trigger_kind: row.trigger_kind } : {}),
    ...(row.executor_config_json !== null
      ? { executor_config: JSON.parse(row.executor_config_json) as WorkRun["executor_config"] }
      : {}),
    ...(row.include_context !== null ? { include_context: row.include_context === 1 } : {}),
    ...(row.completion_policy_version !== null ? { completion_policy_version: row.completion_policy_version } : {}),
    ...(row.hide_on_success !== null ? { hide_on_success: row.hide_on_success === 1 } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toSearchAnswer(row: SearchAnswerRow): SearchAnswerRecord {
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    query: row.query,
    event_ids: JSON.parse(row.event_ids_json) as string[],
    ...(row.scope_json
      ? { scope: JSON.parse(row.scope_json) as SearchAnswerRecord["scope"] }
      : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toWorkDelivery(row: WorkDeliveryRow): WorkDelivery {
  const kind = isRecipeTriggerKind(row.kind) ? row.kind : "manual";
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    version: row.version,
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.claim_token ? { claim_token: row.claim_token } : {}),
    ...(row.cancel_requested_at ? { cancel_requested_at: row.cancel_requested_at } : {}),
    ...(row.run_id ? { run_id: row.run_id } : {}),
    ...(row.target_json ? { target: JSON.parse(row.target_json) } : {}),
    recipe_id: row.recipe_id,
    kind,
    unit_key: row.unit_key,
    event_id: row.event_id ?? undefined,
    status: isWorkDeliveryStatus(row.status) ? row.status : "queued",
    write_back: isWorkWriteBackState(row.write_back) ? row.write_back : "pending",
    attempts: row.attempts,
    last_error: row.last_error ?? undefined,
    next_retry_at: row.next_retry_at ?? undefined,
    payload: parseDeliveryPayload(row.payload_json),
    lease_expires_at: row.lease_expires_at ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    channel_receipt: parseChannelReceipt(row.channel_receipt_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseChannelReceipt(
  raw: string | null,
): WorkDelivery["channel_receipt"] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as WorkDelivery["channel_receipt"];
    if (!parsed || typeof parsed.accepted !== "boolean") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDeliveryPayload(
  raw: string | null,
): WorkDelivery["payload"] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as WorkDelivery["payload"];
    if (!parsed || typeof parsed.summary !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
