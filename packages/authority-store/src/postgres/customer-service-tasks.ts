import {
  CustomerServiceTaskConflictError,
  validateCustomerServiceTask,
  type CustomerServiceTask,
  type CustomerServiceTaskStatus,
} from "@regenic/domain";
import { asNumber, jsonb, type PgSql } from "./sql";
import { parseContextJson } from "./context-artifacts";

interface TaskRow {
  revision: number | string;
  payload_json: unknown;
}

export async function putCustomerServiceTask(
  db: PgSql,
  input: CustomerServiceTask,
  expectedRevision?: number,
): Promise<CustomerServiceTask> {
  const task = validateCustomerServiceTask(input);
  return db.withTx(async (client) => {
    const current = await db.queryOne<TaskRow>(
      "SELECT revision, payload_json FROM customer_service_tasks WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [task.org_id, task.id],
      client,
    );
    if (!current) {
      if (expectedRevision !== undefined) {
        throw new CustomerServiceTaskConflictError();
      }
      await db.execute(`
        INSERT INTO customer_service_tasks
          (id, org_id, status, revision, payload_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        task.id,
        task.org_id,
        task.status,
        task.revision,
        jsonb(task),
        task.created_at,
        task.updated_at,
      ], client);
      return task;
    }
    if (expectedRevision === undefined || asNumber(current.revision) !== expectedRevision
      || task.revision !== expectedRevision + 1) {
      throw new CustomerServiceTaskConflictError();
    }
    const changed = await db.execute(`
      UPDATE customer_service_tasks
      SET status = $1, revision = $2, payload_json = $3, updated_at = $4
      WHERE org_id = $5 AND id = $6 AND revision = $7
    `, [
      task.status,
      task.revision,
      jsonb(task),
      task.updated_at,
      task.org_id,
      task.id,
      expectedRevision,
    ], client);
    if (changed !== 1) {
      throw new CustomerServiceTaskConflictError();
    }
    return task;
  });
}

export async function getCustomerServiceTask(
  db: PgSql,
  orgId: string,
  taskId: string,
): Promise<CustomerServiceTask | null> {
  const row = await db.queryOne<Pick<TaskRow, "payload_json">>(
    "SELECT payload_json FROM customer_service_tasks WHERE org_id = $1 AND id = $2",
    [orgId, taskId],
  );
  return row
    ? validateCustomerServiceTask(parseContextJson<CustomerServiceTask>(row.payload_json))
    : null;
}

export async function listCustomerServiceTasks(
  db: PgSql,
  input: {
    org_id: string;
    statuses?: CustomerServiceTaskStatus[];
    limit?: number;
  },
): Promise<CustomerServiceTask[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const statuses = input.statuses?.length ? [...new Set(input.statuses)] : undefined;
  const rows = await db.query<Pick<TaskRow, "payload_json">>(`
    SELECT payload_json
    FROM customer_service_tasks
    WHERE org_id = $1 ${statuses ? "AND status = ANY($2::text[])" : ""}
    ORDER BY updated_at DESC, id DESC
    LIMIT $${statuses ? 3 : 2}
  `, statuses ? [input.org_id, statuses, limit] : [input.org_id, limit]);
  return rows.map((row) =>
    validateCustomerServiceTask(parseContextJson<CustomerServiceTask>(row.payload_json)));
}
