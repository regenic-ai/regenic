import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronIcon } from "./Icons";

export interface MenuSelectOption {
  value: string;
  label: string;
}

export function MenuSelect({
  value,
  options,
  placeholder,
  disabled,
  searchable,
  onChange,
}: {
  value: string;
  options: MenuSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((item) => item.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return options;
    }
    return options.filter((item) => item.label.toLowerCase().includes(needle));
  }, [options, query]);
  const [active, setActive] = useState(0);

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
    <div className="menu-select" ref={rootRef}>
      <button
        type="button"
        className={`menu-select-btn${selected ? "" : " is-placeholder"}${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled || options.length === 0}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
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
              setOpen(true);
              return;
            }
            move(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
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
        <span>{selected?.label || placeholder}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div
          className="menu-select-pop"
          onMouseDown={(event) => event.preventDefault()}
        >
          {searchable ? (
            <input
              ref={searchRef}
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
            />
          ) : null}
          <ul id={listId} className="menu-select-menu" role="listbox">
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
