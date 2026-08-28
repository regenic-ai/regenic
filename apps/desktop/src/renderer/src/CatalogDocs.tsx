import { useLocale } from "./LocaleContext";
import type { CatalogDocRef } from "./types";
import type { MessageKey } from "../../shared/i18n.ts";

const DOC_TITLE_KEYS: Record<string, MessageKey> = {
  connector: "docs.connector",
  executor: "docs.executor",
  rfc0009: "docs.rfc0009",
  orchestration: "docs.orchestration",
  desktop: "docs.desktop",
};

export function uniqueCatalogDocs(
  items: Array<{ docs?: CatalogDocRef[] }>,
): CatalogDocRef[] {
  const seen = new Set<string>();
  const docs: CatalogDocRef[] = [];
  for (const item of items) {
    for (const doc of item.docs ?? []) {
      if (!doc.href || seen.has(doc.id)) {
        continue;
      }
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  return docs;
}

export function CatalogDocs({ docs }: { docs: CatalogDocRef[] }) {
  const { locale, t } = useLocale();
  if (docs.length === 0) {
    return null;
  }
  return (
    <div className="install-docs">
      {docs.map((item) => {
        const href = locale === "zh" ? item.href_zh || item.href : item.href;
        return (
          <a
            key={item.id}
            className="doc-link"
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              openExternal(href);
            }}
          >
            {docTitle(item, t)}
          </a>
        );
      })}
    </div>
  );
}

function docTitle(
  doc: CatalogDocRef,
  t: (key: MessageKey) => string,
): string {
  const key = DOC_TITLE_KEYS[doc.id];
  return key ? t(key) : doc.title;
}

export function openExternal(href: string): void {
  if (window.regenic?.openExternal) {
    void window.regenic.openExternal(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
