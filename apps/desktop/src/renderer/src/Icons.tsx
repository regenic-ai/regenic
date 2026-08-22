export function InboxIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3 4.5h12v9.2a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 13.7V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3 10h3.2l.8 1.6h4l.8-1.6H15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function EngineIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M9 2.4v1.8M9 13.8v1.8M2.4 9h1.8M13.8 9h1.8M4.3 4.3l1.3 1.3M12.4 12.4l1.3 1.3M13.7 4.3l-1.3 1.3M5.6 12.4l-1.3 1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FormatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 12.5 6.2 3.5h1.6l2.7 9H9.2l-.5-1.8H5.3l-.5 1.8H3.5Zm2.2-3.2h2.6L7.1 5.4 5.7 9.3ZM11 4.2h2.6v1h-1.7V12h-1V5.2H11v-1Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function AttachIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8.7 3.6 4.2 8.1a2.4 2.4 0 1 0 3.4 3.4l5-5a1.6 1.6 0 1 0-2.3-2.3l-4.8 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.4 8.1 13.4 3.4 9 13.3l-.8-4.2-3.8-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.6 2.4 13.6 5.4a1 1 0 0 1-.15 1.55L11.2 8.2 8.7 13.2a.5.5 0 0 1-.9.05L6.3 10.2 3.2 9.1a.5.5 0 0 1-.1-.85L8 5.6l1.3-2.25A1 1 0 0 1 10.6 2.4Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.4 10.1 3.2 13.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9.4 3.4 12.6 6.6 6 13.2H2.8v-3.2L9.4 3.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8.2 4.6 11.4 7.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3.5 5.2h11M3.5 9h11M3.5 12.8h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="6.2" cy="5.2" r="1.2" fill="currentColor" />
      <circle cx="11.5" cy="9" r="1.2" fill="currentColor" />
      <circle cx="7.4" cy="12.8" r="1.2" fill="currentColor" />
    </svg>
  );
}

