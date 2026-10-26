import type { CSSProperties } from "react";

const BRIGHT = [
  "#1e86fc",
  "#fb2b3e",
  "#14c16f",
  "#fd690f",
  "#f59312",
  "#13b7a2",
  "#8f59f9",
  "#f93498",
  "#a06b39",
];

const SHAPES = ["blob", "squircle", "pebble", "tablet", "petal"];

function hash(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function identityColor(seed: string): string {
  return BRIGHT[hash(seed) % BRIGHT.length];
}

function initial(label: string): string {
  const first = Array.from(label.replace(/\s+/g, " ").trim())[0];
  return first ? first.toUpperCase() : "·";
}

export function IdentityAvatar({
  seed,
  label,
  kind = "contact",
  size,
  className,
}: {
  seed: string;
  label: string;
  kind?: "contact" | "bot" | "self" | "system";
  size?: number;
  className?: string;
}) {
  const value = hash(seed);
  const style: CSSProperties = {};
  if (kind === "contact") {
    (style as Record<string, string>)["--identity"] = BRIGHT[value % BRIGHT.length];
  }
  if (size) {
    style.width = size;
    style.height = size;
    style.fontSize = Math.round(size * 0.4);
  }
  const shape = kind === "contact" ? ` shape-${SHAPES[(value >>> 8) % SHAPES.length]}` : "";
  return (
    <span
      className={`identity-avatar is-${kind === "contact" ? "contact" : kind}${shape}${
        className ? ` ${className}` : ""
      }`}
      style={style}
      aria-hidden="true"
    >
      {kind === "bot" ? null : initial(label)}
    </span>
  );
}
