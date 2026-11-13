import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";

export function RecipeRow({
  label,
  hint,
  descriptionId,
  children,
}: {
  label: string;
  hint?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <div className="recipe-row">
      <span className="recipe-row-label">
        <span className="settings-label">{label}
          {hint ? <InfoTip label={label} id={descriptionId}>{hint}</InfoTip> : null}
        </span>
      </span>
      <div className="recipe-row-body">{children}</div>
    </div>
  );
}
