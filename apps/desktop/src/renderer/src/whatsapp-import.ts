import { t } from "../../shared/i18n.ts";
import type { WhatsAppImportView } from "./types";

export interface WhatsAppImportFile {
  name: string;
  text(): Promise<string>;
}

export interface WhatsAppImportFailure {
  file_name: string;
  message: string;
}

export interface WhatsAppImportBatchResult {
  total_files: number;
  completed_files: number;
  accepted_count: number;
  duplicate_count: number;
  invalid_line_count: number;
  failures: WhatsAppImportFailure[];
}

export async function importWhatsAppFiles(
  files: readonly WhatsAppImportFile[],
  importOne: (content: string, fileName: string) => Promise<WhatsAppImportView>,
): Promise<WhatsAppImportBatchResult> {
  const result: WhatsAppImportBatchResult = {
    total_files: files.length,
    completed_files: 0,
    accepted_count: 0,
    duplicate_count: 0,
    invalid_line_count: 0,
    failures: [],
  };
  for (const file of files) {
    try {
      const imported = await importOne(await file.text(), file.name);
      result.completed_files += 1;
      result.accepted_count += imported.accepted_count;
      result.duplicate_count += imported.duplicate_count;
      result.invalid_line_count += imported.invalid_line_count;
    } catch (error) {
      result.failures.push({
        file_name: file.name,
        message:
          error instanceof Error ? error.message : t("connector.importFailed"),
      });
    }
  }
  return result;
}

export function whatsAppImportSummary(result: WhatsAppImportBatchResult): string {
  return t("connector.importSummary", {
    completed: result.completed_files,
    total: result.total_files,
    accepted: result.accepted_count,
    duplicates: result.duplicate_count,
    invalid: result.invalid_line_count,
  });
}