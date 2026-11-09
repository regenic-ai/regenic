import type { PoolClient } from "pg";
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
  type WorkDismissal,
  type WorkDismissalResult,
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
import {
  toIsoOrUndefined,
} from "./sync";

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
    const trigger = recipeTriggerOf(recipe);
    const pull = pullScheduleColumns(trigger);
    await db.execute(
      `
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          can_write_back, include_context, enabled, trigger_kind,
          trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone,
          trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at,
          write_back_thread_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (id) DO UPDATE SET
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
          updated_at = EXCLUDED.updated_at
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
      ],
    );
    return recipe;
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

export async function putWorkItem(
  db: PgSql,
  item: WorkItem,
  client?: PoolClient,
  advanceVersion = true,
): Promise<WorkItem> {
    await db.execute(
      `
        INSERT INTO work_items (
          id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
          status, recipe_id, created_at, updated_at, current_run_id, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      ], client,
    );
    if (!advanceVersion) return item;
    return await getWorkItem(db, item.org_id, item.id) ?? item;
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

export async function putWorkRun(
  db: PgSql,
  run: WorkRun,
  client?: PoolClient,
  advanceVersion = true,
): Promise<WorkRun> {
    if (!client) return db.withTx((tx) => putWorkRun(db, run, tx, advanceVersion));
    const current = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE id = $1 FOR UPDATE", [run.id], client,
    );
    assertWorkRunWrite(run, current ? toWorkRun(current) : undefined);
    const row = await db.queryOne<WorkRunRow>(
      `
        INSERT INTO work_runs (
          id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
          agent_thread_id, status, start_state, result_json, created_at, updated_at, version,
          write_back_required, write_back_target_json, trigger_kind
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
          AND work_runs.write_back_required IS NOT DISTINCT FROM EXCLUDED.write_back_required
          AND work_runs.write_back_target_json IS NOT DISTINCT FROM EXCLUDED.write_back_target_json
          AND work_runs.trigger_kind IS NOT DISTINCT FROM EXCLUDED.trigger_kind
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
    const item = await db.queryOne<WorkItemRow>(
      "SELECT * FROM work_items WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_item.id], client,
    );
    const run = await db.queryOne<WorkRunRow>(
      "SELECT * FROM work_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, input.expected_run.id], client,
    );
    const result = prepareWorkRunStartCheckpoint(input, {
      item: item ? toWorkItem(item) : null, run: run ? toWorkRun(run) : null,
    });
    if (result.outcome !== "applied") return result;
    await putWorkRun(db, result.run, client, false);
    if (result.item.status !== input.expected_item.status) {
      await putWorkItem(db, result.item, client, false);
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
    return { outcome: "applied", transition: prepared.transition };
  });
}

export async function dismissWorkItem(db: PgSql, input: WorkDismissal): Promise<WorkDismissalResult> {
  return db.withTx(async (client) => {
    const { org_id: orgId, id } = input.expected_item;
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
    const savedAnswer = result.search_answer ? await db.queryOne<SearchAnswerRow>(
      `UPDATE search_answers SET outcome = 'timed_out', updated_at = $1
        WHERE org_id = $2 AND id = $3 RETURNING *`, [input.now, orgId, result.search_answer.id], client,
    ) : null;
    if (result.search_answer && !savedAnswer) throw new Error("Timed out search answer disappeared inside its transaction");
    return {
      outcome: "applied", item: toWorkItem(savedItem), run: result.run, deliveries: savedDeliveries,
      ...(savedAnswer ? { search_answer: toSearchAnswer(savedAnswer) } : {}),
    };
  });
}

export async function recordWorkRunStartFailure(
  db: PgSql, input: WorkRunStartFailure,
): Promise<WorkRunStartFailureResult> {
  return db.withTx(async (client) => {
    const { run } = input;
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

export async function claimWorkRunStart(db: PgSql, input: WorkRunStartClaim): Promise<boolean> {
  const { run, max_concurrent } = input;
  return db.withTx(async (client) => {
    // Recipe lock also serializes capacity checks for different work items.
    const recipe = await db.queryOne(`
      SELECT id FROM recipes WHERE org_id = $1 AND id = $2 FOR UPDATE
    `, [run.org_id, run.recipe_id], client);
    if (!recipe) return false;
    const item = await db.queryOne<WorkItemRow>(`
      SELECT * FROM work_items WHERE org_id = $1 AND id = $2
        FOR UPDATE
    `, [run.org_id, run.work_item_id], client);
    if (!item || !canClaimWorkRunStartItem(input, toWorkItem(item))) return false;
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
    await putWorkRun(db, run, client, false);
    await db.execute("UPDATE work_items SET status = 'running', recipe_id = $1, current_run_id = $2, version = version + 1, updated_at = $3 WHERE org_id = $4 AND id = $5",
      [run.recipe_id, run.id, run.updated_at, run.org_id, run.work_item_id], client);
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
  await db.execute(
    `
      INSERT INTO search_answers (
        id, org_id, work_item_id, query, event_ids_json, outcome, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        work_item_id = EXCLUDED.work_item_id,
        query = EXCLUDED.query,
        event_ids_json = EXCLUDED.event_ids_json,
        outcome = EXCLUDED.outcome,
        updated_at = EXCLUDED.updated_at
    `,
    [
      record.id,
      record.org_id,
      record.work_item_id,
      record.query,
      jsonb(record.event_ids),
      record.outcome ?? null,
      record.created_at,
      record.updated_at,
    ],
  );
  return record;
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
    const item = await db.queryOne<{ status: string }>(
      `SELECT w.status FROM work_items w JOIN work_deliveries d
       ON d.org_id = w.org_id AND d.work_item_id = w.id
       WHERE d.org_id = $1 AND d.id = $2 FOR UPDATE OF w`,
      [input.org_id, input.delivery_id], client,
    );
    const row = await db.queryOne<WorkDeliveryRow>(
      "SELECT * FROM work_deliveries WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [input.org_id, input.delivery_id], client,
    );
    const result = planWorkDeliveryCommand(row ? toWorkDelivery(row) : null, item?.status, input);
    if (result.outcome === "applied") await putWorkDelivery(db, result.delivery, client, true);
    return result;
  });
}

export async function putWorkDelivery(
  db: PgSql, delivery: WorkDelivery, client?: PoolClient, commandWrite = false,
): Promise<WorkDelivery> {
    if (!client) return db.withTx((tx) => putWorkDelivery(db, delivery, tx));
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
          id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
          status, write_back, attempts, last_error, next_retry_at,
          payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
          created_at, updated_at, run_id, target_json, lease_owner, claim_token, cancel_requested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT (id) DO UPDATE SET
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
  version: number | string;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
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
  created_at: unknown;
  updated_at: unknown;
}

interface SearchAnswerRow {
  id: string;
  org_id: string;
  work_item_id: string;
  query: string;
  event_ids_json: unknown;
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
    version: asNumber(row.version),
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
