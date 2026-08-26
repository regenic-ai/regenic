import type { ReactNode } from "react";
import { t } from "../../shared/i18n.ts";
import { chipLabel } from "./format";
import type { EngineChipState } from "./types";

export function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rail-btn${active ? " active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function EngineChip({ state }: { state: EngineChipState }) {
  return (
    <span className={`chip ${state}`}>
      <span className="dot" />
      {t("chrome.kernel", { state: chipLabel(state) })}
    </span>
  );
}
