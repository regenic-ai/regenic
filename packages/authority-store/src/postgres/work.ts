import type { PoolClient } from "pg";
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
  type CommitWorkObservation,
  type CommitWorkObservationResult,
} from "@regenic/domain";
import {
  PgSql,
  asBool,
  asJson,
  asNumber,
  jsonb,
  toIso,
} from "./sql";
import { lockConversationThreads } from "./conversation-lock";
import {
  toIsoOrUndefined,
} from "./sync";
import {
  hasCurrentWorkForThread,
  putConversationPrefOn,
  refreshThreadHeadWithinTransaction,
  setConversationPolicyVisibilityOn,
} from "./inbox";

export async function listRecipes(db: PgSql, orgId: string): Promise<Recipe[]> {
    const rows = await db.query<RecipeRow>(
      `SELECT * FROM recipes WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toRecipe);
  }

export async function getRecipe(db: PgSql, orgId: string, id: string): Promise<Recipe | null> {
    const row = await db.queryOne<RecipeRow>(
      `SELECT * FROM recipes WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toRecipe(row) : null;
  }

export async function putRecipe(db: PgSql, recipe: Recipe): Promise<Recipe> {
    await writeRecipe(db, recipe);
    return recipe;
  }

export async function putRecipeIfUnchanged(
  db: PgSql,
  input: import("@regenic/domain").RecipeWrite,
): Promise<import("@regenic/domain").RecipeWriteResult> {
  if (
    input.expected_recipe &&
    (input.expected_recipe.id !== input.recipe.id ||
      input.expected_recipe.org_id !== input.recipe.org_id)
  ) {
    return { outcome: "conflict" };
  }
  return db.withTx(async (client) => {
    await db.queryOne(
      `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('recipe', $1::text)::text, 0))`,
      [input.recipe.id],
      client,
    );
    const row = await db.queryOne<RecipeRow>(
      `SELECT * FROM recipes WHERE id = $1 FOR UPDATE`,
      [input.recipe.id],
      client,
    );
    const current = row ? toRecipe(row) : null;
    if (
      input.expected_recipe === null
        ? current !== null
        : !current || !isDeepStrictEqual(current, input.expected_recipe)
    ) {
      return { outcome: "conflict" };
    }
    const written = await writeRecipe(
      db,
      input.recipe,
      client,
      input.expected_recipe === null,
    );
    if (written === 0) {
      return { outcome: "conflict" };
    }
    return { outcome: "applied", recipe: input.recipe };
  });
}

export async function advanceRecipePullSchedule(
  db: PgSql,
  input: { expected_recipe: Recipe; next_run_at: string; updated_at: string },
): Promise<boolean> {
  return db.withTx(async (client) => {
    const row = await db.queryOne<RecipeRow>(
      `SELECT * FROM recipes WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [input.expected_recipe.org_id, input.expected_recipe.id],
      client,
    );
    if (!row || !isDeepStrictEqual(toRecipe(row), input.expected_recipe)) {
      return false;
    }
    await db.execute(
      `UPDATE recipes SET next_run_at = $1, updated_at = $2 WHERE org_id = $3 AND id = $4`,
      [
        input.next_run_at,
        input.updated_at,
        input.expected_recipe.org_id,
        input.expected_recipe.id,
      ],
      client,
    );
    return true;
  });
}

async function writeRecipe(db: PgSql, recipe: Recipe, client?: PoolClient, insertOnly = false): Promise<number> {
    const trigger = recipeTriggerOf(recipe);
    const pull = pullScheduleColumns(trigger);
    return db.execute(
      `
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          can_write_back, include_context, enabled, trigger_kind,
          trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone,
          trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at,
          write_back_thread_id, hide_on_success
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        ON CONFLICT (id) DO ${insertOnly ? "NOTHING" : `UPDATE SET
          name = EXCLUDED.name,
          match_json = EXCLUDED.match_json,
          executor_type = EXCLUDED.executor_type,
          executor_config_json = EXCLUDED.executor_config_json,
          can_write_back = EXCLUDED.can_write_back,
          write_back_thread_id = EXCLUDED.write_back_thread_id,
          include_context = EXCLUDED.include_context,
          enabled = EXCLUDED.enabled,
          trigger_kind = EXCLUDED.trigger_kind,
          trigger_interval_ms = EXCLUDED.trigger_interval_ms,
          trigger_at_minute = EXCLUDED.trigger_at_minute,
          trigger_weekdays = EXCLUDED.trigger_weekdays,
          trigger_timezone = EXCLUDED.trigger_timezone,
          trigger_coalesce = EXCLUDED.trigger_coalesce,
          max_concurrent = EXCLUDED.max_concurrent,
          next_run_at = EXCLUDED.next_run_at,
          hide_on_success = EXCLUDED.hide_on_success,
          updated_at = EXCLUDED.updated_at`}
      `,
      [
        recipe.id,
        recipe.org_id,
        recipe.name,
        jsonb(recipe.match),
        recipe.executor_type,
        jsonb(recipe.executor_config),
        recipe.can_write_back,
        recipe.include_context,
        recipe.enabled,
        trigger.kind,
        pull.interval_ms,
        pull.at_minute,
        pull.weekdays,
        pull.timezone,
        trigger.kind === "push" && trigger.coalesce !== false,
        recipe.max_concurrent ?? null,
        recipe.next_run_at ?? null,
        recipe.created_at,
        recipe.updated_at,
        recipe.write_back_thread_id ?? null,
        recipe.hide_on_success !== false,
      ],
      client,
    );
  }

export async function deleteRecipe(db: PgSql, orgId: string, id: string): Promise<boolean> {
    const rowCount = await db.execute(
      `DELETE FROM recipes WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return rowCount > 0;
  }

export async function listWorkItems(db: PgSql, orgId: string, options?: { statuses?: readonly WorkItemStatus[] }): Promise<WorkItem[]> {
    const statuses = options?.statuses;
    if (statuses?.length) {
      const marks = statuses.map((_, index) => `$${index + 2}`).join(", ");
      const rows = await db.query<WorkItemRow>(
        `SELECT * FROM work_items WHERE org_id = $1 AND status IN (${marks}) ORDER BY updated_at DESC, id`,
        [orgId, ...statuses],
      );
      return rows.map(toWorkItem);
    }
    const rows = await db.query<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toWorkItem);
  }

export async function getWorkItem(db: PgSql, orgId: string, id: string): Promise<WorkItem | null> {
    const row = await db.queryOne<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkItem(row) : null;
  }

export async function getWorkItemByThread(db: PgSql, orgId: string, threadId: string): Promise<WorkItem | null> {
    const row = await db.queryOne<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 AND thread_id = $2
       ORDER BY CASE WHEN status IN ('open', 'running', 'waiting_human') THEN 0 ELSE 1 END,
                created_at DESC, id DESC
       LIMIT 1`,
      [orgId, threadId],
    );
    return row ? toWorkItem(row) : null;
  }

export async function getWorkItemByUnitKey(db: PgSql, orgId: string, threadId: string, unitKey: string): Promise<WorkItem | null> {
    const row = await db.queryOne<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 AND thread_id = $2 AND unit_key = $3
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [orgId, threadId, unitKey],
    );
    return row ? toWorkItem(row) : null;
  }

async function putWorkItem(
  db: PgSql,
  item: WorkItem,
  client?: PoolClient,
  advanceVersion = true,
): Promise<WorkItem> {
    if (!client) {
      return db.withTx(async (tx) => {
        await lockConversationThreads(db, tx, [{
          org_id: item.org_id,
          thread_id: item.thread_id,
        }]);
        const row = await db.queryOne<WorkItemRow>(
          "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
          [item.org_id, item.id],
          tx,
        );
        const current = row ? toWorkItem(row) : undefined;
        assertWorkItemVersionWrite(item, current);
        assertWorkItemStatusWrite(item, current);
        return putWorkItem(db, item, tx, advanceVersion);
      });
    }
    const saved = await db.queryOne<WorkItemRow>(
      `
        INSERT INTO work_items (
          id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
          status, recipe_id, created_at, updated_at, current_run_id, version,
          visibility_intent_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          unit_key = EXCLUDED.unit_key,
          head_event_id = EXCLUDED.head_event_id,
          record_class = EXCLUDED.record_class,
          thread_facet = EXCLUDED.thread_facet,
          status = EXCLUDED.status,
          recipe_id = EXCLUDED.recipe_id,
          updated_at = EXCLUDED.updated_at,
          current_run_id = work_items.current_run_id,
          version = ${advanceVersion ? "work_items.version + 1" : "EXCLUDED.version"}
        WHERE work_items.org_id = EXCLUDED.org_id
          AND work_items.thread_id = EXCLUDED.thread_id
          AND work_items.unit_key = EXCLUDED.unit_key
        RETURNING *
      `,
      [
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
      ], client,
    );
    if (!saved) {
      throw new Error("Work item ID, organization, thread, and unit are immutable");
    }
    return advanceVersion ? toWorkItem(saved) : item;
  }

  export async function observeWorkItem(
    db: PgSql,
    input: WorkItemObservation,
  ): Promise<WorkItemObservationResult> {
    return db.withTx((client) => observeWorkItemOn(db, input, client));
  }

  export async function observeWorkItemOn(
    db: PgSql,
    input: WorkItemObservation,
    client: PoolClient,
  ): Promise<WorkItemObservationResult> {
      const orgId = input.item.org_id;
      await lockConversationThreads(db, client, [{
        org_id: orgId,
        thread_id: input.item.thread_id,
      }]);
      const expected = input.expected_item;
      const expectedRow = expected ? await db.queryOne<WorkItemRow>(
        "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [orgId, expected.id], client,
      ) : null;
      const currentRow = await db.queryOne<WorkItemRow>(
        "SELECT * FROM work_items WHERE id = $1 FOR UPDATE",
        [input.item.id], client,
      );
      const unitRow = await db.queryOne<{ id: string }>(`SELECT id FROM work_items
        WHERE org_id = $1 AND thread_id = $2 AND unit_key = $3 AND id <> $4 FOR UPDATE`,
      [orgId, input.item.thread_id, input.item.unit_key, input.item.id], client);
      const trigger = input.item.head_event_id
        ? await db.queryOne<{
            id: string;
            org_id: string;
            source: string;
            external_id: string;
            thread_id: string | null;
            operation: string;
            disposition: string | null;
            reason_codes: unknown;
          }>(
            `SELECT e.id, e.org_id, e.source, e.external_id, e.thread_id,
                    e.operation, d.disposition, d.reason_codes
             FROM events e
             JOIN message_dispositions d ON d.event_id = e.id
             WHERE e.id = $1 AND EXISTS (
               SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
             )
             FOR SHARE OF e, d`,
            [input.item.head_event_id], client,
          )
        : null;
      const triggerRecipe = trigger?.disposition === "pending" && input.item.recipe_id
        ? await db.queryOne<RecipeRow>(
          "SELECT * FROM recipes WHERE org_id = $1 AND id = $2 FOR SHARE",
          [orgId, input.item.recipe_id], client,
        ) : null;
      const triggerIsCurrentWork = Boolean(
        trigger &&
        trigger.org_id === orgId &&
        trigger.operation !== "tombstone" &&
        isWorkTriggerDecision(trigger.disposition, asJson<string[]>(trigger.reason_codes),
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
        unit_exists: Boolean(unitRow),
        trigger_is_current_work: triggerIsCurrentWork,
      });
      if (result.outcome !== "applied") return result;
      let savedRow: WorkItemRow | null;
      if (expected?.id === input.item.id) {
        await putWorkItem(db, result.item, client, true);
        savedRow = await db.queryOne<WorkItemRow>(
          "SELECT * FROM work_items WHERE org_id = $1 AND id = $2",
          [orgId, result.item.id], client,
        );
      } else {
        savedRow = await db.queryOne<WorkItemRow>(`INSERT INTO work_items (
          id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
          status, recipe_id, created_at, updated_at, current_run_id, version,
          visibility_intent_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, 0, 0)
        ON CONFLICT DO NOTHING RETURNING *`, [
          result.item.id, result.item.org_id, result.item.thread_id, result.item.unit_key,
          result.item.head_event_id ?? null, result.item.record_class, result.item.thread_facet,
          result.item.status, result.item.recipe_id ?? null, result.item.created_at,
          result.item.updated_at,
        ], client);
        if (!savedRow) return {
          outcome: "conflict",
          reason: currentRow ? "work_exists" : "unit_exists",
        };
      }
      if (!savedRow) throw new Error("Observed work item disappeared inside its transaction");
      const savedItem = toWorkItem(savedRow);
      const event = workItemObservationLifecycleEvent(expected, savedItem);
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $10)`, [
        randomUUID(), orgId, event.thread_id, event.aggregate_type, event.aggregate_id,
        event.aggregate_version, event.event_type, event.dedupe_key, jsonb(event.payload),
        savedItem.updated_at,
      ], client);
      return { outcome: "applied", item: savedItem };
  }

  class WorkItemCreationConflict extends Error {
  constructor(readonly reason: "work_exists" | "search_answer_exists") { super(reason); }
}

export async function createWorkItem(db: PgSql, input: WorkItemCreation): Promise<WorkItemCreationResult> {
  try {
    return await db.withTx(async (client): Promise<WorkItemCreationResult> => {
      const transition = input.search_answer_transition;
      await lockConversationThreads(db, client, [{
        org_id: input.item.org_id,
        thread_id: input.item.thread_id,
      }, ...(transition ? [{
        org_id: transition.expected_item.org_id, thread_id: transition.expected_item.thread_id,
      }] : [])]);
      await db.execute("SELECT pg_advisory_xact_lock(hashtext($1))", [`work-recipe:${input.recipe.id}`], client);
      let recipe = await db.queryOne<RecipeRow>("SELECT * FROM recipes WHERE id = $1 FOR UPDATE", [input.recipe.id], client);
      const exists = await db.queryOne("SELECT id FROM work_items WHERE id = $1 FOR UPDATE", [input.item.id], client);
      const answerExists = input.search_answer ? await db.queryOne<SearchAnswerRow>(
        "SELECT * FROM search_answers WHERE id = $1 FOR UPDATE", [input.search_answer.id], client,
      ) : null;
      const previousItem = transition ? await db.queryOne<WorkItemRow>(
        "SELECT * FROM work_items WHERE id = $1 FOR UPDATE", [transition.expected_item.id], client,
      ) : null;
      const previousRun = transition ? await db.queryOne<WorkRunRow>(
        "SELECT * FROM work_runs WHERE id = $1 FOR UPDATE", [transition.expected_run.id], client,
      ) : null;
      const answerFacts = {
        search_answer_exists: Boolean(answerExists),
        search_answer: answerExists ? toSearchAnswer(answerExists) : null,
        answer_item: previousItem ? toWorkItem(previousItem) : null,
        answer_run: previousRun ? toWorkRun(previousRun) : null,
      };
      let result = prepareWorkItemCreation(input, {
        item_exists: Boolean(exists), recipe: recipe ? toRecipe(recipe) : null, ...answerFacts,
      });
      if (result.outcome !== "applied") return result;
      if (!recipe) {
        const inserted = await writeRecipe(db, result.recipe, client, true);
        recipe = await db.queryOne<RecipeRow>("SELECT * FROM recipes WHERE id = $1 FOR UPDATE", [input.recipe.id], client);
        if (!recipe) throw new Error("Created recipe disappeared inside its transaction");
        if (!inserted) {
          result = prepareWorkItemCreation(input, { item_exists: false, recipe: toRecipe(recipe), ...answerFacts });
          if (result.outcome !== "applied") return result;
        }
      }
      const { item } = result;
      const savedItem = await db.queryOne<WorkItemRow>(`INSERT INTO work_items (
        id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
        status, recipe_id, created_at, updated_at, current_run_id, version,
        visibility_intent_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, 0, $12)
      ON CONFLICT (id) DO NOTHING RETURNING *`, [
        item.id, item.org_id, item.thread_id, item.unit_key, item.head_event_id ?? null,
        item.record_class, item.thread_facet, item.status, item.recipe_id, item.created_at, item.updated_at,
        item.visibility_intent_version ?? 0,
      ], client);
      if (!savedItem) throw new WorkItemCreationConflict("work_exists");
      await writeRecipe(db, result.recipe, client);
      const savedRecipe = await db.queryOne<RecipeRow>("SELECT * FROM recipes WHERE id = $1", [result.recipe.id], client);
      if (!savedRecipe) throw new Error("Created work recipe disappeared inside its transaction");
      const answer = result.search_answer;
      const savedAnswer = answer ? await db.queryOne<SearchAnswerRow>(`INSERT INTO search_answers (
        id, org_id, work_item_id, query, event_ids_json, scope_json, outcome, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
      ${transition ? `ON CONFLICT (id) DO UPDATE SET
        work_item_id = EXCLUDED.work_item_id, scope_json = EXCLUDED.scope_json,
        updated_at = EXCLUDED.updated_at` : "ON CONFLICT (id) DO NOTHING"} RETURNING *`, [
        answer.id, answer.org_id, answer.work_item_id, answer.query, jsonb(answer.event_ids),
        answer.scope ? jsonb(answer.scope) : null, answer.created_at, answer.updated_at,
      ], client) : null;
      if (answer && !savedAnswer) throw new WorkItemCreationConflict("search_answer_exists");
      return {
        outcome: "applied", item: toWorkItem(savedItem), recipe: toRecipe(savedRecipe),
        ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
      };
    });
  } catch (error) {
    if (error instanceof WorkItemCreationConflict) return { outcome: "conflict", reason: error.reason };
    throw error;
  }
}

export async function abortWorkItemCreation(db: PgSql, input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult> {
  return db.withTx(async (client) => {
    const expected = input.expected_item;
    await lockConversationThreads(db, client, [{
      org_id: expected.org_id,
      thread_id: expected.thread_id,
    }]);
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE", [expected.org_id, expected.id], client,
    );
    const answer = await db.queryOne<SearchAnswerRow>(
      "SELECT * FROM search_answers WHERE org_id = $1 AND work_item_id = $2 FOR UPDATE",
      [expected.org_id, expected.id], client,
    );
    const run = await db.queryOne(
      "SELECT id FROM work_runs WHERE org_id = $1 AND work_item_id = $2 LIMIT 1", [expected.org_id, expected.id], client,
    );
    const delivery = await db.queryOne(
      "SELECT id FROM work_deliveries WHERE org_id = $1 AND work_item_id = $2 LIMIT 1",
      [expected.org_id, expected.id], client,
    );
    const result = prepareWorkItemCreationAbort(input, {
      item: item ? toWorkItem(item) : null, has_run: Boolean(run), has_delivery: Boolean(delivery),
      search_answer: answer ? toSearchAnswer(answer) : null,
    });
    if (result.outcome !== "applied") return result;
    if (result.search_answer) await db.execute("DELETE FROM search_answers WHERE org_id = $1 AND id = $2",
      [expected.org_id, result.search_answer.id], client);
    const deleted = await db.queryOne<WorkItemRow>(
      "DELETE FROM work_items WHERE org_id = $1 AND id = $2 RETURNING *", [expected.org_id, expected.id], client,
    );
    if (!deleted) throw new Error("Aborted work item disappeared inside its transaction");
    return { outcome: "applied", item: toWorkItem(deleted), ...(result.search_answer ? { search_answer: result.search_answer } : {}) };
  });
}

export async function listWorkRuns(db: PgSql, orgId: string, workItemId?: string): Promise<WorkRun[]> {
    const rows = workItemId
      ? await db.query<WorkRunRow>(
          `SELECT * FROM work_runs WHERE org_id = $1 AND work_item_id = $2
           ORDER BY updated_at DESC, id`,
          [orgId, workItemId],
        )
      : await db.query<WorkRunRow>(
          `SELECT * FROM work_runs WHERE org_id = $1 ORDER BY updated_at DESC, id`,
          [orgId],
        );
    return rows.map(toWorkRun);
  }

export async function getWorkRun(db: PgSql, orgId: string, id: string): Promise<WorkRun | null> {
    const row = await db.queryOne<WorkRunRow>(
      `SELECT * FROM work_runs WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkRun(row) : null;
  }

export async function getActiveWorkRun(db: PgSql, orgId: string, workItemId: string): Promise<WorkRun | null> {
    const row = await db.queryOne<WorkRunRow>(
      `SELECT * FROM work_runs
       WHERE org_id = $1 AND work_item_id = $2
         AND id = (SELECT current_run_id FROM work_items WHERE org_id = $1 AND id = $2)
         AND status IN ('running', 'waiting_human')
       LIMIT 1`,
      [orgId, workItemId],
    );
    return row ? toWorkRun(row) : null;
  }

export async function listHiddenExecutorThreadIds(db: PgSql, orgId: string): Promise<string[]> {
    const rows = await db.query<{ thread_id: string }>(
      `
        SELECT DISTINCT r.agent_thread_id AS thread_id
        FROM work_runs r
        WHERE r.org_id = $1
          AND r.agent_thread_id IS NOT NULL
          AND r.agent_thread_id <> ''
          AND NOT EXISTS (
            SELECT 1 FROM work_items w
            WHERE w.org_id = r.org_id AND w.thread_id = r.agent_thread_id
          )
      `,
      [orgId],
    );
    return rows.map((row) => row.thread_id);
  }

async function putWorkRun(
  db: PgSql,
  run: WorkRun,
  client?: PoolClient,
  advanceVersion = true,
): Promise<WorkRun> {
    if (!client) {
      return db.withTx(async (tx) => {
        const item = await db.queryOne<{ thread_id: string }>(
          "SELECT thread_id FROM work_items WHERE org_id = $1 AND id = $2",
          [run.org_id, run.work_item_id],
          tx,
        );
        if (!item) throw new Error("Cannot write a work run without its work item");
        await lockConversationThreads(db, tx, [{
          org_id: run.org_id,
          thread_id: item.thread_id,
        }]);
        const current = await db.queryOne<WorkRunRow>(
          "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
          [run.org_id, run.id],
          tx,
        );
        const currentRun = current ? toWorkRun(current) : undefined;
        assertWorkRunVersionWrite(run, currentRun);
        assertWorkRunExecutionIdentityWrite(run, currentRun);
        assertWorkRunStartStateWrite(run, currentRun);
        assertWorkRunWrite(run, currentRun);
        assertWorkRunStatusWrite(run, currentRun);
        return putWorkRun(db, run, tx, advanceVersion);
      });
    }
    const current = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE id = $1 FOR UPDATE", [run.id], client,
    );
    assertWorkRunWrite(run, current ? toWorkRun(current) : undefined);
    const row = await db.queryOne<WorkRunRow>(
      `
        INSERT INTO work_runs (
          id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
          agent_thread_id, status, start_state, result_json, created_at, updated_at, version,
          write_back_required, write_back_target_json, trigger_kind, executor_config_json,
          include_context, completion_policy_version, hide_on_success
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (id) DO UPDATE SET
          recipe_id = EXCLUDED.recipe_id,
          executor_type = EXCLUDED.executor_type,
          external_run_id = EXCLUDED.external_run_id,
          agent_thread_id = EXCLUDED.agent_thread_id,
          status = EXCLUDED.status,
          start_state = EXCLUDED.start_state,
          result_json = EXCLUDED.result_json,
          updated_at = EXCLUDED.updated_at,
          version = ${advanceVersion ? "work_runs.version + 1" : "EXCLUDED.version"}
        WHERE work_runs.org_id = EXCLUDED.org_id
          AND work_runs.work_item_id = EXCLUDED.work_item_id
          AND work_runs.recipe_id = EXCLUDED.recipe_id
          AND work_runs.executor_type = EXCLUDED.executor_type
          AND work_runs.write_back_required IS NOT DISTINCT FROM EXCLUDED.write_back_required
          AND work_runs.write_back_target_json IS NOT DISTINCT FROM EXCLUDED.write_back_target_json
          AND work_runs.trigger_kind IS NOT DISTINCT FROM EXCLUDED.trigger_kind
          AND work_runs.executor_config_json IS NOT DISTINCT FROM EXCLUDED.executor_config_json
          AND work_runs.include_context IS NOT DISTINCT FROM EXCLUDED.include_context
          AND work_runs.completion_policy_version IS NOT DISTINCT FROM EXCLUDED.completion_policy_version
          AND work_runs.hide_on_success IS NOT DISTINCT FROM EXCLUDED.hide_on_success
          AND (work_runs.status NOT IN ('completed', 'failed', 'cancelled')
            OR work_runs.status = EXCLUDED.status)
          AND (work_runs.status <> 'completed'
            OR work_runs.result_json IS NOT DISTINCT FROM EXCLUDED.result_json)
        RETURNING *
      `,
      [
        run.id,
        run.org_id,
        run.work_item_id,
        run.recipe_id,
        run.executor_type,
        run.external_run_id ?? null,
        run.agent_thread_id ?? null,
        run.status,
        run.start_state ?? null,
        jsonb(run.result),
        run.created_at,
        run.updated_at,
        run.version ?? 0,
        run.write_back_required ?? null,
        jsonb(run.write_back_target),
        run.trigger_kind ?? null,
        jsonb(run.executor_config),
        run.include_context ?? null,
        run.completion_policy_version ?? null,
        run.hide_on_success ?? null,
      ],
      client,
    );
    if (!row) throw new Error("Work run identity, write-back snapshot, terminal status and completed result are immutable");
    return toWorkRun(row);
  }

export async function checkpointWorkRunStart(
  db: PgSql, input: WorkRunStartCheckpoint,
): Promise<WorkRunStartCheckpointResult> {
  return db.withTx(async (client) => {
    const orgId = input.expected_item.org_id;
    await lockConversationThreads(db, client, [{
      org_id: orgId,
      thread_id: input.expected_item.thread_id,
    }]);
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_item.id], client,
    );
    const run = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_run.id], client,
    );
    const currentItem = item ? toWorkItem(item) : null;
    const result = prepareWorkRunStartCheckpoint(input, {
      item: currentItem, run: run ? toWorkRun(run) : null,
    });
    if (result.outcome !== "applied") return result;
    await putWorkRun(db, result.run, client, false);
    if (result.item.status !== currentItem?.status) {
      await putWorkItem(db, result.item, client, false);
    }
    const event = workRunStartLifecycleEvent(input, result.run);
    if (event) {
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $10)`, [
        randomUUID(),
        orgId,
        event.thread_id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
        event.event_type,
        event.dedupe_key,
        jsonb(event.payload),
        input.now,
      ], client);
    }
    if (result.cancellation_requested) {
      await enqueueCancellationJob(db, result.run, result.item.thread_id, input.now, client);
    }
    return result;
  });
}

export async function commitWorkObservation(
  db: PgSql,
  input: CommitWorkObservation,
): Promise<CommitWorkObservationResult> {
  return db.withTx(async (client) => {
    const orgId = input.expected_item.org_id;
    await lockConversationThreads(db, client, [{
      org_id: orgId,
      thread_id: input.expected_item.thread_id,
    }]);
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_item.id], client,
    );
    const run = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_run.id], client,
    );
    const delivery = await db.queryOne<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 AND work_item_id = $2
        AND (run_id = $3::text OR (run_id IS NULL AND $3::text IS NULL)) FOR UPDATE`,
      [orgId, input.expected_item.id,
        input.expected_run.write_back_required === undefined ? null : input.expected_run.id], client,
    );
    const prepared = prepareWorkObservation(input, {
      item: item ? toWorkItem(item) : null,
      run: run ? toWorkRun(run) : null,
      delivery: delivery ? toWorkDelivery(delivery) : null,
    });
    if (prepared.outcome !== "applied") return prepared;
    await putWorkRun(db, prepared.transition.run, client, false);
    if (prepared.delivery) await putWorkDelivery(db, prepared.delivery, client, true);
    if (prepared.transition.item.status !== input.expected_item.status) {
      await putWorkItem(db, prepared.transition.item, client, false);
    }
    for (const event of workObservationLifecycleEvents(
      input, prepared.transition, delivery ? toWorkDelivery(delivery) : null, prepared.delivery,
    )) {
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)`, [
        randomUUID(),
        orgId,
        event.thread_id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
        event.event_type,
        event.dedupe_key,
        jsonb(event.payload),
        input.now,
        input.now,
      ], client);
    }
    return { outcome: "applied", transition: prepared.transition };
  });
}

export async function dismissWorkItem(db: PgSql, input: WorkDismissal): Promise<WorkDismissalResult> {
  return db.withTx(async (client) => {
    const { org_id: orgId, id } = input.expected_item;
    if (input.command_id !== undefined) {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
        [orgId, input.command_id],
        client,
      );
      const event = await db.queryOne<{
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload_json: unknown;
      }>(`SELECT aggregate_type, aggregate_id, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
      [orgId, input.command_id], client);
      if (event) {
        const payload = asJson<{ command?: unknown; item?: WorkItem }>(event.payload_json);
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
    await lockConversationThreads(db, client, [{
      org_id: orgId,
      thread_id: input.expected_item.thread_id,
    }]);
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id], client,
    );
    const run = item?.current_run_id ? await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, item.current_run_id], client,
    ) : null;
    const deliveries = await db.query<WorkDeliveryRow>(`SELECT * FROM work_deliveries
      WHERE org_id = $1 AND work_item_id = $2 AND status <> 'acked' ORDER BY id FOR UPDATE`, [orgId, id], client);
    const searchAnswer = input.search_answer_timeout ? await db.queryOne<SearchAnswerRow>(
      "SELECT * FROM search_answers WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.search_answer_timeout.id], client,
    ) : null;
    const result = prepareWorkDismissal(input, {
      item: item ? toWorkItem(item) : null, run: run ? toWorkRun(run) : null,
      deliveries: deliveries.map(toWorkDelivery),
      search_answer: searchAnswer ? toSearchAnswer(searchAnswer) : null,
    });
    if (result.outcome !== "applied") return result;
    const savedDeliveries: WorkDelivery[] = [];
    for (const delivery of result.deliveries) savedDeliveries.push(await putWorkDelivery(db, delivery, client, true));
    const savedItem = await db.queryOne<WorkItemRow>(`UPDATE work_items SET status = 'skipped', version = $1, updated_at = $2
      WHERE org_id = $3 AND id = $4 RETURNING *`, [result.item.version, input.now, orgId, id], client);
    if (!savedItem) throw new Error("Dismissed work item disappeared inside its transaction");
    const savedWorkItem = toWorkItem(savedItem);
    if (input.command_id !== undefined && input.issued_at !== undefined) {
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, 'work_item', $4, $5, 'work_item_transitioned', $6, $7, 1, $8, $9, $10)`,
      [
        randomUUID(),
        orgId,
        savedWorkItem.thread_id,
        id,
        savedWorkItem.version ?? 0,
        input.command_id,
        JSON.stringify(["work_item", id, savedWorkItem.version ?? 0, "work_item_transitioned"]),
        jsonb({
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
      ], client);
    }
    const savedAnswer = result.search_answer ? await db.queryOne<SearchAnswerRow>(
      `UPDATE search_answers SET outcome = 'timed_out', updated_at = $1
        WHERE org_id = $2 AND id = $3 RETURNING *`, [input.now, orgId, result.search_answer.id], client,
    ) : null;
    if (result.search_answer && !savedAnswer) throw new Error("Timed out search answer disappeared inside its transaction");
    if (result.run) {
      await enqueueCancellationJob(db, result.run, savedWorkItem.thread_id, input.now, client);
    }
    if (input.fold_visibility !== false) {
      await setConversationPolicyVisibilityOn(db, client, {
        org_id: orgId,
        thread_id: savedWorkItem.thread_id,
        hidden: true,
        expected_visibility_version: savedWorkItem.visibility_intent_version ?? 0,
        updated_at: input.now,
        ...(savedWorkItem.head_event_id
          ? { fold_excluded_current_work_event_id: savedWorkItem.head_event_id }
          : {}),
      });
    }
    return {
      outcome: "applied", item: savedWorkItem, run: result.run, deliveries: savedDeliveries,
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
  });
}

async function enqueueCancellationJob(
  db: PgSql,
  run: WorkRun,
  threadId: string,
  now: string,
  client: PoolClient,
): Promise<void> {
  if ((run.status !== "running" && run.status !== "waiting_human")
    || (!run.external_run_id && !run.agent_thread_id)) return;
  const dedupeKey = JSON.stringify([
    "work_run", run.id, run.version ?? 0, "cancellation_requested",
  ]);
  const eventId = randomUUID();
  await db.execute(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES ($1, $2, $3, 'work_run', $4, $5, 'cancellation_requested', $6, 1, $7, $8, $8)
  ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
  [
    eventId, run.org_id, threadId, run.id, run.version ?? 0, dedupeKey,
    jsonb({ work_item_id: run.work_item_id, run_id: run.id, reason: "work_dismissed" }),
    now,
  ], client);
  const event = await db.queryOne<{ id: string }>(
    "SELECT id FROM conversation_lifecycle_events WHERE org_id = $1 AND dedupe_key = $2",
    [run.org_id, dedupeKey], client,
  );
  if (!event) throw new Error("Cancellation request lifecycle event was not saved");
  await db.execute(`INSERT INTO conversation_lifecycle_jobs (
    id, org_id, event_id, job_type, run_id, schema_version, status, attempts, created_at, updated_at
  ) VALUES ($1, $2, $3, 'cancel_execution', $4, 1, 'pending', 0, $5, $5)
  ON CONFLICT (org_id, job_type, run_id) DO NOTHING`,
  [randomUUID(), run.org_id, event.id, run.id, now], client);
}

export async function claimCancellationJobs(
  db: PgSql,
  input: ClaimCancellationJobs,
): Promise<CancellationJob[]> {
  assertCancellationClaim(input);
  return db.withTx(async (client) => {
    await db.execute(`UPDATE conversation_lifecycle_jobs SET status = 'dead',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      last_error_code = 'retry_exhausted', outcome_code = 'retry_exhausted',
      completed_at = $1, updated_at = $1
      WHERE org_id = $2 AND status = 'running' AND lease_expires_at <= $1::timestamptz
        AND attempts >= 5`, [input.now, input.org_id], client);
    const rows = await db.query<{ id: string }>(`SELECT id FROM conversation_lifecycle_jobs
      WHERE org_id = $1 AND attempts < 5 AND (
        status = 'pending'
        OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= $2::timestamptz))
        OR (status = 'running' AND lease_expires_at <= $2::timestamptz)
      ) ORDER BY created_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
    [input.org_id, input.now, input.limit], client);
    const expiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    for (const { id } of rows) {
      await db.execute(`UPDATE conversation_lifecycle_jobs SET status = 'running',
        attempts = attempts + 1, lease_owner = $1, claim_token = $2,
        lease_expires_at = $3, next_retry_at = NULL, last_error_code = NULL,
        last_error = NULL, outcome_code = NULL, completed_at = NULL, updated_at = $4
        WHERE org_id = $5 AND id = $6`,
      [input.owner, randomUUID(), expiresAt, input.now, input.org_id, id], client);
    }
    if (!rows.length) return [];
    const claimed = await db.query<CancellationJobRow>(
      `SELECT * FROM conversation_lifecycle_jobs WHERE org_id = $1 AND id = ANY($2::text[])`,
      [input.org_id, rows.map((row) => row.id)], client,
    );
    const byId = new Map(claimed.map((row) => [row.id, toCancellationJob(row)] as const));
    return rows.map(({ id }) => byId.get(id)!);
  });
}

export async function renewCancellationJob(
  db: PgSql,
  input: RenewCancellationJob,
): Promise<boolean> {
  assertCancellationLease(input);
  if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
    throw new Error("Invalid cancellation job lease renewal");
  }
  return await db.execute(`UPDATE conversation_lifecycle_jobs SET lease_expires_at = $1, updated_at = $2
    WHERE org_id = $3 AND id = $4 AND status = 'running' AND lease_owner = $5
      AND claim_token = $6 AND lease_expires_at > $2::timestamptz`,
  [
    new Date(Date.parse(input.now) + input.lease_ms).toISOString(),
    input.now, input.org_id, input.id, input.owner, input.claim_token,
  ]) === 1;
}

export async function settleCancellationJob(
  db: PgSql,
  input: SettleCancellationJob,
): Promise<boolean> {
  assertCancellationLease(input);
  if (input.kind === "succeeded") {
    if (!input.outcome_code.trim()) throw new Error("Cancellation job outcome is required");
    return await db.execute(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = NULL, outcome_code = $1, completed_at = $2, updated_at = $2
      WHERE org_id = $3 AND id = $4 AND status = 'running' AND lease_owner = $5
        AND claim_token = $6 AND lease_expires_at > $2::timestamptz`,
    [input.outcome_code.slice(0, 120), input.now, input.org_id, input.id, input.owner, input.claim_token]) === 1;
  }
  if (!Number.isFinite(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
    throw new Error("Invalid cancellation job failure");
  }
  return await db.execute(`UPDATE conversation_lifecycle_jobs SET
      status = CASE WHEN attempts >= 5 THEN 'dead' ELSE 'failed' END,
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = CASE WHEN attempts >= 5 THEN NULL ELSE $1::timestamptz END,
      last_error_code = $2, last_error = $3,
      outcome_code = CASE WHEN attempts >= 5 THEN 'retry_exhausted' ELSE NULL END,
      completed_at = CASE WHEN attempts >= 5 THEN $4 ELSE NULL END, updated_at = $4
      WHERE org_id = $5 AND id = $6 AND status = 'running' AND lease_owner = $7
        AND claim_token = $8 AND lease_expires_at > $4::timestamptz`,
  [
    input.next_retry_at, input.error_code.slice(0, 120), input.error.slice(0, 1000),
    input.now, input.org_id, input.id, input.owner, input.claim_token,
  ]) === 1;
}

export async function listCancellationJobs(
  db: PgSql,
  orgId: string,
  limit = 100,
  statuses?: CancellationJob["status"][],
): Promise<CancellationJob[]> {
  if (statuses?.length === 0) return [];
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(500, limit))
    : 100;
  const ordering = statuses ? "DESC" : "ASC";
  const rows = statuses
    ? await db.query<CancellationJobRow>(
      `SELECT * FROM conversation_lifecycle_jobs
        WHERE org_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at ${ordering}, id ${ordering} LIMIT $3`,
      [orgId, statuses, boundedLimit],
    )
    : await db.query<CancellationJobRow>(
      `SELECT * FROM conversation_lifecycle_jobs WHERE org_id = $1 ORDER BY created_at ${ordering}, id ${ordering} LIMIT $2`,
      [orgId, boundedLimit],
    );
  return rows.map(toCancellationJob);
}

export async function retryCancellationJob(
  db: PgSql,
  input: RetryCancellationJob,
): Promise<RetryCancellationJobResult> {
  assertRetryCancellationJob(input);
  return db.withTx(async (client) => {
    const replay = await readCancellationJobRetryReplay(db, client, input);
    if (replay) return replay;

    const row = await db.queryOne<CancellationJobRow>(
      "SELECT * FROM conversation_lifecycle_jobs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.id], client,
    );
    if (!row) return { outcome: "not_found" };
    const replayAfterLock = await readCancellationJobRetryReplay(db, client, input);
    if (replayAfterLock) return replayAfterLock;
    const job = toCancellationJob(row);
    if (job.status !== "dead" || job.attempts !== input.expected_attempts) {
      return { outcome: "conflict" };
    }
    const context = await db.queryOne<{ thread_id: string }>(
      `SELECT w.thread_id FROM work_runs r
        JOIN work_items w ON w.org_id = r.org_id AND w.id = r.work_item_id
        WHERE r.org_id = $1 AND r.id = $2`,
      [input.org_id, job.run_id], client,
    );
    if (!context) return { outcome: "conflict" };
    const event = await db.queryOne<{ id: string }>(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES ($1, $2, $3, 'work_run', $4, $5, 'cancellation_requested', $6, $7, 1, $8, $9, $9)
      ON CONFLICT (org_id, command_id) WHERE command_id IS NOT NULL DO NOTHING
      RETURNING id`, [
      randomUUID(), input.org_id, context.thread_id, input.id, job.attempts,
      input.command_id, JSON.stringify(["cancellation_job_retry", input.command_id]),
      jsonb({ command: input, reason: "manual_retry" }), input.issued_at,
    ], client);
    if (!event) {
      return await readCancellationJobRetryReplay(db, client, input)
        ?? { outcome: "conflict" };
    }
    const updated = await db.queryOne<CancellationJobRow>(`UPDATE conversation_lifecycle_jobs SET
      status = 'pending', attempts = 0, lease_owner = NULL, claim_token = NULL,
      lease_expires_at = NULL, next_retry_at = NULL, last_error_code = NULL,
      last_error = NULL, outcome_code = NULL, completed_at = NULL, updated_at = $1
      WHERE org_id = $2 AND id = $3 AND status = 'dead' AND attempts = $4
      RETURNING *`,
    [input.issued_at, input.org_id, input.id, input.expected_attempts], client);
    if (!updated) throw new Error("Cancellation job changed inside retry transaction");
    return { outcome: "applied", job: toCancellationJob(updated) };
  });
}

async function readCancellationJobRetryReplay(
  db: PgSql,
  client: PoolClient,
  input: RetryCancellationJob,
): Promise<RetryCancellationJobResult | null> {
  const previous = await db.queryOne<{
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload_json: unknown;
  }>(
    "SELECT aggregate_type, aggregate_id, event_type, payload_json FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2",
    [input.org_id, input.command_id], client,
  );
  if (!previous) return null;
  const payload = typeof previous.payload_json === "string"
    ? JSON.parse(previous.payload_json) as { command?: unknown }
    : previous.payload_json as { command?: unknown };
  if (previous.aggregate_type !== "work_run" || previous.aggregate_id !== input.id
    || previous.event_type !== "cancellation_requested"
    || !sameRetryCancellationJobCommand(payload.command, input)) {
    return { outcome: "conflict" };
  }
  const row = await db.queryOne<CancellationJobRow>(
    "SELECT * FROM conversation_lifecycle_jobs WHERE org_id = $1 AND id = $2",
    [input.org_id, input.id], client,
  );
  return row ? { outcome: "replayed", job: toCancellationJob(row) } : { outcome: "not_found" };
}

function assertRetryCancellationJob(input: RetryCancellationJob): void {
  if (!Number.isSafeInteger(input.expected_attempts) || input.expected_attempts < 0
    || !input.command_id.trim() || input.command_id !== input.command_id.trim()
    || input.command_id.length > 128 || !Number.isFinite(Date.parse(input.issued_at))) {
    throw new Error("Invalid cancellation job retry command");
  }
}

function sameRetryCancellationJobCommand(value: unknown, command: RetryCancellationJob): boolean {
  if (!value || typeof value !== "object") return false;
  const prior = value as Partial<RetryCancellationJob>;
  return prior.org_id === command.org_id && prior.id === command.id
    && prior.expected_attempts === command.expected_attempts
    && prior.command_id === command.command_id && prior.issued_at === command.issued_at;
}

export async function commitCancellationJobObservation(
  db: PgSql,
  input: CommitCancellationJobObservation,
): Promise<CommitCancellationJobObservationResult> {
  return db.withTx(async (client) => {
    const identity = await db.queryOne<{ thread_id: string }>(
      "SELECT thread_id FROM work_items WHERE org_id = $1 AND id = $2",
      [input.org_id, input.expected_run.work_item_id], client,
    );
    if (!identity) return { outcome: "conflict" };
    await lockConversationThreads(db, client, [{
      org_id: input.org_id,
      thread_id: identity.thread_id,
    }]);
    const itemRow = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.expected_run.work_item_id], client,
    );
    const runRow = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.expected_run.id], client,
    );
    const jobRow = await db.queryOne<CancellationJobRow>(
      "SELECT * FROM conversation_lifecycle_jobs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.id], client,
    );
    const job = jobRow ? toCancellationJob(jobRow) : null;
    if (!hasCancellationJobLease(job, input)) return { outcome: "conflict" };
    const item = itemRow ? toWorkItem(itemRow) : null;
    const run = runRow ? toWorkRun(runRow) : null;
    if (!item || !run || item.status !== "skipped" || item.current_run_id !== run.id
      || job.run_id !== run.id || run.work_item_id !== item.id) return { outcome: "conflict" };
    const prepared = prepareCancellationJobObservation(input, run);
    if (prepared.outcome === "conflict") return prepared;
    if (prepared.outcome === "already_terminal") {
      const settled = await db.execute(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
        lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, outcome_code = 'already_finished',
        completed_at = $1, updated_at = $1
        WHERE org_id = $2 AND id = $3 AND status = 'running' AND lease_owner = $4
          AND claim_token = $5 AND lease_expires_at > $1::timestamptz`,
      [input.now, input.org_id, input.id, input.owner, input.claim_token], client);
      return settled === 1 ? prepared : { outcome: "conflict" };
    }
    const savedRun = await putWorkRun(db, prepared.run, client, true);
    await db.execute(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES ($1, $2, $3, 'work_run', $4, $5, 'work_run_transitioned', $6, 1, $7, $8, $8)`,
    [
      randomUUID(), input.org_id, item.thread_id, savedRun.id, savedRun.version ?? 0,
      JSON.stringify(["work_run", savedRun.id, savedRun.version ?? 0, "work_run_transitioned"]),
      jsonb({
        work_item_id: item.id,
        run_id: savedRun.id,
        from_status: run.status,
        to_status: savedRun.status,
        reason: "cancellation_job",
      }),
      input.now,
    ], client);
    const settled = await db.execute(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = NULL, outcome_code = $1, completed_at = $2, updated_at = $2
      WHERE org_id = $3 AND id = $4 AND status = 'running' AND lease_owner = $5
        AND claim_token = $6 AND lease_expires_at > $2::timestamptz`,
    [
      `observed_${savedRun.status}`, input.now, input.org_id, input.id, input.owner, input.claim_token,
    ], client);
    if (settled !== 1) throw new Error("Cancellation job lease changed during observation commit");
    return { outcome: "applied", run: savedRun };
  });
}

interface CancellationJobRow {
  id: string;
  org_id: string;
  event_id: string;
  job_type: "cancel_execution";
  run_id: string;
  schema_version: number | string;
  status: CancellationJob["status"];
  attempts: number | string;
  lease_owner: string | null;
  claim_token: string | null;
  lease_expires_at: unknown;
  next_retry_at: unknown;
  last_error_code: string | null;
  last_error: string | null;
  outcome_code: string | null;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

function toCancellationJob(row: CancellationJobRow): CancellationJob {
  return {
    id: row.id,
    org_id: row.org_id,
    event_id: row.event_id,
    job_type: row.job_type,
    run_id: row.run_id,
    schema_version: asNumber(row.schema_version),
    status: row.status,
    attempts: asNumber(row.attempts),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.claim_token ? { claim_token: row.claim_token } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: toIso(row.lease_expires_at) } : {}),
    ...(row.next_retry_at ? { next_retry_at: toIso(row.next_retry_at) } : {}),
    ...(row.last_error_code ? { last_error_code: row.last_error_code } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    ...(row.outcome_code ? { outcome_code: row.outcome_code } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
  };
}

function assertCancellationClaim(input: ClaimCancellationJobs): void {
  assertCancellationLease(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
    throw new Error("Invalid cancellation job claim");
  }
}

function assertCancellationLease(input: {
  org_id: string;
  id?: string;
  owner: string;
  claim_token?: string;
  now: string;
}): void {
  if (!input.org_id.trim() || !input.owner.trim()
    || (input.id !== undefined && !input.id.trim())
    || (input.claim_token !== undefined && !input.claim_token.trim())
    || !Number.isFinite(Date.parse(input.now))) {
    throw new Error("Invalid cancellation job lease identity");
  }
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
  db: PgSql,
  input: WorkAcknowledgment,
): Promise<WorkAcknowledgmentResult> {
  assertWorkAcknowledgmentAttentionBinding(input);
  return db.withTx(async (client) => {
    const orgId = input.expected_item.org_id;
    await db.queryOne(
      "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
      [orgId, input.command_id], client,
    );
    await lockConversationThreads(db, client, [{
      org_id: orgId,
      thread_id: input.expected_item.thread_id,
    }]);
    if (input.conversation_attention) {
      await putConversationPrefOn(db, client, input.conversation_attention);
    }
    const priorEvent = await db.queryOne<{
      aggregate_type: string; aggregate_id: string; event_type: string; payload_json: unknown;
    }>(`SELECT aggregate_type, aggregate_id, event_type, payload_json
      FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
    [orgId, input.command_id], client);
    if (priorEvent) {
      const payload = asJson<{ command?: unknown; item?: WorkItem }>(priorEvent.payload_json);
      if (priorEvent.aggregate_type !== "work_item" || priorEvent.aggregate_id !== input.expected_item.id
        || priorEvent.event_type !== "work_acknowledged"
        || !sameWorkAcknowledgmentCommand(payload.command, input) || !payload.item) {
        return { outcome: "conflict", reason: "command_conflict" };
      }
      return { outcome: "replayed", item: payload.item };
    }
    const itemRow = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_item.id], client,
    );
    const item = itemRow ? toWorkItem(itemRow) : null;
    const runRow = item?.current_run_id ? await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, item.current_run_id], client,
    ) : null;
    const deliveryRow = await db.queryOne<WorkDeliveryRow>(`SELECT * FROM work_deliveries
      WHERE org_id = $1 AND work_item_id = $2 AND run_id = $3 FOR UPDATE`,
    [orgId, input.expected_item.id, input.run_id], client);
    const triggerRow = await db.queryOne<{
      thread_id: string | null;
      source: string;
      external_id: string;
      disposition: string;
      reason_codes: unknown;
    }>(`SELECT e.thread_id, e.source, e.external_id, d.disposition, d.reason_codes
      FROM events e JOIN message_dispositions d ON d.event_id = e.id AND d.org_id = e.org_id
      WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF d`,
    [orgId, input.trigger_event_id], client);
    const result = prepareWorkAcknowledgment(input, {
      item,
      run: runRow ? toWorkRun(runRow) : null,
      delivery: deliveryRow ? toWorkDelivery(deliveryRow) : null,
      trigger_is_current_work: Boolean(triggerRow && item
        && (triggerRow.thread_id ?? conversationId(triggerRow.source, triggerRow.external_id, input.trigger_event_id)) === item.thread_id
        && isFinishedWorkTriggerDecision(triggerRow.disposition,
          asJson<string[]>(triggerRow.reason_codes), item, runRow ? toWorkRun(runRow) : null)),
    });
    if (result.outcome !== "applied") return result;
    const reasonCodes = [...new Set([
      ...(triggerRow ? asJson<string[]>(triggerRow.reason_codes) : []),
      "result_acknowledged",
    ])];
    await db.execute(`UPDATE message_dispositions SET disposition = 'outside_current_work',
      reason_codes = $1, decided_at = $2, version = version + 1
      WHERE org_id = $3 AND event_id = $4 AND disposition IN ('current_work', 'pending')`,
    [jsonb(reasonCodes), input.now, orgId, input.trigger_event_id], client);
    await refreshThreadHeadWithinTransaction(db, orgId, item!.thread_id, client);
    const savedRow = await db.queryOne<WorkItemRow>(`UPDATE work_items
      SET acknowledged_run_id = $1, version = $2, updated_at = $3
      WHERE org_id = $4 AND id = $5 RETURNING *`,
    [input.run_id, result.item.version, input.now, orgId, input.expected_item.id], client);
    if (!savedRow) throw new Error("Acknowledged work item disappeared inside its transaction");
    const savedItem = toWorkItem(savedRow);
    const remainingCurrentWork = await hasCurrentWorkForThread(db, client, orgId, item!.thread_id);
    const unfinishedWork = await db.queryOne(`SELECT 1 FROM work_items
      WHERE org_id = $1 AND thread_id = $2 AND (
        status IN ('open', 'running', 'waiting_human', 'failed')
        OR (status = 'done' AND (current_run_id IS NULL OR acknowledged_run_id IS NULL
          OR acknowledged_run_id <> current_run_id))
      ) LIMIT 1`, [orgId, item!.thread_id], client);
    const unresolvedDelivery = await db.queryOne(`SELECT 1 FROM work_deliveries
      WHERE org_id = $1 AND work_item_id IN (
        SELECT id FROM work_items WHERE org_id = $1 AND thread_id = $2
      ) AND status <> 'acked' LIMIT 1`, [orgId, item!.thread_id], client);
    const pref = await db.queryOne<{
      hidden: boolean; hidden_reason: string | null; visibility_version: number | string;
    }>(`SELECT hidden, hidden_reason, visibility_version FROM conversation_prefs
      WHERE org_id = $1 AND thread_id = $2 FOR UPDATE`, [orgId, item!.thread_id], client);
    const visibilityVersion = asNumber(pref?.visibility_version ?? 0);
    const recipeVisibility = item?.recipe_id
      ? await db.queryOne<{ hide_on_success: boolean }>(
        "SELECT hide_on_success FROM recipes WHERE org_id = $1 AND id = $2",
        [orgId, item.recipe_id], client)
      : undefined;
    const hideOnSuccess = runRow?.hide_on_success ?? recipeVisibility?.hide_on_success ?? true;
    if (!remainingCurrentWork && !unfinishedWork && !unresolvedDelivery
      && hideOnSuccess
      && visibilityVersion === (item!.visibility_intent_version ?? 0)
      && !(asBool(pref?.hidden) && pref?.hidden_reason !== "policy")) {
      const folded = await putConversationPrefOn(db, client, {
        org_id: orgId, thread_id: item!.thread_id, hidden: true,
        hidden_reason: "policy", updated_at: input.now,
      });
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, 'conversation', $4, $5, 'visibility_changed', NULL, $6, 1, $7, $8, $9)`,
      [
        randomUUID(), orgId, item!.thread_id, item!.thread_id, visibilityVersion,
        JSON.stringify(["conversation", item!.thread_id, "policy_fold", savedItem.id, savedItem.version]),
        jsonb({ hidden: folded.hidden, hidden_reason: folded.hidden_reason, cause: "result_acknowledged" }),
        input.issued_at, input.now,
      ], client);
    }
    await db.execute(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES ($1, $2, $3, 'source_event', $4, $5, 'current_work_changed', NULL, $6, 1, $7, $8, $9)`,
    [
      randomUUID(), orgId, item!.thread_id, input.trigger_event_id, savedItem.version ?? 0,
      JSON.stringify(["source_event", input.trigger_event_id, savedItem.version ?? 0, "current_work_changed"]),
      jsonb({ work_item_id: savedItem.id, disposition: "outside_current_work", reason: "result_acknowledged" }),
      input.issued_at, input.now,
    ], client);
    await db.execute(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES ($1, $2, $3, 'work_item', $4, $5, 'work_acknowledged', $6, $7, 1, $8, $9, $10)`,
    [
      randomUUID(), orgId, savedItem.thread_id, savedItem.id, savedItem.version ?? 0,
      input.command_id,
      JSON.stringify(["work_item", savedItem.id, savedItem.version ?? 0, "work_acknowledged"]),
      jsonb({ command: input, item: savedItem }),
      input.issued_at, input.now,
    ], client);
    return { outcome: "applied", item: savedItem };
  });
}

export async function recordWorkRunStartFailure(
  db: PgSql, input: WorkRunStartFailure,
): Promise<WorkRunStartFailureResult> {
  return db.withTx(async (client) => {
    const { run } = input;
    const identity = await db.queryOne<{ thread_id: string }>(
      "SELECT thread_id FROM work_items WHERE org_id = $1 AND id = $2",
      [run.org_id, run.work_item_id], client,
    );
    if (!identity) return { outcome: "conflict", reason: "missing_work" };
    await lockConversationThreads(db, client, [{
      org_id: run.org_id,
      thread_id: identity.thread_id,
    }]);
    const recipe = await db.queryOne("SELECT id FROM recipes WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [run.org_id, run.recipe_id], client);
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [run.org_id, run.work_item_id], client,
    );
    const active = await db.queryOne(`SELECT id FROM work_runs WHERE org_id = $1 AND work_item_id = $2
      AND status IN ('running', 'waiting_human') LIMIT 1`, [run.org_id, run.work_item_id], client);
    const unresolved = await db.queryOne(`SELECT id FROM work_deliveries
      WHERE org_id = $1 AND work_item_id = $2 AND status <> 'acked' LIMIT 1`,
      [run.org_id, run.work_item_id], client);
    const result = prepareWorkRunStartFailure(input, {
      item: item ? toWorkItem(item) : null, recipe_exists: Boolean(recipe),
      active_run: Boolean(active), unresolved_delivery: Boolean(unresolved),
    });
    if (result.outcome !== "applied") return result;
    if (await db.queryOne("SELECT id FROM work_runs WHERE id = $1", [run.id], client)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    const savedRun = await putWorkRun(db, result.run, client, false);
    const savedItem = await db.queryOne<WorkItemRow>(`UPDATE work_items
      SET status = $1, current_run_id = $2, version = $3, updated_at = $4
      WHERE org_id = $5 AND id = $6 RETURNING *`, [
      result.item.status, result.item.current_run_id ?? null, result.item.version,
      result.item.updated_at, run.org_id, run.work_item_id,
    ], client);
    if (!savedItem) throw new Error("Work start failure item disappeared inside its transaction");
    return { outcome: "applied", item: toWorkItem(savedItem), run: savedRun };
  });
}

export async function getWorkRunStartReplay(
  db: PgSql,
  command: WorkRunStartCommand,
): Promise<WorkRunStartReplay> {
  const event = await db.queryOne<{
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload_json: unknown;
  }>(`SELECT aggregate_type, aggregate_id, event_type, payload_json
    FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
  [command.org_id, command.command_id]);
  if (!event) return { outcome: "not_found" };
  const payload = asJson<{ command?: unknown; run_id?: unknown }>(event.payload_json);
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

export async function claimWorkRunStart(db: PgSql, input: WorkRunStartClaim): Promise<boolean> {
  const { run, max_concurrent } = input;
  return db.withTx(async (client) => {
    const command = workRunStartCommand(input);
    if (command) {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
        [command.org_id, command.command_id],
        client,
      );
      if (await db.queryOne(
        "SELECT id FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2",
        [command.org_id, command.command_id],
        client,
      )) return false;
    }
    const identity = input.expected_item
      ? { thread_id: input.expected_item.thread_id }
      : await db.queryOne<{ thread_id: string }>(
          "SELECT thread_id FROM work_items WHERE org_id = $1 AND id = $2",
          [run.org_id, run.work_item_id],
          client,
        );
    if (!identity) return false;
    await lockConversationThreads(db, client, [{
      org_id: run.org_id,
      thread_id: identity.thread_id,
    }]);
    // Recipe lock also serializes capacity checks for different work items.
    const recipe = await db.queryOne<RecipeRow>(`
      SELECT * FROM recipes WHERE org_id = $1 AND id = $2 FOR UPDATE
    `, [run.org_id, run.recipe_id], client);
    if (!recipe) return false;
    if (input.expected_recipe !== undefined && (
      input.expected_recipe.id !== run.recipe_id ||
      input.expected_recipe.org_id !== run.org_id ||
      !isDeepStrictEqual(toRecipe(recipe), input.expected_recipe)
    )) return false;
    const item = await db.queryOne<WorkItemRow>(`
      SELECT * FROM work_items WHERE org_id = $1 AND id = $2
        FOR UPDATE
    `, [run.org_id, run.work_item_id], client);
    if (!item) return false;
    const workItem = toWorkItem(item);
    const trigger = input.require_current_work_trigger && workItem.head_event_id
      ? await db.queryOne<{
          id: string;
          org_id: string;
          source: string;
          external_id: string;
          thread_id: string | null;
          operation: string;
          disposition: string;
          reason_codes: unknown;
        }>(
          `SELECT e.id, e.org_id, e.source, e.external_id, e.thread_id,
                  e.operation, d.disposition, d.reason_codes
           FROM events e
           JOIN message_dispositions d ON d.event_id = e.id
           WHERE e.id = $1 AND EXISTS (
             SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
           )
           FOR SHARE OF e, d`,
          [workItem.head_event_id], client,
        )
      : null;
    const triggerIsCurrentWork = Boolean(
      trigger &&
      trigger.org_id === run.org_id &&
      trigger.operation !== "tombstone" &&
      isWorkTriggerDecision(trigger.disposition, asJson<string[]>(trigger.reason_codes),
        workItem, toRecipe(recipe)) &&
      (trigger.thread_id ?? conversationId(
        trigger.source,
        trigger.external_id,
        trigger.id,
      )) === workItem.thread_id,
    );
    if (!canClaimWorkRunStartItem(input, workItem, triggerIsCurrentWork)) return false;
    if (input.visibility_intent_version !== undefined) {
      const currentVisibility = await db.queryOne<{ visibility_version: number | string }>(
        "SELECT visibility_version FROM conversation_prefs WHERE org_id = $1 AND thread_id = $2",
        [run.org_id, workItem.thread_id],
        client,
      );
      if (asNumber(currentVisibility?.visibility_version ?? 0) !== input.visibility_intent_version) {
        return false;
      }
    }
    const active = await db.queryOne(`
      SELECT id FROM work_runs WHERE org_id = $1 AND work_item_id = $2
        AND status IN ('running', 'waiting_human') LIMIT 1
    `, [run.org_id, run.work_item_id], client);
    if (active) return false;
    if (await db.queryOne(
      "SELECT id FROM work_deliveries WHERE org_id = $1 AND work_item_id = $2 AND status <> 'acked' LIMIT 1",
      [run.org_id, run.work_item_id], client,
    )) return false;
    if (max_concurrent !== undefined) {
      const occupied = await db.queryOne<{ count: string }>(`
        SELECT COUNT(*) AS count FROM work_items WHERE org_id = $1 AND recipe_id = $2
          AND status IN ('running', 'waiting_human')
      `, [run.org_id, run.recipe_id], client);
      if (Number(occupied?.count) >= max_concurrent) return false;
    }
    if (await db.queryOne("SELECT id FROM work_runs WHERE id = $1", [run.id], client)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    if (input.retry === "manual" && workItem.current_run_id
      && workItem.acknowledged_run_id === workItem.current_run_id && workItem.head_event_id) {
      const trigger = await db.queryOne<{
        id: string;
        thread_id: string | null;
        source: string;
        external_id: string;
        operation: string;
        disposition: string;
        reason_codes_json: string;
        version: number | string;
      }>(`SELECT e.id, e.thread_id, e.source, e.external_id, e.operation,
                 d.disposition, d.reason_codes_json, d.version
          FROM events e JOIN message_dispositions d ON d.event_id = e.id
          WHERE e.org_id = $1 AND e.id = $2 AND d.org_id = $1
            AND EXISTS (SELECT 1 FROM source_heads h
              WHERE h.org_id = e.org_id AND h.current_event_id = e.id)
          FOR UPDATE OF e, d`,
      [run.org_id, workItem.head_event_id], client);
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
        const version = asNumber(trigger.version);
        const nextVersion = version + 1;
        const restored = await db.queryOne<{ version: number | string }>(`
          UPDATE message_dispositions SET disposition = 'current_work',
            reason_codes_json = $1, decided_at = $2, version = $3
          WHERE org_id = $4 AND event_id = $5
            AND disposition = 'outside_current_work' AND version = $6
          RETURNING version
        `, [JSON.stringify(nextReasonCodes), run.created_at, nextVersion,
          run.org_id, trigger.id, version], client);
        if (!restored) throw new Error("Acknowledged trigger changed inside its run-start transaction");
        await refreshThreadHeadWithinTransaction(db, run.org_id, workItem.thread_id, client);
        await db.execute(`INSERT INTO conversation_lifecycle_events (
          id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
          event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
        ) VALUES ($1, $2, $3, 'source_event', $4, $5, 'current_work_changed', NULL, $6, 1, $7, $8, $9)`,
        [
          randomUUID(), run.org_id, workItem.thread_id, trigger.id, nextVersion,
          JSON.stringify(["source_event", trigger.id, nextVersion, "current_work_changed"]),
          jsonb({
            source: "manual_retry",
            work_item_id: workItem.id,
            previous: { disposition: "outside_current_work", reason_codes: reasonCodes },
            result: { disposition: "current_work", reason_codes: nextReasonCodes },
          }),
          run.created_at, run.created_at,
        ], client);
      }
    }
    await putWorkRun(db, run, client, false);
    await db.execute("UPDATE work_items SET status = 'running', recipe_id = $1, current_run_id = $2, acknowledged_run_id = NULL, visibility_intent_version = $3, version = version + 1, updated_at = $4 WHERE org_id = $5 AND id = $6",
      [run.recipe_id, run.id, input.visibility_intent_version ?? workItem.visibility_intent_version ?? 0,
        run.updated_at, run.org_id, run.work_item_id], client);
    if (command) {
      const version = (workItem.version ?? 0) + 1;
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, 'work_item', $4, $5, 'work_run_transitioned', $6, $7, 1, $8, $9, $10)`,
      [
        `lifecycle-${randomUUID()}`,
        command.org_id,
        workItem.thread_id,
        command.work_item_id,
        version,
        command.command_id,
        JSON.stringify(["work_item", command.work_item_id, version, "work_run_transitioned"]),
        jsonb({ command, run_id: run.id }),
        run.created_at,
        run.created_at,
      ], client);
    }
    return true;
  });
}

export async function getSearchAnswer(
  db: PgSql,
  orgId: string,
  id: string,
): Promise<SearchAnswerRecord | null> {
  const row = await db.queryOne<SearchAnswerRow>(
    `SELECT * FROM search_answers WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  return row ? toSearchAnswer(row) : null;
}

export async function putSearchAnswer(
  db: PgSql,
  record: SearchAnswerRecord,
): Promise<SearchAnswerRecord> {
  const saved = await db.queryOne<SearchAnswerRow>(
    `
      INSERT INTO search_answers (
        id, org_id, work_item_id, query, event_ids_json, scope_json, outcome, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        work_item_id = EXCLUDED.work_item_id,
        query = EXCLUDED.query,
        event_ids_json = EXCLUDED.event_ids_json,
        scope_json = EXCLUDED.scope_json,
        outcome = EXCLUDED.outcome,
        updated_at = EXCLUDED.updated_at
      WHERE search_answers.org_id = EXCLUDED.org_id
        AND search_answers.work_item_id = EXCLUDED.work_item_id
        AND search_answers.outcome IS NOT DISTINCT FROM EXCLUDED.outcome
      RETURNING *
    `,
    [
      record.id,
      record.org_id,
      record.work_item_id,
      record.query,
      jsonb(record.event_ids),
      record.scope ? jsonb(record.scope) : null,
      record.outcome ?? null,
      record.created_at,
      record.updated_at,
    ],
  );
  if (!saved) throw new Error("Search answer identity and outcome cannot be changed through ordinary writes");
  return toSearchAnswer(saved);
}

export async function deleteSearchAnswer(
  db: PgSql,
  orgId: string,
  id: string,
): Promise<boolean> {
  return (await db.execute(
    "DELETE FROM search_answers WHERE org_id = $1 AND id = $2",
    [orgId, id],
  )) > 0;
}

export async function listWorkDeliveries(db: PgSql, orgId: string): Promise<WorkDelivery[]> {
    const rows = await db.query<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toWorkDelivery);
  }

export async function listDueWorkDeliveries(db: PgSql, orgId: string, now: string): Promise<WorkDelivery[]> {
    const rows = await db.query<WorkDeliveryRow>(
      `
        SELECT * FROM work_deliveries
        WHERE org_id = $1
          AND payload_json IS NOT NULL
          AND status NOT IN ('acked', 'dead')
          AND (
            (status = 'uncertain' AND channel_receipt_json->>'accepted' = 'true')
            OR (
              status = 'queued'
              AND (
                write_back IS NULL
                OR write_back <> 'failed'
                OR next_retry_at IS NULL
                OR next_retry_at <= $2
              )
            )
            OR (
              write_back = 'failed'
              AND (next_retry_at IS NULL OR next_retry_at <= $2)
            )
            OR (
              status IN ('running', 'write_back')
              AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
            )
          )
        ORDER BY updated_at, id
      `,
      [orgId, now],
    );
    return rows.map(toWorkDelivery);
  }

export async function getWorkDelivery(db: PgSql, orgId: string, id: string): Promise<WorkDelivery | null> {
    const row = await db.queryOne<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkDelivery(row) : null;
  }

export async function getWorkDeliveryByItem(db: PgSql, orgId: string, workItemId: string): Promise<WorkDelivery | null> {
    const row = await db.queryOne<WorkDeliveryRow>(
      `SELECT d.* FROM work_deliveries d
       LEFT JOIN work_items w ON w.org_id = d.org_id AND w.id = d.work_item_id
       LEFT JOIN work_runs r ON r.org_id = w.org_id AND r.id = w.current_run_id
       WHERE d.org_id = $1 AND d.work_item_id = $2
         AND (d.run_id = w.current_run_id OR (d.run_id IS NULL AND r.write_back_required IS NULL))
       ORDER BY d.created_at, d.id LIMIT 1`,
      [orgId, workItemId],
    );
    return row ? toWorkDelivery(row) : null;
  }

export async function transitionWorkDelivery(
  db: PgSql, input: WorkDeliveryCommand,
): Promise<WorkDeliveryCommandResult> {
  return db.withTx(async (client) => {
    if (input.kind === "retry" || input.kind === "reconcile") {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
        [input.org_id, input.command_id], client,
      );
      const event = await db.queryOne<{
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload_json: unknown;
      }>(`SELECT aggregate_type, aggregate_id, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
      [input.org_id, input.command_id], client);
      if (event) {
        const payload = asJson<{ command?: unknown; delivery?: WorkDelivery }>(event.payload_json);
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
    const identity = await db.queryOne<{ org_id: string; thread_id: string }>(
      `SELECT w.org_id, w.thread_id FROM work_items w
       JOIN work_deliveries d ON d.org_id = w.org_id AND d.work_item_id = w.id
       WHERE d.org_id = $1 AND d.id = $2`,
      [input.org_id, input.delivery_id], client,
    );
    if (identity) {
      await lockConversationThreads(db, client, [{
        org_id: identity.org_id,
        thread_id: identity.thread_id,
      }]);
    }
    const item = await db.queryOne<{ status: string; version: number; thread_id: string }>(
      `SELECT w.status, w.version, w.thread_id FROM work_items w JOIN work_deliveries d
       ON d.org_id = w.org_id AND d.work_item_id = w.id
       WHERE d.org_id = $1 AND d.id = $2 FOR UPDATE OF w`,
      [input.org_id, input.delivery_id], client,
    );
    const row = await db.queryOne<WorkDeliveryRow>(
      "SELECT * FROM work_deliveries WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.delivery_id], client,
    );
    if ((input.kind === "retry" || input.kind === "reconcile") &&
      item?.version !== input.expected_item_version) {
      return { outcome: "conflict", reason: "not_claimable" };
    }
    let result = planWorkDeliveryCommand(row ? toWorkDelivery(row) : null, item?.status, input);
    if (result.outcome === "applied") {
      const savedDelivery = await putWorkDelivery(db, result.delivery, client, true);
      result = { ...result, delivery: savedDelivery };
      if (row && item) {
        const lifecycleVersion = await db.queryOne<{ version: number }>(`SELECT
          COALESCE(MAX(aggregate_version), 0) + 1 AS version
          FROM conversation_lifecycle_events
          WHERE org_id = $1 AND aggregate_type = 'work_delivery' AND aggregate_id = $2`,
        [input.org_id, input.delivery_id], client);
        if (!lifecycleVersion) throw new Error("Delivery lifecycle version query returned no row");
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
          await db.execute(`INSERT INTO conversation_lifecycle_events (
            id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
            event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
          ) VALUES ($1, $2, $3, 'work_delivery', $4, $5, $6, $7, $8, 1, $9, $10, $11)`,
          [
            randomUUID(), input.org_id, event.thread_id, input.delivery_id, event.aggregate_version,
            event.event_type, "command_id" in input ? input.command_id : null,
            event.dedupe_key, jsonb({ ...event.payload, ...commandResult }),
            "issued_at" in input ? input.issued_at : input.now, input.now,
          ], client);
        }
      }
    }
    return result;
  });
}

async function putWorkDelivery(
  db: PgSql, delivery: WorkDelivery, client?: PoolClient, commandWrite = false,
): Promise<WorkDelivery> {
    if (!client) {
      return db.withTx(async (tx) => {
        const item = await db.queryOne<{ thread_id: string }>(
          "SELECT thread_id FROM work_items WHERE org_id = $1 AND id = $2",
          [delivery.org_id, delivery.work_item_id],
          tx,
        );
        if (!item) throw new Error("Cannot write a work delivery without its work item");
        await lockConversationThreads(db, tx, [{
          org_id: delivery.org_id,
          thread_id: item.thread_id,
        }]);
        return putWorkDelivery(db, delivery, tx, commandWrite);
      });
    }
    const current = await db.queryOne<WorkDeliveryRow>(
      "SELECT * FROM work_deliveries WHERE id = $1 FOR UPDATE", [delivery.id], client,
    );
    const run = delivery.run_id ? await db.queryOne<WorkRunRow>(
      `SELECT r.* FROM work_runs r
       JOIN work_items w ON w.id = r.work_item_id AND w.org_id = r.org_id
       WHERE r.org_id = $1 AND r.id = $2`,
      [delivery.org_id, delivery.run_id], client,
    ) : null;
    assertWorkDeliveryWrite(delivery, current ? toWorkDelivery(current) : null, run ? toWorkRun(run) : null, commandWrite);
    const row = await db.queryOne<WorkDeliveryRow>(
      `
        INSERT INTO work_deliveries (
          id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
          status, write_back, attempts, last_error, next_retry_at,
          payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
          created_at, updated_at, run_id, target_json, lease_owner, claim_token, cancel_requested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        ON CONFLICT (id) DO UPDATE SET
          version = work_deliveries.version + 1,
          recipe_id = EXCLUDED.recipe_id,
          kind = EXCLUDED.kind,
          unit_key = EXCLUDED.unit_key,
          event_id = EXCLUDED.event_id,
          status = EXCLUDED.status,
          write_back = EXCLUDED.write_back,
          attempts = EXCLUDED.attempts,
          last_error = EXCLUDED.last_error,
          next_retry_at = EXCLUDED.next_retry_at,
          payload_json = EXCLUDED.payload_json,
          lease_expires_at = EXCLUDED.lease_expires_at,
          idempotency_key = EXCLUDED.idempotency_key,
          channel_receipt_json = EXCLUDED.channel_receipt_json,
          lease_owner = EXCLUDED.lease_owner,
          claim_token = EXCLUDED.claim_token,
          cancel_requested_at = EXCLUDED.cancel_requested_at,
          updated_at = EXCLUDED.updated_at
        WHERE work_deliveries.org_id = EXCLUDED.org_id
          AND work_deliveries.work_item_id = EXCLUDED.work_item_id
          AND work_deliveries.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
          AND (work_deliveries.run_id IS NULL OR (
            work_deliveries.payload_json IS NOT DISTINCT FROM EXCLUDED.payload_json
            AND work_deliveries.target_json IS NOT DISTINCT FROM EXCLUDED.target_json
            AND work_deliveries.idempotency_key IS NOT DISTINCT FROM EXCLUDED.idempotency_key
          ))
        RETURNING *
      `,
      [
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
        jsonb(delivery.payload),
        delivery.lease_expires_at ?? null,
        delivery.idempotency_key ?? null,
        jsonb(delivery.channel_receipt),
        delivery.created_at,
        delivery.updated_at,
        delivery.run_id ?? null,
        jsonb(delivery.target),
        delivery.lease_owner ?? null,
        delivery.claim_token ?? null,
        delivery.cancel_requested_at ?? null,
      ], client,
    );
    if (!row) {
      throw new Error("work delivery upsert returned no row");
    }
    return toWorkDelivery(row);
  }

export async function listExecutorInstallations(db: PgSql, orgId: string): Promise<ExecutorInstallation[]> {
    const rows = await db.query<ExecutorRow>(
      `
        SELECT * FROM executor_installations
        WHERE org_id = $1 ORDER BY updated_at DESC, id
      `,
      [orgId],
    );
    return rows.map(toExecutorInstallation);
  }

export async function getExecutorInstallation(db: PgSql, orgId: string, id: string): Promise<ExecutorInstallation | null> {
    const row = await db.queryOne<ExecutorRow>(
      `SELECT * FROM executor_installations WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toExecutorInstallation(row) : null;
  }

export async function putExecutorInstallation(db: PgSql, installation: ExecutorInstallation): Promise<ExecutorInstallation> {
    await db.execute(
      `
        INSERT INTO executor_installations (
          id, org_id, kind, name, status, config_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          config_json = EXCLUDED.config_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        installation.id,
        installation.org_id,
        installation.kind,
        installation.name,
        installation.status,
        jsonb(installation.config),
        installation.created_at,
        installation.updated_at,
      ],
    );
    return installation;
  }

export async function deleteExecutorInstallation(db: PgSql, orgId: string, id: string): Promise<boolean> {
    const rowCount = await db.execute(
      `DELETE FROM executor_installations WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return rowCount > 0;
  }

interface ExecutorRow {
  id: string;
  org_id: string;
  kind: ExecutorInstallation["kind"];
  name: string;
  status: ExecutorInstallation["status"];
  config_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RecipeRow {
  id: string;
  org_id: string;
  name: string;
  match_json: unknown;
  executor_type: string;
  executor_config_json: unknown;
  can_write_back: unknown;
  write_back_thread_id: string | null;
  include_context: unknown;
  hide_on_success: unknown;
  enabled: unknown;
  trigger_kind: string | null;
  trigger_interval_ms: number | null;
  trigger_at_minute: number | null;
  trigger_weekdays: string | null;
  trigger_timezone: string | null;
  trigger_coalesce: unknown;
  max_concurrent: number | null;
  next_run_at: unknown;
  created_at: unknown;
  updated_at: unknown;
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
  version: number | string;
  visibility_intent_version: number | string;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
  version: number | string;
  run_id: string | null;
  lease_owner: string | null;
  claim_token: string | null;
  cancel_requested_at: Date | string | null;
  target_json: unknown;
  recipe_id: string;
  kind: string;
  unit_key: string;
  event_id: string | null;
  status: string;
  write_back: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: unknown;
  payload_json: unknown;
  lease_expires_at: unknown;
  idempotency_key: string | null;
  channel_receipt_json: unknown;
  created_at: unknown;
  updated_at: unknown;
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
  result_json: unknown;
  version: number | string;
  write_back_required: boolean | null;
  write_back_target_json: unknown;
  trigger_kind: WorkRun["trigger_kind"] | null;
  executor_config_json: unknown;
  include_context: boolean | null;
  completion_policy_version: WorkRun["completion_policy_version"] | null;
  hide_on_success: boolean | null;
  created_at: unknown;
  updated_at: unknown;
}

interface SearchAnswerRow {
  id: string;
  org_id: string;
  work_item_id: string;
  query: string;
  event_ids_json: unknown;
  scope_json: unknown;
  outcome: SearchAnswerRecord["outcome"] | null;
  created_at: unknown;
  updated_at: unknown;
}

function toExecutorInstallation(row: ExecutorRow): ExecutorInstallation {
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: asJson<ExecutorInstallation["config"]>(row.config_json),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toRecipe(row: RecipeRow): Recipe {
  const match = asJson<Recipe["match"]>(row.match_json);
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
            ...(kind === "push"
              ? { coalesce: row.trigger_coalesce !== false && row.trigger_coalesce !== 0 }
              : {}),
          }
        : undefined,
    }),
    executor_type: row.executor_type,
    executor_config: asJson<Recipe["executor_config"]>(row.executor_config_json),
    can_write_back: asBool(row.can_write_back),
    ...(row.write_back_thread_id !== null
      ? { write_back_thread_id: row.write_back_thread_id }
      : {}),
    include_context: asBool(row.include_context),
    hide_on_success: asBool(row.hide_on_success),
    enabled: asBool(row.enabled),
    ...(row.max_concurrent && row.max_concurrent > 0
      ? { max_concurrent: row.max_concurrent }
      : {}),
    ...(row.next_run_at ? { next_run_at: toIso(row.next_run_at) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
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
    version: asNumber(row.version),
    visibility_intent_version: asNumber(row.visibility_intent_version),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
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
      ? asJson<WorkRun["result"]>(row.result_json)
      : undefined,
    version: asNumber(row.version),
    ...(row.write_back_required !== null ? { write_back_required: row.write_back_required } : {}),
    ...(row.write_back_target_json ? { write_back_target: asJson<NonNullable<WorkRun["write_back_target"]>>(row.write_back_target_json) } : {}),
    ...(row.trigger_kind ? { trigger_kind: row.trigger_kind } : {}),
    ...(row.executor_config_json !== null
      ? { executor_config: asJson<NonNullable<WorkRun["executor_config"]>>(row.executor_config_json) }
      : {}),
    ...(row.include_context !== null ? { include_context: asBool(row.include_context) } : {}),
    ...(row.completion_policy_version !== null ? { completion_policy_version: row.completion_policy_version } : {}),
    ...(row.hide_on_success !== null ? { hide_on_success: asBool(row.hide_on_success) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toSearchAnswer(row: SearchAnswerRow): SearchAnswerRecord {
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    query: row.query,
    event_ids: asJson<string[]>(row.event_ids_json),
    ...(row.scope_json
      ? { scope: asJson<NonNullable<SearchAnswerRecord["scope"]>>(row.scope_json) }
      : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toWorkDelivery(row: WorkDeliveryRow): WorkDelivery {
  const kind = isRecipeTriggerKind(row.kind) ? row.kind : "manual";
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    version: asNumber(row.version),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.claim_token ? { claim_token: row.claim_token } : {}),
    ...(row.cancel_requested_at ? { cancel_requested_at: toIso(row.cancel_requested_at) } : {}),
    ...(row.run_id ? { run_id: row.run_id } : {}),
    ...(row.target_json ? { target: asJson<NonNullable<WorkDelivery["target"]>>(row.target_json) } : {}),
    recipe_id: row.recipe_id,
    kind,
    unit_key: row.unit_key,
    event_id: row.event_id ?? undefined,
    status: isWorkDeliveryStatus(row.status) ? row.status : "queued",
    write_back: isWorkWriteBackState(row.write_back) ? row.write_back : "pending",
    attempts: asNumber(row.attempts),
    last_error: row.last_error ?? undefined,
    next_retry_at: toIsoOrUndefined(row.next_retry_at),
    payload: parseDeliveryPayload(row.payload_json),
    lease_expires_at: toIsoOrUndefined(row.lease_expires_at),
    idempotency_key: row.idempotency_key ?? undefined,
    channel_receipt: parseChannelReceipt(row.channel_receipt_json),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function parseChannelReceipt(
  raw: unknown,
): WorkDelivery["channel_receipt"] | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  try {
    const parsed = asJson<WorkDelivery["channel_receipt"]>(raw);
    if (!parsed || typeof parsed.accepted !== "boolean") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDeliveryPayload(
  raw: unknown,
): WorkDelivery["payload"] | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  try {
    const parsed = asJson<WorkDelivery["payload"]>(raw);
    if (!parsed || typeof parsed.summary !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
