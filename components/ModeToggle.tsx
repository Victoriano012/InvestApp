"use client";

import type { ValueMode } from "./hooks";

export default function ModeToggle({
  mode,
  onToggle,
}: {
  mode: ValueMode;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="inline-flex overflow-hidden rounded-md border border-line text-sm"
      title="Toggle between absolute values and percentages"
      aria-label="Toggle between absolute values and percentages"
    >
      <span className={`px-2.5 py-1 ${mode === "abs" ? "bg-accent/15 font-semibold text-accent" : "text-muted"}`}>€</span>
      <span className={`px-2.5 py-1 ${mode === "pct" ? "bg-accent/15 font-semibold text-accent" : "text-muted"}`}>%</span>
    </button>
  );
}
