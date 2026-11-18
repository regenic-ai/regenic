import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  children,
  actions,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? " is-compact" : ""}`}>
      {icon ? <span className="empty-state-icon" aria-hidden="true">{icon}</span> : null}
      <strong className="empty-state-title">{title}</strong>
      {children ? <div className="empty-state-body">{children}</div> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  );
}
