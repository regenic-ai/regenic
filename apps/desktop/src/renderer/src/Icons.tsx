export function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="7.5" cy="7.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="m11 11 4 4" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}

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

export function ConnectIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M6.2 3v3M11.8 3v3M4.6 6h8.8v2.4a4.4 4.4 0 0 1-8.8 0V6ZM9 12.8V15.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ConnectedAppsHint() {
  return (
    <span className="connected-app-hint" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <rect width="16" height="16" rx="4" fill="#fff" />
        <path d="M4 3.3 8.1 2l3.9 2.1-2.2 1.4L8 4.6 5.3 5.7 4 3.3Z" fill="#36C5F0" />
        <path d="m4 3.3 1.3 2.4-1.1 2.7L2.5 6.1 4 3.3Z" fill="#00B96B" />
        <path d="m4.2 8.4 2.5.6 1.4 2.3-2.8 1.1-2.2-1.7 1.1-2.3Z" fill="#7B61FF" />
        <path d="m8.1 11.3 1.7-2.1L12.6 9l.2 2.8-2.1 1.8-2.6-2.3Z" fill="#FFB800" />
      </svg>
      <svg viewBox="0 0 16 16">
        <rect width="16" height="16" rx="4" fill="#111" />
        <path d="m4 5.1 4-2.2 4 2.2v5.8l-4 2.2-4-2.2V5.1Zm2 .9v4l2 1.1 2-1.1V6L8 4.9 6 6Z" fill="#fff" />
      </svg>
    </span>
  );
}

export function FlowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="4.4" cy="4.6" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13.6" cy="13.4" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.3 4.6h4.2a2.3 2.3 0 0 1 0 4.6h-3a2.3 2.3 0 0 0 0 4.6h4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 4h11M4.5 8h7M6.5 12h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.2 3v10" stroke="currentColor" strokeWidth="1.3" />
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

export function HideIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 8s2.2-3.6 6-3.6S14 8 14 8s-2.2 3.6-6 3.6S2 8 2 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3 13 13 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ShowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 8s2.2-3.6 6-3.6S14 8 14 8s-2.2 3.6-6 3.6S2 8 2 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
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

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 2.2v7.6M2.2 6h7.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M3 4.5 6 7.5 9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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

export function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3.5 4.8c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v5.4c0 .9-.7 1.6-1.6 1.6H8.2L5 14.5v-2.7h0c-.8-.1-1.5-.8-1.5-1.6V4.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.2c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M12.6 10.6c.15.9.5 1.25 1.4 1.4-.9.15-1.25.5-1.4 1.4-.15-.9-.5-1.25-1.4-1.4.9-.15 1.25-.5 1.4-1.4Z" fill="currentColor" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M9 5.6V9l2.3 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
