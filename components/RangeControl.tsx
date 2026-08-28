"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDate, RANGE_OPTIONS, rangeStart, todayISO, type RangeKey } from "@/lib/format";

/** A chart x-range: a preset, or explicit custom dates ("" = open end). */
export interface RangeSel {
  preset: RangeKey | "custom";
  from: string;
  to: string;
}

export function rangeWindow(sel: RangeSel, today: string): { from: string; to: string } {
  if (sel.preset === "custom") {
    let from = sel.from || "0000-00-00";
    let to = sel.to || today;
    if (to < from) [from, to] = [to, from];
    return { from, to };
  }
  return { from: rangeStart(sel.preset, today), to: today };
}

/** One transaction to mark on the calendar (several may share a date). */
export interface TxnMark {
  date: string;
  label: string;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function Calendar({
  value,
  min,
  max,
  txnMap,
  onPick,
}: {
  value: string;
  min?: string;
  max?: string;
  txnMap: Map<string, string[]>;
  onPick: (d: string) => void;
}) {
  const [month, setMonth] = useState(() => (value || max || todayISO()).slice(0, 7));
  // Clicking the header drills up: days → years → months → days.
  const [view, setView] = useState<"days" | "years" | "months">("days");
  const firstDow = (new Date(month + "-01T00:00:00Z").getUTCDay() + 6) % 7; // Monday first
  const n = daysInMonth(month);
  const monthName = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const canPrev = !min || min < month + "-01";
  const canNext = !max || `${month}-${String(n).padStart(2, "0")}` < max;
  const cells: (string | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];

  const year = Number(month.slice(0, 4));
  const minY = min ? Number(min.slice(0, 4)) : -Infinity;
  const maxY = max ? Number(max.slice(0, 4)) : Infinity;

  if (view === "years") {
    const start = year - ((year % 12) + 12) % 12;
    return (
      <div className="w-[252px] select-none">
        <div className="mb-1 flex items-center justify-between">
          <button
            onClick={() => setMonth(`${year - 12}-${month.slice(5)}`)}
            disabled={start - 1 < minY}
            className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
            aria-label="Previous years"
          >
            ‹
          </button>
          <span className="text-xs font-medium text-ink2">
            {start}–{start + 11}
          </span>
          <button
            onClick={() => setMonth(`${year + 12}-${month.slice(5)}`)}
            disabled={start + 12 > maxY}
            className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
            aria-label="Next years"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 12 }, (_, i) => start + i).map((y) => (
            <button
              key={y}
              disabled={y < minY || y > maxY}
              onClick={() => {
                setMonth(`${y}-${month.slice(5)}`);
                setView("months");
              }}
              className={`rounded-md py-1.5 text-xs tabular-nums ${
                y === year
                  ? "bg-accent font-semibold text-white"
                  : y < minY || y > maxY
                    ? "text-muted/40"
                    : "text-ink2 hover:bg-accent/10"
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (view === "months") {
    return (
      <div className="w-[252px] select-none">
        <div className="mb-1 flex items-center justify-between">
          <button
            onClick={() => setMonth(`${year - 1}-${month.slice(5)}`)}
            disabled={year - 1 < minY}
            className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
            aria-label="Previous year"
          >
            ‹
          </button>
          <button className="rounded px-2 text-xs font-medium text-ink2 hover:bg-accent/10" onClick={() => setView("years")}>
            {year}
          </button>
          <button
            onClick={() => setMonth(`${year + 1}-${month.slice(5)}`)}
            disabled={year + 1 > maxY}
            className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
            aria-label="Next year"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`).map((ym) => {
            const off = (!!min && ym < min.slice(0, 7)) || (!!max && ym > max.slice(0, 7));
            const name = new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
            return (
              <button
                key={ym}
                disabled={off}
                onClick={() => {
                  setMonth(ym);
                  setView("days");
                }}
                className={`rounded-md py-1.5 text-xs ${
                  ym === month ? "bg-accent font-semibold text-white" : off ? "text-muted/40" : "text-ink2 hover:bg-accent/10"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[252px] select-none">
      <div className="mb-1 flex items-center justify-between">
        <button
          onClick={() => setMonth(shiftMonth(month, -1))}
          disabled={!canPrev}
          className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
          aria-label="Previous month"
        >
          ‹
        </button>
        <button
          className="rounded px-2 text-xs font-medium text-ink2 hover:bg-accent/10"
          onClick={() => setView("years")}
          title="Pick year and month"
        >
          {monthName}
        </button>
        <button
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={!canNext}
          className="rounded px-2 py-0.5 text-ink2 hover:bg-accent/10 disabled:opacity-30"
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-0.5 text-[10px] text-muted">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={`pad${i}`} />;
          const marks = txnMap.get(d);
          const disabled = (!!min && d < min) || (!!max && d > max);
          const isSel = d === value;
          return (
            <span key={d} className="group relative flex justify-center">
              <button
                disabled={disabled}
                onClick={() => onPick(d)}
                className={`relative h-8 w-8 rounded-md text-xs tabular-nums ${
                  isSel
                    ? "bg-accent font-semibold text-white"
                    : disabled
                      ? "text-muted/40"
                      : "text-ink2 hover:bg-accent/10"
                }`}
              >
                {Number(d.slice(8))}
                {marks && (
                  <span
                    className={`absolute bottom-[3px] left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full ${
                      isSel ? "bg-white" : "bg-accent"
                    }`}
                  />
                )}
              </button>
              {marks && (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-0.5 hidden w-max max-w-[230px] -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-left text-[11px] leading-relaxed text-ink2 shadow-md group-hover:block">
                  {marks.map((l, j) => (
                    <span key={j} className="block whitespace-nowrap">
                      {l}
                    </span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-line pt-1.5 text-[10px] text-muted">
        <span className="h-[5px] w-[5px] rounded-full bg-accent" /> transaction — hover the dot for
        details
      </div>
    </div>
  );
}

function DateField({
  value,
  min,
  max,
  txnMap,
  onPick,
  title,
  align,
}: {
  value: string;
  min?: string;
  max?: string;
  txnMap: Map<string, string[]>;
  onPick: (d: string) => void;
  title: string;
  align: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <span ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={title}
        className="rounded-md border border-line bg-surface px-2 py-1 tabular-nums text-ink2 hover:border-accent/50"
      >
        {value ? fmtDate(value) : "…"}
      </button>
      {open && (
        <span
          className={`absolute top-full z-30 mt-1 block rounded-lg border border-line bg-surface p-2 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <Calendar
            key={value}
            value={value}
            min={min}
            max={max}
            txnMap={txnMap}
            onPick={(d) => {
              onPick(d);
              setOpen(false);
            }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * Range picker shared by the Charts and Capital pages: presets, custom
 * from/to dates via a calendar popover that marks transaction dates with a
 * dot (hover shows the transactions), and a one-press return to the last
 * manually set range after a brush zoom.
 */
export default function RangeControl({
  sel,
  onChange,
  onBack,
  backTo,
  txns,
  min,
  max,
}: {
  sel: RangeSel;
  onChange: (s: RangeSel) => void;
  onBack?: () => void;
  backTo?: RangeSel | null;
  txns: TxnMark[];
  min?: string;
  max?: string;
}) {
  const today = todayISO();
  const win = rangeWindow(sel, today);
  const showFrom = sel.preset === "custom" ? sel.from : min && win.from < min ? min : win.from;
  const showTo = sel.preset === "custom" ? sel.to : max && max < win.to ? max : win.to;

  const txnMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of txns) {
      const arr = m.get(t.date);
      if (arr) arr.push(t.label);
      else m.set(t.date, [t.label]);
    }
    return m;
  }, [txns]);

  const custom = (from: string, to: string) => onChange({ preset: "custom", from, to });

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex overflow-hidden rounded-md border border-line">
        {RANGE_OPTIONS.map((r) => (
          <button
            key={r.key}
            onClick={() => onChange({ preset: r.key, from: "", to: "" })}
            className={`px-2 py-1 ${sel.preset === r.key ? "bg-accent/15 font-semibold text-accent" : "text-muted hover:text-ink2"}`}
          >
            {r.label}
          </button>
        ))}
      </span>
      <DateField
        value={showFrom}
        min={min}
        max={showTo || max}
        txnMap={txnMap}
        onPick={(d) => custom(d, showTo)}
        title="Start date — transaction dates are dotted on the calendar"
        align="left"
      />
      <span className="text-muted">→</span>
      <DateField
        value={showTo}
        min={showFrom || min}
        max={max}
        txnMap={txnMap}
        onPick={(d) => custom(showFrom, d)}
        title="End date — transaction dates are dotted on the calendar"
        align="right"
      />
      {backTo && onBack && (
        <button
          onClick={onBack}
          className="rounded-md border border-line px-2 py-1 text-muted hover:text-ink2"
          title={`Back to ${backTo.preset === "custom" ? `${backTo.from || "start"} → ${backTo.to || "today"}` : backTo.preset.toUpperCase()}`}
        >
          ↩ Prev range
        </button>
      )}
    </span>
  );
}
