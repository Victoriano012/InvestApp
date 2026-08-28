"use client";

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useYAxisInverseScale,
} from "recharts";
import { useDark, useJson } from "./hooks";
import RangeControl, { rangeWindow, useDragZoom, type RangeSel } from "./RangeControl";
import { axisDateFmt, daysBetween, fmtDate, fmtEUR, fmtMoney, fmtPct, todayISO } from "@/lib/format";
import { categoryColor, chrome, dashFor } from "@/lib/palette";
import { CATEGORIES, type Category, type ExplorerData } from "@/lib/types";

type Metric = "value" | "gain_abs" | "gain_pct";
type Grouping = "category" | "asset";

const METRICS: { key: Metric; label: string; pct: boolean; title: string }[] = [
  { key: "gain_abs", label: "Gain €", pct: false, title: "Profit/loss in € vs what you paid (incl. realized)" },
  { key: "gain_pct", label: "Gain %", pct: true, title: "Profit in % of all cash paid into buys (including fees and realized gains)" },
  { key: "value", label: "Value €", pct: false, title: "Value of your holding (quantity × price)" },
];

interface SeriesDef {
  key: string;
  label: string;
  color: string;
  dash?: string;
  assetId: number;
}

export default function ChartExplorer() {
  const { data, error } = useJson<ExplorerData>("/api/series");
  const dark = useDark();
  const C = chrome(dark);
  const params = useSearchParams();

  const [selected, setSelected] = useState<number[] | null>(null);
  const [metric, setMetric] = useState<Metric>("gain_pct");
  const [rangeSel, setRangeSel] = useState<RangeSel>({ preset: "all", from: "", to: "" });
  // Last range set explicitly (presets/calendar) — what a double-click
  // returns to, so consecutive drag zooms don't overwrite it.
  const manualSel = useRef<RangeSel>({ preset: "all", from: "", to: "" });
  const [perLot, setPerLot] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>("asset");
  // Group picks live apart from the asset picks so toggling Groups/Assets
  // never loses either selection. null = all groups.
  const [catSel, setCatSel] = useState<Category[] | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // W&B-style zoom: press on a date, drag, release on another — that span
  // becomes the range. Double-click returns to the range picked at the top.
  const zoom = useDragZoom({
    onZoom: (from, to) => setRangeSel({ preset: "custom", from, to }),
    onReset: () => setRangeSel(manualSel.current),
  });

  const assets = useMemo(() => data?.assets ?? [], [data]);
  const held = useMemo(() => assets.filter((a) => a.txns.length > 0).map((a) => a.id), [assets]);

  const sel = useMemo(() => {
    if (selected) return selected;
    const fromUrl = params.get("assets");
    if (fromUrl) {
      const ids = fromUrl.split(",").map(Number).filter((n) => assets.some((a) => a.id === n));
      if (ids.length) return ids;
    }
    return held.length ? held : assets.map((a) => a.id);
  }, [selected, params, assets, held]);

  const presentCats = useMemo(
    () => CATEGORIES.filter((c) => assets.some((a) => a.category === c.key && a.txns.length > 0)),
    [assets]
  );
  const catOn = (k: Category) => !catSel || catSel.includes(k);
  // Ids actually plotted: the asset picks, or every asset of the picked groups.
  const effSel = useMemo(
    () =>
      grouping === "category"
        ? assets.filter((a) => !catSel || catSel.includes(a.category)).map((a) => a.id)
        : sel,
    [grouping, catSel, assets, sel]
  );

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const lotCapable = metric === "gain_abs" || metric === "gain_pct";
  // Per-buy lines are meaningless for groups — ignored there, preference kept.
  const usePerLot = perLot && lotCapable && grouping === "asset";

  const win = rangeWindow(rangeSel, todayISO());
  // "All" spans the selected assets' history, not the whole dataset's.
  let winFrom = win.from;
  if (rangeSel.preset === "all") {
    let first: string | null = null;
    for (const a of assets) {
      if (!effSel.includes(a.id)) continue;
      for (const t of a.txns) if (first == null || t.date < first) first = t.date;
    }
    if (first) winFrom = first;
  }

  const model = useMemo(() => {
    if (!data) return null;
    return buildModel(data, {
      sel: effSel,
      metric,
      from: winFrom,
      to: win.to,
      usePerLot,
      groups: grouping === "category",
      dark,
    });
  }, [data, effSel, metric, winFrom, win.to, usePerLot, grouping, dark]);

  // Calendar marks always use the short name — the popover is tight on space.
  const txnMarks = useMemo(
    () =>
      assets.flatMap((a) =>
        a.txns.map((t) => ({ date: t.date, label: `${t.type === "buy" ? "Buy" : "Sell"} ${a.short_name || a.name}` }))
      ),
    [assets]
  );

  // Selected assets' transactions by date, for the tooltip's "near a trade" section.
  const txnInfo = useMemo(() => {
    const m = new Map<string, { id: number; type: "buy" | "sell"; name: string; amount: string }[]>();
    for (const a of assets) {
      if (!effSel.includes(a.id)) continue;
      for (const t of a.txns) {
        const arr = m.get(t.date) ?? [];
        arr.push({ id: t.id, type: t.type, name: a.short_name || a.name, amount: fmtMoney(t.quantity * t.price, a.currency) });
        m.set(t.date, arr);
      }
    }
    return m;
  }, [assets, effSel]);

  if (error) return <p className="p-6 text-sm text-down">Failed to load chart data: {error}</p>;
  if (!data || !model) return <p className="p-6 text-sm text-muted">Loading charts…</p>;

  const { rows, series, trades } = model;
  // Lets an in-flight drag-zoom keep following the mouse outside the plot.
  zoom.setDates(rows.map((r) => r.date as string));
  const tickFmt = axisDateFmt(
    rows.length > 1 ? daysBetween(rows[0].date as string, rows[rows.length - 1].date as string) : 0,
    rows.length
  );
  const isPct = metricDef.pct;
  const fmtY = (v: number) => (isPct ? fmtPct(v, false, Math.abs(v) < 0.001 ? 2 : 1) : fmtEUR(v, true));

  const toggleAsset = (id: number) =>
    setSelected(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  const toggleCat = (k: Category) => {
    const cur = new Set(catSel ?? presentCats.map((c) => c.key));
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
    setCatSel(cur.size === presentCats.length ? null : [...cur]);
  };

  const setManual = (s: RangeSel) => {
    manualSel.current = s;
    setRangeSel(s);
  };

  return (
    <div className="space-y-4">
      {/* Options row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Seg options={METRICS.map((m) => ({ k: m.key, l: m.label, t: m.title }))} value={metric} onChange={(v) => setMetric(v as Metric)} />
        <Toggle
          options={[{ k: "category", l: "Groups" }, { k: "asset", l: "Assets" }]}
          value={grouping}
          onChange={(v) => setGrouping(v as Grouping)}
          title="One line per category or per individual asset"
        />
        <RangeControl
          sel={rangeSel}
          onChange={setManual}
          txns={txnMarks}
          min={data.dates[0]}
          max={data.dates[data.dates.length - 1]}
          windowFrom={winFrom}
        />
        {lotCapable && grouping === "asset" && (
          <Check label="One line per buy" checked={perLot} onChange={setPerLot} title="Split each asset into one line per purchase, measured from that purchase" />
        )}
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-line bg-surface p-2 md:p-3">
        {series.length === 0 ? (
          <div className="flex h-[340px] w-full items-center justify-center md:h-[440px]">
            <p className="p-10 text-center text-sm text-muted">
              {effSel.length === 0
                ? grouping === "category"
                  ? "Select at least one group."
                  : "Select at least one asset."
                : "No data for this combination — assets without transactions have no value/gain series."}
            </p>
          </div>
        ) : (
          <div
            ref={zoom.containerRef}
            className="h-[340px] w-full select-none md:h-[440px]"
            title="Drag to zoom — double-click to reset to the range picked above"
            onMouseLeave={() => setHoverKey(null)}
          >
            <ResponsiveContainer>
              <LineChart
                data={rows}
                accessibilityLayer={false} // keeps the svg unfocusable — no focus rectangle on click
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
                  width={58}
                  tickFormatter={(v: number) => fmtY(v)}
                />
                {isPct && <ReferenceLine y={0} stroke={C.axis} strokeWidth={1} />}
                <Tooltip
                  content={<ChartTip fmtY={fmtY} chromeC={C} txns={txnInfo} />}
                  cursor={{ stroke: C.muted, strokeWidth: 1, strokeDasharray: "3 3" }}
                  isAnimationActive={false}
                />
                {series.map((s) => (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={hoverKey === s.key ? 3.5 : 2}
                    strokeOpacity={hoverKey && hoverKey !== s.key ? 0.45 : 1}
                    strokeDasharray={s.dash}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: C.surface }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {/* Invisible wide strokes on top: hovering near a line bolds it. */}
                {series.map((s) => (
                  <Line
                    key={`hit-${s.key}`}
                    dataKey={s.key}
                    stroke="transparent"
                    strokeWidth={13}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    legendType="none"
                    tooltipType="none"
                    onMouseMove={() => setHoverKey(s.key)}
                    onMouseLeave={() => setHoverKey(null)}
                  />
                ))}
                {trades.map((t) =>
                    t.y != null ? (
                      <ReferenceDot
                        key={`x${t.txnId}-${t.seriesKey}`}
                        x={t.date}
                        y={t.y}
                        // Every mark sits on a plotted point inside the window, so the
                        // default ifOverflow="discard" can only ever misfire — and it does:
                        // d3 scalePoint's align rounding puts the first category a hair
                        // below range[0] (61.999…94 vs 62), so the ✕ of a txn on the
                        // window's first day (the first-ever buy under "All") was dropped.
                        ifOverflow="visible"
                        shape={(props) => <XMark {...props} color={t.type === "buy" ? C.ink : C.down} />}
                      />
                    ) : null
                  )}
                {zoom.drag && (
                  <ReferenceArea
                    x1={zoom.drag.from}
                    x2={zoom.drag.to}
                    fill={C.muted}
                    fillOpacity={0.15}
                    stroke={C.axis}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

      </div>

      {/* Picker — doubles as the legend. Groups mode: category chips (as in Capital). */}
      {grouping === "category" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            onClick={() => setCatSel(null)}
            className={`rounded-md border border-line px-2 py-1 ${catSel ? "bg-surface text-muted hover:text-ink2" : "text-ink2"}`}
          >
            All
          </button>
          <button
            onClick={() => setCatSel([])}
            className={`rounded-md border border-line px-2 py-1 ${catSel?.length === 0 ? "text-ink2" : "bg-surface text-muted hover:text-ink2"}`}
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
      ) : (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          <button className="rounded-md border border-line bg-surface px-2 py-1 hover:text-ink2" onClick={() => setSelected(assets.map((a) => a.id))}>All</button>
          <button className="rounded-md border border-line bg-surface px-2 py-1 hover:text-ink2" onClick={() => setSelected([])}>None</button>
        </span>
        {CATEGORIES.map((cat) => {
            const inCat = assets.filter((a) => a.category === cat.key);
            if (!inCat.length) return null;
            const ids = inCat.map((a) => a.id);
            const allOn = ids.every((id) => sel.includes(id));
            const color = categoryColor(cat.key, dark);
            return (
              <span key={cat.key} className="flex flex-wrap items-center gap-1.5">
                {inCat.length > 1 && (
                  <button
                    onClick={() =>
                      setSelected(allOn ? sel.filter((x) => !ids.includes(x)) : [...new Set([...sel, ...ids])])
                    }
                    className={`rounded-md border border-line px-2 py-1 text-xs ${allOn ? "font-semibold" : "bg-surface text-muted"}`}
                    style={allOn ? { color } : undefined}
                    title={allOn ? `Deselect all ${cat.label}` : `Select all ${cat.label}`}
                  >
                    {cat.label}
                  </button>
                )}
                {inCat.map((a) => {
                  const on = sel.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      onClick={() => toggleAsset(a.id)}
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                        on ? "border-transparent font-medium" : "border-line bg-surface text-muted"
                      }`}
                      style={on ? { background: color + (dark ? "2e" : "1f"), color } : undefined}
                    >
                      <svg width="18" height="8" aria-hidden>
                        <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashFor(a.dashIndex)} opacity={on ? 1 : 0.5} />
                      </svg>
                      {a.short_name || a.name}
                    </button>
                  );
                })}
              </span>
            );
          })}
      </div>
      )}
    </div>
  );
}

// ---------- controls ----------

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

function Seg({
  options,
  value,
  onChange,
}: {
  options: { k: string; l: string; t?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="inline-flex overflow-hidden rounded-md border border-line">
        {options.map((o) => (
          <button
            key={o.k}
            title={o.t}
            onClick={() => onChange(o.k)}
            className={`px-2.5 py-1 ${value === o.k ? "bg-accent/15 font-semibold text-accent" : "bg-surface text-muted hover:text-ink2"}`}
          >
            {o.l}
          </button>
        ))}
      </span>
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--accent)]" />
      <span className={checked ? "text-ink2" : "text-muted"}>{label}</span>
    </label>
  );
}

function XMark(props: { cx?: number; cy?: number; color: string }) {
  const { cx, cy, color } = props;
  if (cx == null || cy == null) return <g />;
  const r = 3.5;
  return (
    <g>
      <line x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </g>
  );
}

function ChartTip({
  active,
  payload,
  label,
  coordinate,
  fmtY,
  chromeC,
  txns,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  coordinate?: { x?: number; y?: number };
  fmtY: (v: number) => string;
  chromeC: ReturnType<typeof chrome>;
  txns: Map<string, { id: number; type: "buy" | "sell"; name: string; amount: string }[]>;
}) {
  const yInverse = useYAxisInverseScale();
  if (!active || !payload?.length) return null;
  // Transparent strokes are the hover-hit helpers, not real series.
  const items = [...payload]
    .filter((p) => p.value != null && p.color !== "transparent")
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  // Which line is the cursor vertically nearest? Bold that entry (as in CapTip).
  let hotName: string | null = null;
  if (coordinate?.y != null && yInverse) {
    const target = Number(yInverse(coordinate.y));
    let bestDist = Infinity;
    for (const p of items) {
      const dist = Math.abs((p.value ?? 0) - target);
      if (dist < bestDist) {
        bestDist = dist;
        hotName = p.name ?? null;
      }
    }
  }
  // Snap to the nearest transaction date within ±2 days of the hovered point.
  let nearDate: string | null = null;
  if (label) {
    const hovered = Date.parse(label);
    let bestDist = 2 * 86400000 + 1;
    for (const d of txns.keys()) {
      const dist = Math.abs(Date.parse(d) - hovered);
      if (dist < bestDist) {
        bestDist = dist;
        nearDate = d;
      }
    }
  }
  return (
    <div
      className="rounded-md border px-2.5 py-2 text-xs shadow-sm"
      style={{ background: chromeC.surface, borderColor: chromeC.grid, color: chromeC.ink }}
    >
      <div className="mb-1 font-medium">{label ? fmtDate(label) : ""}</div>
      {items.slice(0, 12).map((p, i) => {
        const hot = hotName != null && p.name === hotName;
        return (
          <div key={i} className={`flex items-center justify-between gap-4 ${hot ? "font-semibold" : ""}`}>
            <span
              className="flex items-center gap-1.5"
              style={{ color: hot ? chromeC.ink : chromeC.inkSecondary }}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="tnum">{fmtY(p.value!)}</span>
          </div>
        );
      })}
      {nearDate && (
        <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: chromeC.grid }}>
          <div className="mb-0.5" style={{ color: chromeC.muted }}>{fmtDate(nearDate)}</div>
          {txns.get(nearDate)!.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: chromeC.inkSecondary }}>
                <span className="font-semibold uppercase" style={{ color: chromeC.ink }}>{t.type}</span>
                {t.name}
              </span>
              <span className="tnum">{t.amount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- data transforms ----------

interface ModelOpts {
  sel: number[];
  metric: Metric;
  from: string;
  to: string;
  usePerLot: boolean;
  groups: boolean; // one line per category instead of per asset
  dark: boolean;
}

interface TradeMark {
  txnId: number;
  date: string;
  type: "buy" | "sell";
  seriesKey: string;
  y: number | null;
}

function buildModel(data: ExplorerData, o: ModelOpts) {
  let i0 = data.dates.findIndex((d) => d >= o.from);
  if (i0 < 0) i0 = 0;
  let i1 = data.dates.length - 1;
  while (i1 > i0 && data.dates[i1] > o.to) i1--;
  const dates = data.dates.slice(i0, i1 + 1);

  const chosen = data.assets.filter((a) => o.sel.includes(a.id));
  const series: SeriesDef[] = [];
  const raw: (number | null)[][] = [];

  // One aggregate line from a set of €-series — an asset's own arrays, or a
  // group's per-date member sums. Identical math either way.
  interface AggSrc {
    valueEUR: (number | null)[];
    costEUR: (number | null)[];
    contributedEUR: number[];
    realizedEUR: (number | null)[];
    firstTxn: string | null;
  }
  const metricVals = (src: AggSrc): (number | null)[] => {
    if (o.metric === "value") return dates.map((_, i) => src.valueEUR[i0 + i]);
    const gainAt = (j: number): number | null => {
      const v = src.valueEUR[j];
      const c = src.costEUR[j];
      return v != null && c != null ? v - c + (src.realizedEUR[j] ?? 0) : null;
    };
    if (o.metric === "gain_abs") {
      // No line before the first transaction — a flat 0 there is noise.
      // Count gains from the window start: rebase by what was accumulated before it.
      let base = 0;
      for (let j = i0 - 1; j >= 0; j--) {
        if (src.firstTxn == null || data.dates[j] < src.firstTxn) break;
        const g = gainAt(j);
        if (g != null) { base = g; break; }
      }
      return dates.map((d, i) => {
        if (src.firstTxn == null || d < src.firstTxn) return null;
        const g = gainAt(i0 + i);
        return g != null ? g - base : null;
      });
    }
    // Window rebase in EUR: gain earned inside the range, as a percentage of
    // all cash paid into buys. Sells never shrink this denominator, and a buy
    // whose date is visible includes its fee drag instead of starting at zero.
    let baseEUR = 0;
    for (let j = i0 - 1; j >= 0; j--) {
      const g = gainAt(j);
      if (g != null) { baseEUR = g; break; }
    }
    return dates.map((_, i) => {
      const j = i0 + i;
      const g = gainAt(j);
      const contributed = src.contributedEUR[j];
      return g != null && contributed > 0 ? (g - baseEUR) / contributed : null;
    });
  };
  const firstTxnOf = (txns: { date: string }[]) =>
    txns.reduce<string | null>((m, t) => (m == null || t.date < m ? t.date : m), null);

  if (o.groups) {
    // Solid line per category, in the category color (dashes are for assets
    // *within* a category); members summed per date before the shared rebase.
    for (const c of CATEGORIES) {
      const members = chosen.filter((a) => a.category === c.key && a.txns.length > 0);
      if (members.length === 0) continue;
      const sum = (pick: (m: (typeof members)[number]) => (number | null)[]) =>
        data.dates.map((_, j) => {
          let s = 0;
          let any = false;
          for (const m of members) {
            const v = pick(m)[j];
            if (v != null) {
              s += v;
              any = true;
            }
          }
          return any ? s : null;
        });
      series.push({ key: `g${c.key}`, label: c.label, color: categoryColor(c.key, o.dark), assetId: -1 });
      raw.push(
        metricVals({
          valueEUR: sum((m) => m.valueEUR),
          costEUR: sum((m) => m.costEUR),
          contributedEUR: sum((m) => m.contributedEUR).map((v) => v ?? 0),
          realizedEUR: sum((m) => m.realizedEUR),
          firstTxn: firstTxnOf(members.flatMap((m) => m.txns)),
        })
      );
    }
  } else for (const a of chosen) {
    const color = categoryColor(a.category, o.dark);
    if (o.usePerLot) {
      a.lots.forEach((lot) => {
        const lotVal = (j: number): number | null => {
          if (data.dates[j] < lot.date) return null;
          // Baskets ship the lot's exact per-unit value series; singles use the price.
          const p = lot.unitValueEUR ? lot.unitValueEUR[j] : a.priceEUR[j];
          if (p == null) return null;
          if (o.metric === "gain_abs") return (p - lot.priceEUR) * lot.quantity;
          return p / lot.priceEUR - 1; // gain_pct per lot
        };
        // Gains count from the window start, not from the buy.
        let base = 0;
        for (let j = i0 - 1; j >= 0; j--) {
          const v = lotVal(j);
          if (v != null) { base = v; break; }
        }
        const vals = dates.map((_, i) => {
          const v = lotVal(i0 + i);
          return v != null ? v - base : null;
        });
        series.push({
          key: `a${a.id}l${lot.txnId}`,
          label: `${a.short_name || a.name} · buy ${fmtDate(lot.date)}`,
          color,
          // All lots of an asset share its exact line style — the lines of one
          // asset never cross, so the buy date in the tooltip disambiguates.
          dash: dashFor(a.dashIndex),
          assetId: a.id,
        });
        raw.push(vals);
      });
      continue;
    }

    // Value/gain series are meaningless for assets never transacted.
    if (a.txns.length === 0) continue;
    series.push({ key: `a${a.id}`, label: a.short_name || a.name, color, dash: dashFor(a.dashIndex), assetId: a.id });
    raw.push(
      metricVals({
        valueEUR: a.valueEUR,
        costEUR: a.costEUR,
        contributedEUR: a.contributedEUR,
        realizedEUR: a.realizedEUR,
        firstTxn: firstTxnOf(a.txns),
      })
    );
  }

  let rows: Record<string, string | number | null>[] = dates.map((d, i) => {
    const r: Record<string, string | number | null> = { date: d };
    series.forEach((s, si) => (r[s.key] = raw[si][i]));
    return r;
  });
  let outDates = dates;

  // Downsample very long windows, always keeping trade dates & endpoints.
  if (rows.length > 700) {
    const keep = new Set<string>();
    for (const a of chosen) for (const t of a.txns) keep.add(t.date);
    const stride = Math.ceil(rows.length / 700);
    rows = rows.filter((r, i) => i % stride === 0 || i === rows.length - 1 || keep.has(r.date as string));
    outDates = rows.map((r) => r.date as string);
  }

  // Trade markers with the y value of their series at that date. One ✕ per
  // transaction: in per-lot mode a buy marks only the line it created, and a
  // sell marks the lot it FIFO-consumed first (reconstructed from quantities);
  // in aggregate mode the asset has a single line anyway.
  const trades: TradeMark[] = [];
  const rowByDate = new Map(rows.map((r) => [r.date as string, r]));
  const seriesKeys = new Set(series.map((s) => s.key));
  for (const a of chosen) {
    const assetKeys = series.filter((s) => s.assetId === a.id).map((s) => s.key);
    let sellLot: Map<number, number> | null = null; // sell txnId → buy txnId of the first lot it consumed
    if (o.usePerLot) {
      sellLot = new Map();
      const rem = [...a.lots]
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.txnId - y.txnId))
        .map((l) => ({ txnId: l.txnId, date: l.date, left: l.quantity }));
      const sells = a.txns
        .filter((t) => t.type === "sell")
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id));
      for (const sTxn of sells) {
        let qty = sTxn.quantity;
        for (const l of rem) {
          if (l.left <= 0 || l.date > sTxn.date) continue;
          if (!sellLot.has(sTxn.id)) sellLot.set(sTxn.id, l.txnId);
          const take = Math.min(l.left, qty);
          l.left -= take;
          qty -= take;
          if (qty <= 0) break;
        }
      }
    }
    for (const t of a.txns) {
      if (t.date < (outDates[0] ?? "9999")) continue;
      let keys: string[];
      if (o.groups) {
        // The ✕ sits on the asset's group line.
        const gk = `g${a.category}`;
        keys = seriesKeys.has(gk) ? [gk] : [];
      } else if (!o.usePerLot) {
        keys = assetKeys;
      } else if (t.type === "buy") {
        keys = [`a${a.id}l${t.id}`];
      } else {
        const lotId = sellLot!.get(t.id);
        const k = lotId != null ? `a${a.id}l${lotId}` : assetKeys[0];
        keys = k ? [k] : [];
      }
      for (const k of keys) {
        const row = rowByDate.get(t.date);
        const y = row ? (row[k] as number | null) : null;
        if (y != null) trades.push({ txnId: t.id, date: t.date, type: t.type, seriesKey: k, y });
      }
    }
  }

  return { rows, series, trades };
}
