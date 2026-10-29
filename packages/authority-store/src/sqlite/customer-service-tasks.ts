import Database from "better-sqlite3";
import {
  canonicalContextJson,
  CustomerServiceTaskConflictError,
  validateCustomerServiceTask,
  type CustomerServiceTask,
  type CustomerServiceTaskStatus,
} from "@regenic/domain";

interface TaskRow {
  revision: number;
  payload_json: string;
}

export async function putCustomerServiceTask(
  db: Database.Database,
  input: CustomerServiceTask,
  expectedRevision?: number,
): Promise<CustomerServiceTask> {
  const task = validateCustomerServiceTask(input);
  return db.transaction(() => {
    const current = db.prepare(
      "SELECT revision, payload_json FROM customer_service_tasks WHERE org_id = ? AND id = ?",
    ).get(task.org_id, task.id) as TaskRow | undefined;
    if (!current) {
      if (expectedRevision !== undefined) {
        throw new CustomerServiceTaskConflictError();
      }
      db.prepare(`
        INSERT INTO customer_service_tasks
          (id, org_id, status, revision, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.org_id,
        task.status,
        task.revision,
        canonicalContextJson(task),
        task.created_at,
        task.updated_at,
      );
      return task;
    }
    if (expectedRevision === undefined || current.revision !== expectedRevision
      || task.revision !== expectedRevision + 1) {
      throw new CustomerServiceTaskConflictError();
    }
    const changed = db.prepare(`
      UPDATE customer_service_tasks
      SET status = ?, revision = ?, payload_json = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND revision = ?
    `).run(
      task.status,
      task.revision,
      canonicalContextJson(task),
      task.updated_at,
      task.org_id,
      task.id,
      expectedRevision,
    ).changes;
    if (changed !== 1) {
      throw new CustomerServiceTaskConflictError();
    }
    return task;
  })();
}

export async function getCustomerServiceTask(
  db: Database.Database,
  orgId: string,
  taskId: string,
): Promise<CustomerServiceTask | null> {
  const row = db.prepare(
    "SELECT payload_json FROM customer_service_tasks WHERE org_id = ? AND id = ?",
  ).get(orgId, taskId) as Pick<TaskRow, "payload_json"> | undefined;
  return row
    ? validateCustomerServiceTask(JSON.parse(row.payload_json) as CustomerServiceTask)
    : null;
}

export async function listCustomerServiceTasks(
  db: Database.Database,
  input: {
    org_id: string;
    statuses?: CustomerServiceTaskStatus[];
    limit?: number;
  },
): Promise<CustomerServiceTask[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const statuses = input.statuses?.length ? [...new Set(input.statuses)] : undefined;
  const placeholders = statuses?.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT payload_json
    FROM customer_service_tasks
    WHERE org_id = ? ${placeholders ? `AND status IN (${placeholders})` : ""}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(input.org_id, ...(statuses ?? []), limit) as Array<Pick<TaskRow, "payload_json">>;
  return rows.map((row) =>
    validateCustomerServiceTask(JSON.parse(row.payload_json) as CustomerServiceTask));
}
