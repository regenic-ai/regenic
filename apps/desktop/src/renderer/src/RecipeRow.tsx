import type { ReactNode } from "react";

export function RecipeRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="recipe-row">
      <span className="recipe-row-label">{label}</span>
      <div className="recipe-row-body">{children}</div>
    </div>
  );
}
