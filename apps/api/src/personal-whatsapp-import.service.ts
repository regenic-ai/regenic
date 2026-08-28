import { Inject, Injectable } from "@nestjs/common";
import {
  createPurrWhatsAppImport,
  createWhatsAppPersonalImport,
  WHATSAPP_PERSONAL_SOURCE,
} from "@regenic/whatsapp-personal";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

@Injectable()
export class PersonalWhatsAppImportService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async import(content: string | undefined, fileName?: string) {
    if (typeof content !== "string" || content.length === 0) {
      throw new PersonalConnectorError(
        "invalid_config",
        "WhatsApp export content is required",
        400,
      );
    }
    if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES) {
      throw new PersonalConnectorError(
        "invalid_config",
        "WhatsApp export files must be 20 MiB or smaller",
        413,
      );
    }

    const common = {
      data: content,
      org_id: this.runtime.orgId(),
      local_principal_id: this.runtime.orgId(),
      received_at: new Date().toISOString(),
    };
    const imported = fileName?.toLowerCase().endsWith(".csv")
      ? createPurrWhatsAppImport({ ...common, file_name: fileName })
      : createWhatsAppPersonalImport(common);
    if (imported.batches.length === 0 && imported.errors.length > 0) {
      throw new PersonalConnectorError(
        "invalid_config",
        imported.errors[0].message,
        400,
      );
    }
    const host = this.runtime.requireHost();
    const ingest = host.get("ingest");
    const authority = host.get("authority");
    const isPurr = fileName?.toLowerCase().endsWith(".csv") === true;
    const existingPurrIds = isPurr
      ? new Set(
          (
            await authority.listEvents(common.org_id, {
              source: WHATSAPP_PERSONAL_SOURCE,
            })
          ).map((event) => event.external_id),
        )
      : null;
    const batches = [];
    for (const batch of imported.batches) {
      const records = isPurr
        ? batch.records.map((record) => {
            if (
              record.operation !== "create" ||
              !existingPurrIds?.has(record.external_id)
            ) {
              existingPurrIds?.add(record.external_id);
              return record;
            }
            return {
              ...record,
              operation: "revise" as const,
              revision_id: "purr-wa-surface-v1",
            };
          })
        : batch.records;
      const result = await ingest.ingest({ ...batch, records });
      if (!result.valid) {
        throw new PersonalConnectorError(
          "invalid_config",
          `WhatsApp import was rejected: ${result.error_code ?? "invalid batch"}`,
          400,
        );
      }
      batches.push(result);
    }
    return {
      file_hash: imported.file_hash,
      accepted_count: batches.reduce(
        (total, batch) =>
          total + batch.records.filter((record) => record.status === "accepted").length,
        0,
      ),
      duplicate_count: batches.reduce(
        (total, batch) =>
          total + batch.records.filter((record) => record.status === "duplicate").length,
        0,
      ),
      invalid_line_count: imported.errors.length,
      errors: imported.errors,
    };
  }
}