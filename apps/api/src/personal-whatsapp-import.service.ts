import { Inject, Injectable } from "@nestjs/common";
import { ChannelDriverRegistry } from "@regenic/domain";
import { WHATSAPP_WEB_LIVE_CONNECTOR_TYPE } from "@regenic/whatsapp-personal";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";

const DEFAULT_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

@Injectable()
export class PersonalWhatsAppImportService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  import(content: string | undefined, fileName?: string) {
    return this.importFile({
      connector_type: WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
      content,
      file_name: fileName,
    });
  }

  async importFile(input: {
    connector_type?: string;
    content?: string;
    file_name?: string;
  }) {
    const connectorType = input.connector_type?.trim();
    if (!connectorType) {
      throw new PersonalConnectorError(
        "invalid_config",
        "connector_type is required",
        400,
      );
    }
    const driver = this.drivers.get(connectorType);
    if (!driver?.parseImport) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot import files: ${connectorType}`,
        400,
      );
    }
    if (typeof input.content !== "string" || input.content.length === 0) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Import content is required",
        400,
      );
    }
    const catalog = driver.installCatalog?.({ env: process.env });
    const maxBytes = catalog?.import_files?.max_bytes ?? DEFAULT_IMPORT_MAX_BYTES;
    if (Buffer.byteLength(input.content, "utf8") > maxBytes) {
      throw new PersonalConnectorError(
        "invalid_config",
        `Import files must be ${Math.floor(maxBytes / (1024 * 1024))} MiB or smaller`,
        413,
      );
    }

    const orgId = this.runtime.orgId();
    const host = this.runtime.requireHost();
    const ingest = host.get("ingest");
    const authority = host.get("authority");
    const existing = await authority.listEvents(orgId, { source: driver.source });
    const imported = await driver.parseImport({
      content: input.content,
      file_name: input.file_name,
      org_id: orgId,
      local_principal_id: orgId,
      received_at: new Date().toISOString(),
      existing_external_ids: existing.map((event) => event.external_id),
    });
    if (imported.batches.length === 0 && imported.errors.length > 0) {
      throw new PersonalConnectorError(
        "invalid_config",
        imported.errors[0].message,
        400,
      );
    }
    const batches = [];
    for (const batch of imported.batches) {
      const result = await ingest.ingest(batch);
      if (!result.valid) {
        throw new PersonalConnectorError(
          "invalid_config",
          `Import was rejected: ${result.error_code ?? "invalid batch"}`,
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
