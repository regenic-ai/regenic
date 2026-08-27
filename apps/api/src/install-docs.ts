export interface CatalogDocRef {
  id: string;
  title: string;
  href: string;
  href_zh: string;
}

export const INSTALL_DOC_IDS = [
  "connector",
  "executor",
  "rfc0009",
  "orchestration",
  "desktop",
] as const;

export type InstallDocId = (typeof INSTALL_DOC_IDS)[number];

const DEFAULT_DOCS_WEB =
  "https://github.com/regenic-ai/regenic/blob/main/docs";

interface InstallDocDefinition {
  id: InstallDocId;
  title: string;
  files: { en: string; zh: string };
}

const INSTALL_DOCS: Record<InstallDocId, InstallDocDefinition> = {
  connector: {
    id: "connector",
    title: "Connector spec",
    files: { en: "en/CONNECTOR.md", zh: "zh/CONNECTOR.md" },
  },
  executor: {
    id: "executor",
    title: "Executor spec",
    files: { en: "en/EXECUTOR.md", zh: "zh/EXECUTOR.md" },
  },
  rfc0009: {
    id: "rfc0009",
    title: "RFC 0009",
    files: {
      en: "en/rfcs/0009-work-orchestration.md",
      zh: "zh/rfcs/0009-work-orchestration.md",
    },
  },
  orchestration: {
    id: "orchestration",
    title: "Message orchestration",
    files: {
      en: "en/MESSAGE_ORCHESTRATION.md",
      zh: "zh/MESSAGE_ORCHESTRATION.md",
    },
  },
  desktop: {
    id: "desktop",
    title: "Desktop",
    files: { en: "zh/DESKTOP.md", zh: "zh/DESKTOP.md" },
  },
};

export const CONNECTOR_INSTALL_DOCS: CatalogDocRef[] = [
  catalogDoc("connector"),
  catalogDoc("rfc0009"),
];

export const EXECUTOR_INSTALL_DOCS: CatalogDocRef[] = [
  catalogDoc("executor"),
  catalogDoc("rfc0009"),
];

export function docsWebBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.REGENIC_DOCS_WEB ?? DEFAULT_DOCS_WEB).replace(/\/$/, "");
}

export function catalogDoc(
  id: InstallDocId,
  env: NodeJS.ProcessEnv = process.env,
): CatalogDocRef {
  const definition = INSTALL_DOCS[id];
  const base = docsWebBase(env);
  return {
    id,
    title: definition.title,
    href: `${base}/${definition.files.en}`,
    href_zh: `${base}/${definition.files.zh}`,
  };
}
