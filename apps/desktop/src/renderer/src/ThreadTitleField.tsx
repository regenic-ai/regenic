import { useEffect, useState } from "react";

export function ThreadTitleField({
  value,
  className,
  editing: editingProp,
  onEditingChange,
  onSave,
}: {
  value: string;
  className: string;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSave: (title: string | null) => Promise<void>;
}) {
  const [internalEditing, setInternalEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const editing = editingProp ?? internalEditing;
  const setEditing = (next: boolean) => {
    onEditingChange?.(next);
    if (editingProp === undefined) {
      setInternalEditing(next);
    }
  };

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [value, editing]);

  const commit = async () => {
    const next = draft.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (next === value.trim()) {
      setDraft(value);
      return;
    }
    try {
      await onSave(next.length > 0 ? next : null);
    } catch {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <input
        className={`${className} is-editing`}
        value={draft}
        maxLength={120}
        autoFocus
        aria-label="Conversation title"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className={className}
      title="Double-click to rename"
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}
