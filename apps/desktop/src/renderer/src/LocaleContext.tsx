import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchKernelSettings, saveLocale } from "./api";
import {
  DEFAULT_LOCALE,
  parseLocale,
  setActiveLocale,
  t as translateActive,
  type Locale,
  type MessageKey,
} from "../../shared/i18n.ts";
import { localeTag } from "../../shared/locale.ts";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: async () => undefined,
  t: translateActive,
});

function applyDocumentLocale(locale: Locale): void {
  setActiveLocale(locale);
  document.documentElement.lang = localeTag(locale);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  const apply = useCallback((next: Locale) => {
    const parsed = parseLocale(next);
    applyDocumentLocale(parsed);
    setLocaleState(parsed);
  }, []);

  useEffect(() => {
    void fetchKernelSettings()
      .then((settings) => {
        apply(parseLocale(settings.locale));
      })
      .catch(() => {
        apply(DEFAULT_LOCALE);
      });
    return window.regenic?.onLocaleChanged?.((next) => {
      apply(parseLocale(next));
    });
  }, [apply]);

  const setLocale = useCallback(
    async (next: Locale) => {
      const parsed = parseLocale(next);
      apply(parsed);
      await saveLocale(parsed);
    },
    [apply],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: translateActive,
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
