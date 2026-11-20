import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchKernelSettings, saveLocale } from "./api";
import {
  activeLocale,
  DEFAULT_LOCALE,
  parseLocale,
  setActiveLocale,
  translate,
  type Locale,
  type MessageKey,
} from "../../shared/i18n.ts";
import { bootLocale, localeTag } from "../../shared/locale.ts";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

function translateDefault(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return translate(DEFAULT_LOCALE, key, vars);
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: async () => undefined,
  t: translateDefault,
});

const LOCALE_CACHE_KEY = "regenic.locale";

function readCachedLocale(): Locale | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCALE_CACHE_KEY) ?? "") as {
      locale?: unknown;
      boot?: unknown;
    };
    if (parsed.locale !== "en" && parsed.locale !== "zh") return undefined;
    const boot = typeof window !== "undefined" ? window.regenic?.boot : undefined;
    // A new process re-reads the saved choice or the system language. The cache
    // only covers a reload of the windows already open.
    if (boot && parsed.boot !== boot) return undefined;
    return parsed.locale;
  } catch {
    return undefined;
  }
}

function writeCachedLocale(locale: Locale): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      LOCALE_CACHE_KEY,
      JSON.stringify({
        locale,
        boot: typeof window !== "undefined" ? window.regenic?.boot : undefined,
      }),
    );
  } catch {
    // The in-memory locale still applies for this session.
  }
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return (
    readCachedLocale() ??
    bootLocale(
      window.regenic?.locale,
      window.navigator?.languages ?? window.navigator?.language,
    )
  );
}

function applyDocumentLocale(locale: Locale): void {
  setActiveLocale(locale);
  writeCachedLocale(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = localeTag(locale);
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = initialLocale();
    applyDocumentLocale(initial);
    return initial;
  });
  const held = useRef(false);
  // Module translators are read by child render paths. Align them before that render.
  if (activeLocale() !== locale) applyDocumentLocale(locale);

  const apply = useCallback((next: Locale) => {
    const parsed = parseLocale(next);
    applyDocumentLocale(parsed);
    setLocaleState(parsed);
  }, []);

  useEffect(() => {
    if (!window.regenic?.getKernelSettings) return;
    let cancel = false;
    void fetchKernelSettings()
      .then((settings) => {
        if (cancel || held.current) return;
        apply(parseLocale(settings.locale));
      })
      .catch(() => {
        // Keep the language already on screen. A failed read must not flip the app to English.
      });
    const unsubscribe = window.regenic.onLocaleChanged?.((next) => {
      held.current = true;
      apply(parseLocale(next));
    });
    return () => {
      cancel = true;
      unsubscribe?.();
    };
  }, [apply]);

  const setLocale = useCallback(
    async (next: Locale) => {
      const parsed = parseLocale(next);
      held.current = true;
      apply(parsed);
      await saveLocale(parsed);
    },
    [apply],
  );

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
