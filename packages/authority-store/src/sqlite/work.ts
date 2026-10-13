import Database from "better-sqlite3";
import type {
  Recipe,
  WorkItem,
  WorkRun,
  WorkDelivery,
  ExecutorInstallation,
} from "@regenic/domain";
import {
  recipeTriggerOf,
  isRecipeTriggerKind,
  isPullIntervalMs,
  isWorkDeliveryStatus,
  isWorkWriteBackState,
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
    
    const trigger = recipeTriggerOf(recipe);
    db
      .prepare(
        `
          INSERT INTO recipes (
            id, org_id, name, match_json, executor_type, executor_config_json,
            can_write_back, include_context, enabled, trigger_kind,
            trigger_interval_ms, trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            match_json = excluded.match_json,
            executor_type = excluded.executor_type,
            executor_config_json = excluded.executor_config_json,
            can_write_back = excluded.can_write_back,
            include_context = excluded.include_context,
            enabled = excluded.enabled,
            trigger_kind = excluded.trigger_kind,
            trigger_interval_ms = excluded.trigger_interval_ms,
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
        trigger.kind === "pull" ? (trigger.interval_ms ?? null) : null,
        trigger.kind === "push" && trigger.coalesce !== false ? 1 : 0,
        recipe.max_concurrent ?? null,
        recipe.next_run_at ?? null,
        recipe.created_at,
        recipe.updated_at,
      );
    return recipe;
  }

export async function deleteRecipe(db: Database.Database, orgId: string, id: string): Promise<boolean> {
    
    const result = db
      .prepare(`DELETE FROM recipes WHERE org_id = ? AND id = ?`)
      .run(orgId, id);
    return result.changes > 0;
  }

export async function listWorkItems(db: Database.Database, orgId: string): Promise<WorkItem[]> {
    const rows = db
      .prepare(
        `SELECT * FROM work_items WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as WorkItemRow[];
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

export async function putWorkItem(db: Database.Database, item: WorkItem): Promise<WorkItem> {
    
    db
      .prepare(
        `
          INSERT INTO work_items (
            id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
            status, recipe_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id,
            unit_key = excluded.unit_key,
            head_event_id = excluded.head_event_id,
            record_class = excluded.record_class,
            thread_facet = excluded.thread_facet,
            status = excluded.status,
            recipe_id = excluded.recipe_id,
            updated_at = excluded.updated_at
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
        `SELECT * FROM work_runs
         WHERE org_id = ? AND work_item_id = ?
           AND status IN ('running', 'waiting_human')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(orgId, workItemId) as WorkRunRow | undefined;
    return row ? toWorkRun(row) : null;
  }

export async function putWorkRun(db: Database.Database, run: WorkRun): Promise<WorkRun> {
    
    db
      .prepare(
        `
          INSERT INTO work_runs (
            id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
            agent_thread_id, status, result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            recipe_id = excluded.recipe_id,
            executor_type = excluded.executor_type,
            external_run_id = excluded.external_run_id,
            agent_thread_id = excluded.agent_thread_id,
            status = excluded.status,
            result_json = excluded.result_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        run.id,
        run.org_id,
        run.work_item_id,
        run.recipe_id,
        run.executor_type,
        run.external_run_id ?? null,
        run.agent_thread_id ?? null,
        run.status,
        run.result ? JSON.stringify(run.result) : null,
        run.created_at,
        run.updated_at,
      );
    return run;
  }

export async function listWorkDeliveries(db: Database.Database, orgId: string): Promise<WorkDelivery[]> {
    const rows = db
      .prepare(
        `SELECT * FROM work_deliveries WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as WorkDeliveryRow[];
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
        `SELECT * FROM work_deliveries WHERE org_id = ? AND work_item_id = ?`,
      )
      .get(orgId, workItemId) as WorkDeliveryRow | undefined;
    return row ? toWorkDelivery(row) : null;
  }

export async function putWorkDelivery(db: Database.Database, delivery: WorkDelivery): Promise<WorkDelivery> {
    
    db
      .prepare(
        `
          INSERT INTO work_deliveries (
            id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
            status, write_back, attempts, last_error, next_retry_at,
            payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            updated_at = excluded.updated_at
        `,
      )
      .run(
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
        delivery.payload ? JSON.stringify(delivery.payload) : null,
        delivery.lease_expires_at ?? null,
        delivery.idempotency_key ?? null,
        delivery.channel_receipt ? JSON.stringify(delivery.channel_receipt) : null,
        delivery.created_at,
        delivery.updated_at,
      );
    return delivery;
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
  include_context: number;
  enabled: number;
  trigger_kind: string | null;
  trigger_interval_ms: number | null;
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
  created_at: string;
  updated_at: string;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
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
  result_json: string | null;
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
            ...(kind === "pull" && isPullIntervalMs(row.trigger_interval_ms)
              ? { interval_ms: row.trigger_interval_ms }
              : {}),
            ...(kind === "push" ? { coalesce: row.trigger_coalesce !== 0 } : {}),
          }
        : undefined,
    }),
    executor_type: row.executor_type,
    executor_config: JSON.parse(row.executor_config_json) as Recipe["executor_config"],
    can_write_back: row.can_write_back === 1,
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
    result: row.result_json
      ? (JSON.parse(row.result_json) as WorkRun["result"])
      : undefined,
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
