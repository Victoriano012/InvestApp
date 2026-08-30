"use client";

import { useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Dot,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useYAxisInverseScale,
  type ActiveDotProps,
} from "recharts";
import { useDark, useJson, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import RangeControl, { rangeWindow, useDragZoom, type RangeSel } from "./RangeControl";
import { axisDateFmt, daysBetween, fmtCompact, fmtDate, fmtEUR, fmtMoney, fmtNum, fmtPct, todayISO } from "@/lib/format";
import { categoryColor, categoryShade, chrome, mixHex } from "@/lib/palette";
import { CATEGORIES, type CapitalData, type Category } from "@/lib/types";

type Grouping = "category" | "asset";

interface CapSeries {
  key: string;
  label: string;
  color: string;
}

export default function CapitalChart() {
  const { data, error } = useJson<CapitalData>("/api/capital");
  const [mode, toggleMode] = useValueMode();
  const [grouping, setGrouping] = useState<Grouping>("category");
  const [sel, setSel] = useState<RangeSel>({ preset: "all", from: "", to: "" });
  // Last range set explicitly (presets/calendar) — what a double-click
  // returns to, so consecutive drag zooms don't overwrite it.
  const manualSel = useRef<RangeSel>({ preset: "all", from: "", to: "" });
  const dark = useDark();
  const C = chrome(dark);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [cats, setCats] = useState<Category[] | null>(null); // null = all groups

  // Short asset names wherever set — tooltips, panels and calendars are tight on space.
  const nameFor = useMemo(() => {
    const m = new Map((data?.assets ?? []).map((a) => [a.id, a.short_name]));
    return (id: number, full: string) => m.get(id) || full;
  }, [data]);

  // W&B-style zoom: press on a date, drag, release on another — that span
  // becomes the range. Double-click returns to the range picked at the top;
  // a plain click selects the nearest transaction date (±5 days).
  const zoom = useDragZoom({
    onZoom: (from, to) => setSel({ preset: "custom", from, to }),
    onReset: () => setSel(manualSel.current),
    onClick: (label) => {
      const clicked = Date.parse(label);
      let best: string | null = null;
      let bestDist = 5 * 86400000 + 1;
      for (const t of model?.catTxnDates ?? []) {
        const dist = Math.abs(Date.parse(t.date) - clicked);
        if (dist < bestDist) {
          bestDist = dist;
          best = t.date;
        }
      }
      setSelectedDate((cur) => (best === cur ? null : best));
    },
  });

  const pct = mode === "pct";
  const catOn = (k: Category) => !cats || cats.includes(k);

  const txnMarks = useMemo(
    () =>
      (data?.txnDates ?? []).flatMap((t) =>
        t.txns.map((x) => ({
          date: t.date,
          label: `${x.type === "buy" ? "Buy" : "Sell"} ${nameFor(x.assetId, x.assetName)} · ${fmtEUR(x.amountEUR)}`,
        }))
      ),
    [data, nameFor]
  );

  const model = useMemo(() => {
    if (!data || data.dates.length === 0) return null;
    const active = (k: Category) => !cats || cats.includes(k);

    let series: CapSeries[];
    let valuesOf: (key: string) => number[];
    if (grouping === "category") {
      const src = data.valueByCategory;
      series = CATEGORIES.filter((c) => active(c.key) && src[c.key].some((v) => v > 0)).map((c) => ({
        key: c.key,
        label: c.label,
        color: categoryColor(c.key, dark),
      }));
      valuesOf = (key) => src[key as Category];
    } else {
      // Stack assets grouped by category, each in a shade of its category hue.
      const catIdx = new Map(CATEGORIES.map((c, i) => [c.key, i]));
      const sorted = [...data.assets].sort(
        (a, b) => (catIdx.get(a.category) ?? 99) - (catIdx.get(b.category) ?? 99)
      );
      const seen = new Map<Category, number>();
      const byId = new Map<string, number[]>();
      series = [];
      for (const a of sorted) {
        const vals = a.value;
        if (!vals.some((v) => v > 0)) continue;
        const shade = seen.get(a.category) ?? 0;
        seen.set(a.category, shade + 1);
        if (!active(a.category)) continue; // shade index stays stable even when filtered out
        series.push({ key: `a${a.id}`, label: a.short_name || a.name, color: categoryShade(a.category, shade, dark) });
        byId.set(`a${a.id}`, vals);
      }
      valuesOf = (key) => byId.get(key)!;
    }

    // Transactions of hidden groups disappear with them.
    const catTxnDates = data.txnDates
      .map((t) => ({ ...t, txns: t.txns.filter((x) => active(x.category)) }))
      .filter((t) => t.txns.length > 0);

    const win = rangeWindow(sel, todayISO());
    // "All" spans the visible groups' history (first day any of them has
    // capital), not the whole dataset's.
    let winFrom = win.from;
    if (sel.preset === "all") {
      let first: string | null = null;
      for (const s of series) {
        const idx = valuesOf(s.key).findIndex((v) => v > 0);
        if (idx >= 0 && (first == null || data.dates[idx] < first)) first = data.dates[idx];
      }
      if (first) winFrom = first;
    }
    let i0 = data.dates.findIndex((d) => d >= winFrom);
    if (i0 < 0) i0 = 0;
    let i1 = data.dates.length - 1;
    while (i1 > i0 && data.dates[i1] > win.to) i1--;

    const txnDateSet = new Set(catTxnDates.map((t) => t.date));
    let rows = data.dates.slice(i0, i1 + 1).map((d, i) => {
      const r: Record<string, string | number> = { date: d };
      for (const s of series) r[s.key] = valuesOf(s.key)[i0 + i] ?? 0;
      return r;
    });
    if (rows.length > 700) {
      const stride = Math.ceil(rows.length / 700);
      rows = rows.filter((r, i) => i % stride === 0 || i === rows.length - 1 || txnDateSet.has(r.date as string));
    }
    const first = (rows[0]?.date as string) ?? "9999";
    const last = (rows[rows.length - 1]?.date as string) ?? "0000";
    const visibleTxnDates = catTxnDates.filter((t) => t.date >= first && t.date <= last);
    return { rows, series, catTxnDates, visibleTxnDates, winFrom };
  }, [data, grouping, sel, cats, dark]);

  if (error) return <p className="p-6 text-sm text-down">Failed to load: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!model || data.txnDates.length === 0)
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-line bg-surface p-8 text-center text-sm text-muted">
          No transactions yet — this chart shows how your capital is split across categories over time.
        </p>
      </div>
    );

  const { rows, series, catTxnDates, visibleTxnDates } = model;
  // Lets an in-flight drag-zoom keep following the mouse outside the plot.
  zoom.setDates(rows.map((r) => r.date as string));
  const tickFmt = axisDateFmt(
    rows.length > 1 ? daysBetween(rows[0].date as string, rows[rows.length - 1].date as string) : 0,
    rows.length
  );
  const selected = selectedDate ? catTxnDates.find((t) => t.date === selectedDate) ?? null : null;

  const presentCats = CATEGORIES.filter((c) => data.valueByCategory[c.key].some((v) => v > 0));
  const toggleCat = (k: Category) => {
    const cur = new Set(cats ?? presentCats.map((c) => c.key));
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
    setCats(cur.size === presentCats.length ? null : [...cur]);
  };

  const setManual = (s: RangeSel) => {
    manualSel.current = s;
    setSel(s);
  };

  // For each transaction, a colored segment on its marker line spanning the
  // stack band of the asset/group that was bought or sold.
  const rowByDate = new Map(rows.map((r) => [r.date as string, r]));
  const txnBands: { id: string; date: string; y1: number; y2: number; color: string }[] = [];
  for (const t of visibleTxnDates) {
    const row = rowByDate.get(t.date);
    if (!row) continue;
    const total = series.reduce((s2, s) => s2 + (Number(row[s.key]) || 0), 0);
    const done = new Set<string>();
    for (const txn of t.txns) {
      const key = grouping === "category" ? txn.category : `a${txn.assetId}`;
      if (done.has(key)) continue;
      done.add(key);
      let cum = 0;
      let band: [number, number] | null = null;
      let color = "";
      for (const s of series) {
        const v = Number(row[s.key]) || 0;
        if (s.key === key) {
          band = [cum, cum + v];
          color = s.color;
          break;
        }
        cum += v;
      }
      if (!band || band[0] === band[1]) continue;
      const [y1, y2] = pct && total > 0 ? [band[0] / total, band[1] / total] : band;
      txnBands.push({ id: `${t.date}:${key}`, date: t.date, y1, y2, color });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ModeToggle mode={mode} onToggle={toggleMode} />
          <Toggle
            options={[{ k: "category", l: "Groups" }, { k: "asset", l: "Assets" }]}
            value={grouping}
            onChange={(v) => setGrouping(v as Grouping)}
            title="Stack by category or by individual asset"
          />
          <RangeControl
            sel={sel}
            onChange={setManual}
            txns={txnMarks}
            min={data.dates[0]}
            max={data.dates[data.dates.length - 1]}
            windowFrom={model.winFrom}
          />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-2 md:p-3">
        {series.length === 0 ? (
          // Same height as the chart — the block must not resize when nothing is selected.
          <div className="flex h-[320px] w-full items-center justify-center md:h-[420px]">
            <p className="text-sm text-muted">Select at least one group.</p>
          </div>
        ) : (
          <div
            ref={zoom.containerRef}
            // touch-pan-y: vertical swipes scroll the page; horizontal drags
            // reach the touch handlers (zoom). No effect on mouse input.
            // max-sm:overflow-x-clip: recharts renders the tooltip at the raw
            // cursor position for a frame before flipping it inside the plot;
            // near the right edge that transient overflow makes mobile Chrome
            // ratchet the layout viewport wider (page zooms out permanently).
            className="h-[320px] w-full touch-pan-y select-none max-sm:overflow-x-clip md:h-[420px]"
            title="Drag to zoom — double-click to reset to the range picked above"
            {...zoom.touchHandlers}
          >
            <ResponsiveContainer>
              <AreaChart
                // Recharts 3 stacks in item *registration* (mount) order, not
                // JSX order — a group toggled off and back on would re-register
                // last and jump to the top of the stack. Remount the chart when
                // the set of series changes so registration follows the
                // canonical `series` order again.
                key={series.map((s) => s.key).join("|")}
                data={rows}
                accessibilityLayer={false} // keeps the svg unfocusable — no focus rectangle on click
                stackOffset={pct ? "expand" : "none"}
                margin={{ top: 10, right: 12, bottom: 0, left: 4 }}
                onMouseDown={(e, ev) => {
                  ev?.preventDefault(); // stop native text-selection/drag (Firefox/Safari ignore user-select on SVG mid-drag)
                  zoom.start(e?.activeLabel);
                }}
                onMouseMove={(e) => zoom.move(e?.activeLabel)}
                onMouseUp={zoom.end}
              >
                <CartesianGrid stroke={C.grid} strokeWidth={1} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: C.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: C.axis }}
                  tickFormatter={tickFmt}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: C.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width="auto"
                  tickFormatter={(v: number) => (pct ? fmtPct(v, false, 0) : fmtCompact(v))}
                />
                <Tooltip
                  content={<CapTip pct={pct} chromeC={C} series={series} txnDates={catTxnDates} nameFor={nameFor} />}
                  cursor={{ stroke: C.muted, strokeWidth: 1, strokeDasharray: "3 3" }}
                  isAnimationActive={false}
                />
                {series.map((s, i) => (
                  <Area
                    key={s.key}
                    // stepAfter: a transaction shows as a vertical jump ON its
                    // date (each row already holds the post-txn value), not a
                    // ramp from the day before. At daily resolution the stairs
                    // between txns read like a linear line anyway.
                    type="stepAfter"
                    dataKey={s.key}
                    name={s.label}
                    stackId="cap"
                    stroke={C.surface}
                    strokeWidth={1}
                    fill={s.color}
                    fillOpacity={0.85}
                    isAnimationActive={false}
                    // Hover dots mark the internal boundaries only — none on the outer top
                    // edge, and none for series worth 0 at the hovered date (they'd pile
                    // up as ghost dots on the stack line).
                    activeDot={
                      i === series.length - 1
                        ? false
                        : (props: ActiveDotProps) =>
                            (Number(props.payload?.[s.key]) || 0) > 0 ? <Dot {...props} /> : null
                    }
                  />
                ))}
                {visibleTxnDates.map((t) => (
                  <ReferenceLine
                    key={t.date}
                    x={t.date}
                    stroke={C.ink}
                    strokeWidth={t.date === selectedDate ? 2.5 : 1.5}
                  />
                ))}
                {/* Drawn after the ink lines so the traded band's color covers them. */}
                {txnBands.map((b) => (
                  <ReferenceLine
                    key={b.id}
                    segment={[{ x: b.date, y: b.y1 }, { x: b.date, y: b.y2 }]}
                    stroke={mixHex(b.color, "#000000", dark ? 0.25 : 0.4)}
                    strokeWidth={3}
                    strokeLinecap="round"
                  />
                ))}
                {zoom.drag && (
                  <ReferenceArea
                    x1={zoom.drag.from}
                    x2={zoom.drag.to}
                    fill={C.muted}
                    fillOpacity={0.15}
                    stroke={C.axis}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Group filter — doubles as the legend (color swatches). */}
      {presentCats.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            onClick={() => setCats(null)}
            className={`rounded-md border border-line px-2 py-1 ${cats ? "bg-surface text-muted hover:text-ink2" : "text-ink2"}`}
          >
            All
          </button>
          <button
            onClick={() => setCats([])}
            className={`rounded-md border border-line px-2 py-1 ${cats?.length === 0 ? "text-ink2" : "bg-surface text-muted hover:text-ink2"}`}
          >
            None
          </button>
          {presentCats.map((c) => {
            const on = catOn(c.key);
            const color = categoryColor(c.key, dark);
            return (
              <button
                key={c.key}
                onClick={() => toggleCat(c.key)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                  on ? "border-transparent font-medium" : "border-line bg-surface text-muted"
                }`}
                style={on ? { background: color + (dark ? "2e" : "1f"), color } : undefined}
              >
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: color, opacity: on ? 1 : 0.5 }} />
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{fmtDate(selected.date)}</h2>
            <button onClick={() => setSelectedDate(null)} className="text-xs text-muted hover:text-ink2">Close ✕</button>
          </div>
          <div className="space-y-1.5">
            {selected.txns.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line/60 px-2.5 py-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: categoryColor(t.category, dark) }} />
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${t.type === "buy" ? "bg-accent/10 text-accent" : "bg-down/10 text-down"}`}>
                    {t.type}
                  </span>
                  <span className="font-medium">{nameFor(t.assetId, t.assetName)}</span>
                  <span className="text-xs text-muted">{t.symbol}</span>
                </span>
                <span className="tnum text-xs text-ink2">
                  {fmtNum(t.quantity)} × {fmtMoney(t.price, t.currency)} = <span className="font-semibold">{fmtEUR(t.amountEUR)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({
  options,
  value,
  onChange,
  title,
}: {
  options: { k: string; l: string }[];
  value: string;
  onChange: (v: string) => void;
  title?: string;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-line text-sm" title={title}>
      {options.map((o) => (
        <button
          key={o.k}
          onClick={() => onChange(o.k)}
          className={`px-2.5 py-1 ${value === o.k ? "bg-accent/15 font-semibold text-accent" : "bg-surface text-muted hover:text-ink2"}`}
        >
          {o.l}
        </button>
      ))}
    </span>
  );
}

function CapTip({
  active,
  payload,
  label,
  coordinate,
  pct,
  chromeC,
  series,
  txnDates,
  nameFor,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; dataKey?: string; payload?: Record<string, number> }[];
  label?: string;
  coordinate?: { x?: number; y?: number };
  pct: boolean;
  chromeC: ReturnType<typeof chrome>;
  series: CapSeries[];
  txnDates: CapitalData["txnDates"];
  nameFor: (id: number, full: string) => string;
}) {
  const yInverse = useYAxisInverseScale();
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const byKey = new Map(series.map((s) => [s.key, s]));
  const total = series.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0);
  // Which stack band is the cursor vertically inside? Bold that entry.
  let hotKey: string | null = null;
  if (coordinate?.y != null && yInverse) {
    const target = Number(yInverse(coordinate.y));
    let cum = 0;
    for (const s of series) {
      const v = Number(row[s.key]) || 0;
      const h = pct ? (total > 0 ? v / total : 0) : v;
      if (h > 0 && target >= cum && target <= cum + h) {
        hotKey = s.key;
        break;
      }
      cum += h;
    }
  }
  // Snap to the nearest transaction date within ±2 days of the hovered point.
  let nearTxn: CapitalData["txnDates"][number] | null = null;
  if (label) {
    const hovered = Date.parse(label);
    let bestDist = 2 * 86400000 + 1;
    for (const t of txnDates) {
      const dist = Math.abs(Date.parse(t.date) - hovered);
      if (dist < bestDist) {
        bestDist = dist;
        nearTxn = t;
      }
    }
  }
  return (
    <div
      // Phone width cap: the plot is narrower than a full tooltip there, so
      // recharts pins it to the plot's left edge and the right side would
      // stick out past the (clipped) chart container. 120px ≈ page padding +
      // y-axis gutter. Long names then truncate (inert when uncapped).
      className="rounded-md border px-2.5 py-2 text-xs shadow-sm max-sm:max-w-[calc(100vw-120px)]"
      style={{ background: chromeC.surface, borderColor: chromeC.grid, color: chromeC.ink }}
    >
      <div className="mb-1 font-medium">{label ? fmtDate(label) : ""} · {fmtEUR(total)}</div>
      {[...payload].reverse().map((p, i) => {
        const s = byKey.get(p.dataKey as string);
        const v = Number(row[p.dataKey as string]) || 0;
        if (!s || v === 0) return null;
        const hot = s.key === hotKey;
        return (
          <div key={i} className={`flex items-center justify-between gap-4 ${hot ? "font-semibold" : ""}`}>
            <span
              className="flex min-w-0 items-center gap-1.5"
              style={{ color: hot ? chromeC.ink : chromeC.inkSecondary }}
            >
              <span className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="tnum">{pct ? fmtPct(total > 0 ? v / total : 0, false) : fmtEUR(v)}</span>
          </div>
        );
      })}
      {nearTxn && (
        <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: chromeC.grid }}>
          <div className="mb-0.5" style={{ color: chromeC.muted }}>{fmtDate(nearTxn.date)}</div>
          {nearTxn.txns.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5" style={{ color: chromeC.inkSecondary }}>
                <span className="font-semibold uppercase" style={{ color: chromeC.ink }}>{t.type}</span>
                <span className="truncate">{nameFor(t.assetId, t.assetName)}</span>
              </span>
              <span className="tnum">{fmtEUR(t.amountEUR)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
