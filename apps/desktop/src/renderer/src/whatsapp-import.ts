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
        message: error instanceof Error ? error.message : "Import failed",
      });
    }
  }
  return result;
}

export function whatsAppImportSummary(result: WhatsAppImportBatchResult): string {
  return `Processed ${result.completed_files} of ${result.total_files} files · ${result.accepted_count} new · ${result.duplicate_count} duplicates · ${result.invalid_line_count} invalid lines.`;
}