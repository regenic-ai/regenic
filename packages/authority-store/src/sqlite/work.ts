import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Recipe,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
  WorkDelivery,
  ExecutorInstallation,
  SearchAnswerRecord,
} from "@regenic/domain";
import {
  recipeTriggerOf,
  isRecipeTriggerKind,
  pullScheduleColumns,
  pullScheduleFromColumns,
  isWorkDeliveryStatus,
  isWorkWriteBackState,
  type WorkItemStatus,
  prepareWorkObservation,
  assertWorkRunWrite,
  canClaimWorkRunStartItem,
  prepareWorkRunStartCheckpoint,
  prepareWorkRunStartFailure,
  prepareWorkDismissal,
  sameWorkDismissalCommand,
  prepareWorkItemCreation,
  type WorkItemCreation,
  type WorkItemCreationResult,
  prepareWorkItemCreationAbort,
  type WorkItemCreationAbort,
  type WorkItemCreationAbortResult,
  type WorkDismissal,
  type WorkDismissalResult,
  type WorkRunStartFailure,
  type WorkRunStartFailureResult,
  type WorkRunStartCheckpoint,
  type WorkRunStartCheckpointResult,
  assertWorkDeliveryWrite,
  planWorkDeliveryCommand,
  canonicalContextJson,
  type CommitWorkObservation,
  type CommitWorkObservationResult,
} from "@regenic/domain";

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
    return writeRecipe(db, recipe);
  }

function writeRecipe(db: Database.Database, recipe: Recipe): Recipe {
    const trigger = recipeTriggerOf(recipe);
    const pull = pullScheduleColumns(trigger);
    db
      .prepare(
        `
          INSERT INTO recipes (
            id, org_id, name, match_json, executor_type, executor_config_json,
            can_write_back, include_context, enabled, trigger_kind,
            trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone,
            trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at,
            write_back_thread_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
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
            updated_at = excluded.updated_at
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
      );
    return recipe;
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

export async function putWorkItem(db: Database.Database, item: WorkItem): Promise<WorkItem> {
    writeWorkItem(db, item, true);
    return (await getWorkItem(db, item.org_id, item.id)) ?? item;
  }

export async function createWorkItem(db: Database.Database, input: WorkItemCreation): Promise<WorkItemCreationResult> {
  return db.transaction((): WorkItemCreationResult => {
    const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(input.recipe.id) as RecipeRow | undefined;
    const result = prepareWorkItemCreation(input, {
      item_exists: Boolean(db.prepare("SELECT id FROM work_items WHERE id = ?").get(input.item.id)),
      recipe: recipe ? toRecipe(recipe) : null,
      search_answer_exists: input.search_answer
        ? Boolean(db.prepare("SELECT id FROM search_answers WHERE id = ?").get(input.search_answer.id)) : false,
    });
    if (result.outcome !== "applied") return result;
    writeRecipe(db, result.recipe);
    writeWorkItem(db, result.item);
    const savedItem = db.prepare("SELECT * FROM work_items WHERE id = ?").get(result.item.id) as WorkItemRow | undefined;
    const savedRecipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(result.recipe.id) as RecipeRow | undefined;
    if (!savedRecipe || !savedItem) throw new Error("Created work disappeared inside its transaction");
    const answer = result.search_answer;
    const savedAnswer = answer ? db.prepare(`INSERT INTO search_answers (
      id, org_id, work_item_id, query, event_ids_json, outcome, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) RETURNING *`).get(
      answer.id, answer.org_id, answer.work_item_id, answer.query, JSON.stringify(answer.event_ids),
      answer.created_at, answer.updated_at,
    ) as SearchAnswerRow | undefined : undefined;
    if (answer && !savedAnswer) throw new Error("Created search answer disappeared inside its transaction");
    return {
      outcome: "applied", item: toWorkItem(savedItem), recipe: toRecipe(savedRecipe),
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
  }).immediate();
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
    db
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
    return item;
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

export async function putWorkRun(db: Database.Database, run: WorkRun): Promise<WorkRun> {
    return db.transaction(() => writeWorkRun(db, run, true)).immediate();
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
    const result = prepareWorkRunStartCheckpoint(input, {
      item: item ? toWorkItem(item) : null, run: run ? toWorkRun(run) : null,
    });
    if (result.outcome !== "applied") return result;
    writeWorkRun(db, result.run);
    if (result.item.status !== input.expected_item.status) writeWorkItem(db, result.item);
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
            write_back_required, write_back_target_json, trigger_kind
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            AND work_runs.write_back_required IS excluded.write_back_required
            AND work_runs.write_back_target_json IS excluded.write_back_target_json
            AND work_runs.trigger_kind IS excluded.trigger_kind
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
      ? db.prepare(`UPDATE search_answers SET outcome = 'timed_out', updated_at = ?
        WHERE org_id = ? AND id = ? RETURNING *`)
        .get(input.now, orgId, result.search_answer.id) as SearchAnswerRow | undefined : undefined;
    if (result.search_answer && !savedAnswer) throw new Error("Timed out search answer disappeared inside its transaction");
    return {
      outcome: "applied", item: savedWorkItem, run: result.run, deliveries: savedDeliveries,
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
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

export async function claimWorkRunStart(db: Database.Database, input: WorkRunStartClaim): Promise<boolean> {
  const { run, max_concurrent } = input;
  return db.transaction(() => {
    const item = db.prepare(`
      SELECT w.* FROM work_items w JOIN recipes r ON r.org_id = w.org_id AND r.id = ?
      WHERE w.org_id = ? AND w.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM work_runs WHERE org_id = w.org_id AND work_item_id = w.id
            AND status IN ('running', 'waiting_human')
        )
    `).get(run.recipe_id, run.org_id, run.work_item_id) as WorkItemRow | undefined;
    if (!item || !canClaimWorkRunStartItem(input, toWorkItem(item))) return false;
    const workItem = toWorkItem(item);
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
    writeWorkRun(db, run);
    db.prepare("UPDATE work_items SET status = 'running', recipe_id = ?, current_run_id = ?, visibility_intent_version = ?, version = version + 1, updated_at = ? WHERE org_id = ? AND id = ?")
      .run(run.recipe_id, run.id, input.visibility_intent_version ?? workItem.visibility_intent_version ?? 0,
        run.updated_at, run.org_id, run.work_item_id);
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
  db.prepare(`
    INSERT INTO search_answers (
      id, org_id, work_item_id, query, event_ids_json, outcome, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      work_item_id = excluded.work_item_id,
      query = excluded.query,
      event_ids_json = excluded.event_ids_json,
      outcome = excluded.outcome,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.org_id,
    record.work_item_id,
    record.query,
    JSON.stringify(record.event_ids),
    record.outcome ?? null,
    record.created_at,
    record.updated_at,
  );
  return record;
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

export async function putWorkDelivery(db: Database.Database, delivery: WorkDelivery): Promise<WorkDelivery> {
    return db.transaction(() => writeWorkDelivery(db, delivery)).immediate();
  }

export async function transitionWorkDelivery(
  db: Database.Database, input: WorkDeliveryCommand,
): Promise<WorkDeliveryCommandResult> {
  return db.transaction((): WorkDeliveryCommandResult => {
    const row = db.prepare("SELECT * FROM work_deliveries WHERE org_id = ? AND id = ?")
      .get(input.org_id, input.delivery_id) as WorkDeliveryRow | undefined;
    const item = row ? db.prepare("SELECT status FROM work_items WHERE org_id = ? AND id = ?")
      .get(input.org_id, row.work_item_id) as { status: string } | undefined : undefined;
    const result = planWorkDeliveryCommand(row ? toWorkDelivery(row) : null, item?.status, input);
    if (result.outcome === "applied") writeWorkDelivery(db, result.delivery, true);
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
            id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
            status, write_back, attempts, last_error, next_retry_at,
            payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
            created_at, updated_at, run_id, target_json, lease_owner, claim_token, cancel_requested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
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
  version: number;
  visibility_intent_version: number;
  created_at: string;
  updated_at: string;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
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
  created_at: string;
  updated_at: string;
}

interface SearchAnswerRow {
  id: string;
  org_id: string;
  work_item_id: string;
  query: string;
  event_ids_json: string;
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
