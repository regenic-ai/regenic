import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";

export interface MenuSelectOption {
  value: string;
  label: string;
}

export function MenuSelect({
  value,
  options,
  placeholder,
  valueLabel,
  disabled,
  searchable,
  className,
  ariaLabel,
  onChange,
  onLoad,
}: {
  value: string;
  options: MenuSelectOption[];
  placeholder?: string;
  valueLabel?: string;
  disabled?: boolean;
  searchable?: boolean;
  className?: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
  onLoad?: (signal: AbortSignal) => Promise<void>;
}) {
  const { t } = useLocale();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const [popupMaxHeight, setPopupMaxHeight] = useState(280);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const selected = options.find((item) => item.value === value);
  const searchQuery = onLoad ? debouncedQuery : query;
  const filtered = useMemo(() => {
    if (onLoad && (loading || loadError || query !== debouncedQuery)) return [];
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) {
      return options;
    }
    return options.filter((item) =>
      item.label.toLowerCase().includes(needle) ||
      Boolean(onLoad && item.value.toLowerCase().includes(needle)),
    );
  }, [options, searchQuery, onLoad, loading, loadError, query, debouncedQuery]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!onLoad || !open) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [onLoad, open, query]);

  useEffect(() => {
    if (!open || !onLoad) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    const timer = window.setTimeout(() => {
      void onLoad(controller.signal).then(
        () => {
          if (!controller.signal.aborted) setLoading(false);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setLoading(false);
            setLoadError(error instanceof Error ? error.message : String(error));
          }
        },
      );
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, onLoad, retry]);

  const openMenu = () => {
    const root = rootRef.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      let clipTop = 0;
      let clipBottom = window.innerHeight;
      for (
        let parent = root.parentElement;
        parent && parent !== document.body;
        parent = parent.parentElement
      ) {
        const overflowY = getComputedStyle(parent).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          const clip = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, clip.top);
          clipBottom = Math.min(clipBottom, clip.bottom);
          break;
        }
      }
      const above = Math.max(0, bounds.top - clipTop - 8);
      const below = Math.max(0, clipBottom - bounds.bottom - 8);
      const placeAbove = below < 280 && above > below;
      setPlacement(placeAbove ? "above" : "below");
      setPopupMaxHeight(Math.max(100, placeAbove ? above : below));
    }
    setOpen(true);
  };

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
    } else {
      openMenu();
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      return;
    }
    setActive(Math.max(0, filtered.findIndex((item) => item.value === value)));
    searchRef.current?.focus();
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const move = (delta: number) => {
    if (filtered.length === 0) {
      return;
    }
    setActive((current) => {
      const next = current + delta;
      if (next < 0) {
        return filtered.length - 1;
      }
      if (next >= filtered.length) {
        return 0;
      }
      return next;
    });
  };

  return (
    <div className={`menu-select${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`menu-select-btn${selected || valueLabel ? "" : " is-placeholder"}${open ? " is-open" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled || (!onLoad && options.length === 0)}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) {
              openMenu();
              return;
            }
            move(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openMenu();
              return;
            }
            move(-1);
            return;
          }
          if ((event.key === "Enter" || event.key === " ") && open) {
            event.preventDefault();
            const next = filtered[active];
            if (next) {
              pick(next.value);
            }
          }
        }}
      >
        <span>{selected?.label || valueLabel || placeholder}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div
          className={`menu-select-pop${placement === "above" ? " is-above" : ""}`}
          style={{ maxHeight: `${popupMaxHeight}px` }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {searchable ? (
            <input
              ref={searchRef}
              type="search"
              name="conversation-filter"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="menu-select-search"
              value={query}
              placeholder={placeholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const next = filtered[active];
                  if (next) {
                    pick(next.value);
                  }
                }
              }}
              aria-label={placeholder}
            />
          ) : null}
          {onLoad && loading ? <p className="muted" role="status">{t("menuSelect.loading")}</p> : null}
          {onLoad && loadError ? (
            <div role="alert">
              <p className="action-error">{t("menuSelect.loadError", { error: loadError })}</p>
              <button type="button" className="ghost" onClick={() => setRetry((current) => current + 1)}>
                {t("menuSelect.retry")}
              </button>
            </div>
          ) : null}
          {onLoad && !loading && !loadError && query === debouncedQuery && filtered.length === 0
            ? <p className="muted" role="status">{t("menuSelect.empty")}</p> : null}
          <ul id={listId} className="menu-select-menu" role="listbox" aria-busy={onLoad ? loading : undefined}>
            {filtered.map((option, index) => (
              <li key={option.value || `empty-${index}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`menu-select-option${option.value === value ? " is-on" : ""}${
                    index === active ? " is-active" : ""
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pick(option.value);
                  }}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
