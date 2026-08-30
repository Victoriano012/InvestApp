"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDate, fmtDateNum, RANGE_OPTIONS, rangeStart, todayISO, type RangeKey } from "@/lib/format";

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

/**
 * W&B-style zoom: press on a date, drag, release on another — that span
 * becomes the range. Wire start/move/end to the chart's mouse events and
 * render `drag` as a ReferenceArea while it's set. Mouse-up and mouse-move
 * are also watched at window level so a drag safely continues beyond the
 * chart bounds: the selection keeps following the pointer's x position
 * (mapped to the nearest visible date, clamped to the ends). For that the
 * chart registers its wrapper element via `containerRef` and its windowed
 * dates via `setDates(dates)` (a plain ref write — call it in render).
 *
 * Clicks and double-clicks are detected by hand from the press events:
 * the re-render our own mousedown triggers makes recharts replace the
 * hovered SVG node mid-press, so the browser never synthesizes native
 * click/dblclick events over the marks.
 */
export function useDragZoom(handlers: {
  onZoom: (from: string, to: string) => void;
  /** Double-click (two stationary presses within 400ms). */
  onReset?: () => void;
  /** Single stationary press-and-release, with the date under the cursor. */
  onClick?: (date: string) => void;
}) {
  // The ref is the source of truth: recharts may call `end` with a handler
  // closure from before `start`'s re-render, so reading the state there
  // would see a stale (null) drag and swallow quick clicks.
  const [drag, setDragState] = useState<{ from: string; to: string } | null>(null);
  const dragRef = useRef<{ from: string; to: string } | null>(null);
  const setDrag = (d: { from: string; to: string } | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const lastDown = useRef(0);
  const isDouble = useRef(false);
  // Timestamp of the last touch on the plot: browsers synthesize mouse events
  // (mousedown/up/click) right after a tap, and the touch handlers below have
  // already run the press logic for it — ignore that mouse echo.
  const lastTouch = useRef(0);
  const startImpl = (label?: unknown) => {
    if (typeof label !== "string") return;
    const now = Date.now();
    isDouble.current = now - lastDown.current < 400;
    lastDown.current = now;
    setDrag({ from: label, to: label });
  };
  const start = (label?: unknown) => {
    if (Date.now() - lastTouch.current < 800) return;
    startImpl(label);
  };
  const move = (label?: unknown) => {
    const d = dragRef.current;
    if (d && typeof label === "string" && label !== d.to) setDrag({ ...d, to: label });
  };
  const end = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    if (d.from !== d.to) {
      lastDown.current = 0;
      if (d.from < d.to) handlers.onZoom(d.from, d.to);
      else handlers.onZoom(d.to, d.from);
    } else if (isDouble.current) {
      lastDown.current = 0;
      isDouble.current = false;
      handlers.onReset?.();
    } else {
      handlers.onClick?.(d.from);
    }
  };
  const endRef = useRef(end);
  endRef.current = end;

  // Registered by the chart so an in-flight drag can track the mouse outside
  // the plot: wrapper element + the dates of the rows currently plotted.
  const containerEl = useRef<HTMLDivElement | null>(null);
  // After a tap, browsers replay it as mouse events; the trailing
  // mouseout/mouseover pair (ghost pointer "leaving" the plot) would reach
  // React's enter/leave plugin as a mouseleave on the chart wrapper and hide
  // the tooltip the tap just placed. The mouseover half targets an ANCESTOR
  // of the chart (relatedTarget is the plot element it left), so a listener
  // on the container never sees it — filter at document capture instead,
  // and only when the event actually involves this chart. Trusted-only:
  // our own synthetic events pass, and pure mouse use (lastTouch stays 0)
  // is never touched.
  const ghostFilter = useCallback((e: MouseEvent) => {
    if (!e.isTrusted || Date.now() - lastTouch.current >= 800) return;
    const el = containerEl.current;
    if (!el) return;
    const t = e.target;
    const r = e.relatedTarget;
    if ((t instanceof Node && el.contains(t)) || (r instanceof Node && el.contains(r))) e.stopPropagation();
  }, []);
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (containerEl.current && !node) {
        document.removeEventListener("mouseout", ghostFilter, true);
        document.removeEventListener("mouseover", ghostFilter, true);
      } else if (node && !containerEl.current) {
        document.addEventListener("mouseout", ghostFilter, true);
        document.addEventListener("mouseover", ghostFilter, true);
      }
      containerEl.current = node;
    },
    [ghostFilter]
  );
  const datesRef = useRef<string[]>([]);
  const setDates = (dates: string[]) => {
    datesRef.current = dates;
  };

  // Map a clientX onto the plotted date span (recharts lays the rows out
  // evenly across the plot — category point scale), clamped to the ends.
  // The grid's bbox is the plot area (axes and margins excluded).
  const dateAtX = (clientX: number): string | null => {
    const el = containerEl.current;
    const dates = datesRef.current;
    if (!el || dates.length === 0) return null;
    const plot = el.querySelector(".recharts-cartesian-grid") ?? el.querySelector("svg");
    const rect = plot?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return dates[Math.round(frac * (dates.length - 1))];
  };

  // On touch there is no mouseleave: a tap anywhere outside the chart puts
  // the tooltip/crosshair away (untrusted mouseout passes the ghost filter).
  useEffect(() => {
    const onDocTouchStart = (e: TouchEvent) => {
      const el = containerEl.current;
      if (!el || (e.target instanceof Node && el.contains(e.target))) return;
      const t = e.touches[0];
      if (!t) return;
      el.querySelector(".recharts-wrapper")?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY })
      );
    };
    document.addEventListener("touchstart", onDocTouchStart, { passive: true });
    return () => document.removeEventListener("touchstart", onDocTouchStart);
  }, []);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMouseUp = () => endRef.current();
    // Outside the plot area the selection keeps following the pointer.
    const onMouseMove = (e: MouseEvent) => {
      const el = containerEl.current;
      if (!el) return;
      const plot = el.querySelector(".recharts-cartesian-grid") ?? el.querySelector("svg");
      const rect = plot?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      // Inside the plot recharts' own onMouseMove reports activeLabel more
      // precisely — only take over when the pointer is outside it.
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return;
      const d = dateAtX(e.clientX);
      if (d) move(d);
    };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
    };
    // `move`/`dateAtX` only touch refs and the stable state setter — safe to close over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // --- Touch (phones): pair with `touch-pan-y` on the chart container. ---
  // A horizontal one-finger drag selects a zoom span; a vertical swipe is
  // left to the browser (page scroll); a tap runs the same press logic as a
  // mouse click, so single-tap → onClick and double-tap → onReset. Intent is
  // decided once, at the first move past a small slop.
  // Recharts' tooltip machinery only engages from real mouse moves (its own
  // touch path only handles per-item hover), so touch drives it by replaying
  // the finger as untrusted mousemove events on the recharts wrapper — the
  // tooltip, crosshair, active dots and coordinate-based bolding all behave
  // exactly as they do for the desktop pointer.
  const fireMouse = (type: string, x: number, y: number) => {
    containerEl.current
      ?.querySelector(".recharts-wrapper")
      ?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  };
  const touchSt = useRef<{ x: number; y: number; date: string; mode: "pending" | "zoom" | "scroll" } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    lastTouch.current = Date.now();
    if (e.touches.length !== 1) {
      // A second finger (pinch, etc.) cancels any selection in flight.
      touchSt.current = null;
      if (dragRef.current) setDrag(null);
      return;
    }
    const t = e.touches[0];
    const date = dateAtX(t.clientX);
    if (!date) return;
    touchSt.current = { x: t.clientX, y: t.clientY, date, mode: "pending" };
    fireMouse("mousemove", t.clientX, t.clientY); // tooltip appears under the finger
  };
  const onTouchMove = (e: React.TouchEvent) => {
    lastTouch.current = Date.now();
    const st = touchSt.current;
    if (!st || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (st.mode === "pending") {
      const dx = Math.abs(t.clientX - st.x);
      const dy = Math.abs(t.clientY - st.y);
      if (dx < 8 && dy < 8) return;
      if (dx > dy) st.mode = "zoom";
      else {
        st.mode = "scroll"; // the browser owns the gesture (pan-y)
        return;
      }
      startImpl(st.date);
    }
    if (st.mode === "zoom") {
      const d = dateAtX(t.clientX);
      if (d) move(d);
      fireMouse("mousemove", t.clientX, t.clientY); // tooltip follows the finger
    }
  };
  const onTouchEnd = () => {
    lastTouch.current = Date.now();
    const st = touchSt.current;
    touchSt.current = null;
    if (!st) return;
    if (st.mode === "zoom") {
      end();
      // The window just changed — a tooltip pinned to the old rows would show
      // stale data, so put it away (untrusted, passes the ghost filter below).
      fireMouse("mouseout", st.x, st.y);
    } else if (st.mode === "pending") {
      // A stationary tap: run it through the press logic so clicks and
      // double-tap reset behave exactly like their mouse counterparts. The
      // touchstart's mousemove already placed the tooltip here; it stays
      // until the next interaction.
      startImpl(st.date);
      end();
    }
  };
  const onTouchCancel = () => {
    lastTouch.current = Date.now();
    touchSt.current = null;
    if (dragRef.current) setDrag(null);
  };

  return {
    drag,
    start,
    move,
    end,
    containerRef,
    setDates,
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
  };
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

/** "5 Jan" prefix for lines aggregated across a month or year. */
function dayPrefix(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Hover tooltip listing a cell's transactions (parent needs `group relative`). */
function MarkTip({ lines }: { lines: string[] }) {
  const shown = lines.length > 11 ? lines.slice(0, 10) : lines;
  return (
    <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-0.5 hidden w-max max-w-[230px] -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-left text-[11px] leading-relaxed text-ink2 shadow-md group-hover:block">
      {shown.map((l, j) => (
        <span key={j} className="block whitespace-nowrap">
          {l}
        </span>
      ))}
      {shown.length < lines.length && <span className="block text-muted">…and {lines.length - shown.length} more</span>}
    </span>
  );
}

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
  // Year/month cells aggregate their days' transactions, each line prefixed
  // with the day ("5 Jan — Buy X"), for the same hover tooltip the days get.
  const [txnYears, txnMonths] = useMemo(() => {
    const years = new Map<string, string[]>();
    const months = new Map<string, string[]>();
    for (const d of [...txnMap.keys()].sort()) {
      const lines = txnMap.get(d)!.map((l) => `${dayPrefix(d)} — ${l}`);
      for (const [m, key] of [[years, d.slice(0, 4)], [months, d.slice(0, 7)]] as const) {
        const arr = m.get(key);
        if (arr) arr.push(...lines);
        else m.set(key, [...lines]);
      }
    }
    return [years, months];
  }, [txnMap]);

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
          {Array.from({ length: 12 }, (_, i) => start + i).map((y) => {
            const marks = txnYears.get(String(y));
            return (
              <span key={y} className="group relative">
                <button
                  disabled={y < minY || y > maxY}
                  onClick={() => {
                    setMonth(`${y}-${month.slice(5)}`);
                    setView("months");
                  }}
                  className={`relative w-full rounded-md py-1.5 text-xs tabular-nums ${
                    y === year
                      ? "bg-accent font-semibold text-white"
                      : y < minY || y > maxY
                        ? "text-muted/40"
                        : "text-ink2 hover:bg-accent/10"
                  }`}
                >
                  {y}
                  {marks && (
                    <span
                      className={`absolute bottom-[1px] left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full ${
                        y === year ? "bg-white" : "bg-accent"
                      }`}
                    />
                  )}
                </button>
                {marks && <MarkTip lines={marks} />}
              </span>
            );
          })}
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
            const marks = txnMonths.get(ym);
            return (
              <span key={ym} className="group relative">
                <button
                  disabled={off}
                  onClick={() => {
                    setMonth(ym);
                    setView("days");
                  }}
                  className={`relative w-full rounded-md py-1.5 text-xs ${
                    ym === month ? "bg-accent font-semibold text-white" : off ? "text-muted/40" : "text-ink2 hover:bg-accent/10"
                  }`}
                >
                  {name}
                  {marks && (
                    <span
                      className={`absolute bottom-[1px] left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full ${
                        ym === month ? "bg-white" : "bg-accent"
                      }`}
                    />
                  )}
                </button>
                {marks && <MarkTip lines={marks} />}
              </span>
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
              {marks && <MarkTip lines={marks} />}
            </span>
          );
        })}
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
        className="rounded-md border border-line bg-surface px-2.5 py-1 tabular-nums text-ink2 hover:border-accent/50"
      >
        <span className="max-sm:hidden">{value ? fmtDate(value) : "…"}</span>
        <span className="sm:hidden">{value ? fmtDateNum(value) : "…"}</span>
      </button>
      {open && (
        // Phones: the anchored popover would run off the 390px viewport, so
        // ≤ sm it becomes a fixed, horizontally centered overlay instead.
        <span
          className={`absolute top-full z-30 mt-1 block rounded-lg border border-line bg-surface p-2 shadow-lg max-sm:fixed max-sm:inset-x-0 max-sm:top-28 max-sm:mx-auto max-sm:mt-0 max-sm:w-fit ${
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
 * Range picker shared by the Charts and Capital pages: presets, plus custom
 * from/to dates via a calendar popover that marks transaction dates with a
 * dot (hover shows the transactions).
 */
export default function RangeControl({
  sel,
  onChange,
  txns,
  min,
  max,
  windowFrom,
}: {
  sel: RangeSel;
  onChange: (s: RangeSel) => void;
  txns: TxnMark[];
  min?: string;
  max?: string;
  /** Effective start of the rendered window when it's later than the preset's
   *  (e.g. "All" clamped to the selected assets' first buy) — display only. */
  windowFrom?: string;
}) {
  const today = todayISO();
  const win = rangeWindow(sel, today);
  let showFrom = sel.preset === "custom" ? sel.from : min && win.from < min ? min : win.from;
  if (sel.preset !== "custom" && windowFrom && windowFrom > showFrom) showFrom = windowFrom;
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
    <span className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="inline-flex overflow-hidden rounded-md border border-line">
        {RANGE_OPTIONS.map((r) => (
          <button
            key={r.key}
            onClick={() => onChange({ preset: r.key, from: "", to: "" })}
            className={`px-2.5 py-1 ${sel.preset === r.key ? "bg-accent/15 font-semibold text-accent" : "bg-surface text-muted hover:text-ink2"}`}
          >
            {r.label}
          </button>
        ))}
      </span>
      {/* One flex item, so on a narrow screen the pair wraps as a unit. */}
      <span className="flex items-center gap-1.5">
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
      </span>
    </span>
  );
}
