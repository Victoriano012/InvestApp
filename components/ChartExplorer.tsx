"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDark, useJson } from "./hooks";
import { addDays, fmtDate, fmtDateShort, fmtEUR, fmtPct, todayISO } from "@/lib/format";
import { categoryColor, chrome, dashFor } from "@/lib/palette";
import { CATEGORIES, type ExplorerAsset, type ExplorerData } from "@/lib/types";

type Metric = "price_pct" | "price" | "value" | "gain_abs" | "gain_pct";
type Range = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";
type Interval = "day" | "week" | "month";
type Markers = "x" | "lines" | "none";

const METRICS: { key: Metric; label: string; pct: boolean; title: string }[] = [
  { key: "price_pct", label: "Price %", pct: true, title: "Price change in % (pick the baseline with 'Rebase')" },
  { key: "price", label: "Price", pct: false, title: "Raw price" },
  { key: "value", label: "Value €", pct: false, title: "Value of your holding (quantity × price)" },
  { key: "gain_abs", label: "Gain €", pct: false, title: "Profit/loss in € vs what you paid (incl. realized)" },
  { key: "gain_pct", label: "Gain %", pct: true, title: "Unrealized profit in % of cost basis" },
];

const RANGES: { key: Range; label: string }[] = [
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "All" },
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
  const [metric, setMetric] = useState<Metric>("price_pct");
  const [range, setRange] = useState<Range>("1y");
  const [cumulative, setCumulative] = useState(true);
  const [interval, setInterval] = useState<Interval>("month");
  const [perLot, setPerLot] = useState(false);
  const [markers, setMarkers] = useState<Markers>("x");
  const [rebase, setRebase] = useState<"range" | "firstbuy">("range");
  const [nativeCcy, setNativeCcy] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [showTable, setShowTable] = useState(false);

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

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const lotCapable = metric === "price_pct" || metric === "gain_abs" || metric === "gain_pct";
  const usePerLot = perLot && lotCapable;
  const priceMetric = metric === "price" || metric === "price_pct";
  const logCapable = (metric === "price" || metric === "value") && cumulative;

  const model = useMemo(() => {
    if (!data) return null;
    return buildModel(data, {
      sel,
      metric,
      range,
      cumulative,
      interval,
      usePerLot,
      rebase,
      nativeCcy,
      dark,
    });
  }, [data, sel, metric, range, cumulative, interval, usePerLot, rebase, nativeCcy, dark]);

  if (error) return <p className="p-6 text-sm text-down">Failed to load chart data: {error}</p>;
  if (!data || !model) return <p className="p-6 text-sm text-muted">Loading charts…</p>;

  const { rows, series, trades } = model;
  const isPct = metricDef.pct || (usePerLot && metric === "price_pct");
  const fmtY = (v: number) => (isPct ? fmtPct(v, false, Math.abs(v) < 0.001 ? 2 : 1) : fmtEUR(v, true));
  const logOk = logCapable && logScale && rows.every((r) => series.every((s) => r[s.key] == null || (r[s.key] as number) > 0));

  const toggleAsset = (id: number) =>
    setSelected(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Charts</h1>

      {/* Asset picker */}
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          <span className="font-medium uppercase tracking-wide">Assets</span>
          <button className="rounded border border-line px-1.5 py-0.5" onClick={() => setSelected(assets.map((a) => a.id))}>All</button>
          <button className="rounded border border-line px-1.5 py-0.5" onClick={() => setSelected(held.length ? held : [])}>Held</button>
          <button className="rounded border border-line px-1.5 py-0.5" onClick={() => setSelected([])}>None</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((cat) => {
            const inCat = assets.filter((a) => a.category === cat.key);
            if (!inCat.length) return null;
            return inCat.map((a) => {
              const on = sel.includes(a.id);
              const color = categoryColor(a.category, dark);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAsset(a.id)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                    on ? "border-transparent font-medium" : "border-line text-muted"
                  }`}
                  style={on ? { background: color + (dark ? "2e" : "1f"), color } : undefined}
                >
                  <svg width="18" height="8" aria-hidden>
                    <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashFor(a.dashIndex)} opacity={on ? 1 : 0.5} />
                  </svg>
                  {a.name}
                </button>
              );
            });
          })}
        </div>
      </div>

      {/* Options row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Seg label="Metric" options={METRICS.map((m) => ({ k: m.key, l: m.label, t: m.title }))} value={metric} onChange={(v) => setMetric(v as Metric)} />
        <Seg label="Range" options={RANGES.map((r) => ({ k: r.key, l: r.label }))} value={range} onChange={(v) => setRange(v as Range)} />
        <Seg
          label="Wins"
          options={[{ k: "cum", l: "Accumulated" }, { k: "per", l: "Per period" }]}
          value={cumulative ? "cum" : "per"}
          onChange={(v) => setCumulative(v === "cum")}
        />
        {!cumulative && (
          <Seg label="Period" options={[{ k: "day", l: "D" }, { k: "week", l: "W" }, { k: "month", l: "M" }]} value={interval} onChange={(v) => setInterval(v as Interval)} />
        )}
        {cumulative && (
          <Seg
            label="Trades"
            options={[{ k: "x", l: "✕ marks" }, { k: "lines", l: "Lines" }, { k: "none", l: "Off" }]}
            value={markers}
            onChange={(v) => setMarkers(v as Markers)}
          />
        )}
        {lotCapable && (
          <Check label="One line per buy" checked={perLot} onChange={setPerLot} title="Split each asset into one line per purchase, measured from that purchase" />
        )}
        {metric === "price_pct" && !usePerLot && (
          <Seg label="Rebase" options={[{ k: "range", l: "Range start" }, { k: "firstbuy", l: "First buy" }]} value={rebase} onChange={(v) => setRebase(v as "range" | "firstbuy")} />
        )}
        {priceMetric && (
          <Check label="Native currency" checked={nativeCcy} onChange={setNativeCcy} title="Show prices in each asset's own currency instead of EUR" />
        )}
        {logCapable && <Check label="Log scale" checked={logScale} onChange={setLogScale} />}
        <Check label="Table" checked={showTable} onChange={setShowTable} />
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-line bg-surface p-2 md:p-3">
        {series.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">
            {sel.length === 0 ? "Select at least one asset." : "No data for this combination — assets without transactions have no value/gain series."}
          </p>
        ) : (
          <div className="h-[340px] w-full md:h-[440px]">
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid stroke={C.grid} strokeWidth={1} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: C.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: C.axis }}
                  tickFormatter={(d: string) => fmtDateShort(d)}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: C.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  scale={logOk ? "log" : "auto"}
                  domain={logOk ? ["auto", "auto"] : undefined}
                  tickFormatter={(v: number) => fmtY(v)}
                />
                {isPct && cumulative && <ReferenceLine y={0} stroke={C.axis} strokeWidth={1} />}
                <Tooltip
                  content={<ChartTip fmtY={fmtY} chromeC={C} />}
                  cursor={{ stroke: C.muted, strokeWidth: 1, strokeDasharray: "3 3" }}
                />
                {cumulative && markers === "lines" &&
                  trades.map((t) => (
                    <ReferenceLine key={`vl${t.txnId}`} x={t.date} stroke={C.ink} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
                  ))}
                {series.map((s) => (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    strokeDasharray={s.dash}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: C.surface }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {cumulative && markers === "x" &&
                  trades.map((t) =>
                    t.y != null ? (
                      <ReferenceDot
                        key={`x${t.txnId}-${t.seriesKey}`}
                        x={t.date}
                        y={t.y}
                        shape={(props) => <XMark {...props} color={t.type === "buy" ? C.ink : C.down} />}
                      />
                    ) : null
                  )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Legend */}
        {series.length >= 1 && (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-2 pb-1 text-xs text-ink2">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <svg width="20" height="8" aria-hidden>
                  <line x1="1" y1="4" x2="19" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
                </svg>
                {s.label}
              </span>
            ))}
            {cumulative && markers === "x" && trades.length > 0 && (
              <span className="flex items-center gap-1.5 text-muted">
                <span style={{ color: C.ink }}>✕</span> buy · <span style={{ color: C.down }}>✕</span> sell
              </span>
            )}
          </div>
        )}
      </div>

      {showTable && series.length > 0 && (
        <div className="max-h-80 overflow-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-muted">
                <th className="px-2 py-1.5 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-2 py-1.5 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.date as string} className="border-b border-line/40 last:border-0">
                  <td className="px-2 py-1">{fmtDate(r.date as string)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="tnum px-2 py-1 text-right">
                      {r[s.key] != null ? fmtY(r[s.key] as number) : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- controls ----------

function Seg({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { k: string; l: string; t?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <span className="inline-flex overflow-hidden rounded-md border border-line">
        {options.map((o) => (
          <button
            key={o.k}
            title={o.t}
            onClick={() => onChange(o.k)}
            className={`px-2 py-1 ${value === o.k ? "bg-accent/15 font-semibold text-accent" : "text-muted hover:text-ink2"}`}
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
  const r = 5;
  return (
    <g>
      <line x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <line x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

function ChartTip({
  active,
  payload,
  label,
  fmtY,
  chromeC,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  fmtY: (v: number) => string;
  chromeC: ReturnType<typeof chrome>;
}) {
  if (!active || !payload?.length) return null;
  const items = [...payload].filter((p) => p.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div
      className="rounded-md border px-2.5 py-2 text-xs shadow-sm"
      style={{ background: chromeC.surface, borderColor: chromeC.grid, color: chromeC.ink }}
    >
      <div className="mb-1 font-medium">{label ? fmtDate(label) : ""}</div>
      {items.slice(0, 12).map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5" style={{ color: chromeC.inkSecondary }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="tnum">{fmtY(p.value!)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- data transforms ----------

interface ModelOpts {
  sel: number[];
  metric: Metric;
  range: Range;
  cumulative: boolean;
  interval: Interval;
  usePerLot: boolean;
  rebase: "range" | "firstbuy";
  nativeCcy: boolean;
  dark: boolean;
}

interface TradeMark {
  txnId: number;
  date: string;
  type: "buy" | "sell";
  seriesKey: string;
  y: number | null;
}

function rangeStart(range: Range, today: string): string {
  switch (range) {
    case "1m": return addDays(today, -31);
    case "3m": return addDays(today, -92);
    case "6m": return addDays(today, -183);
    case "1y": return addDays(today, -366);
    case "ytd": return today.slice(0, 4) + "-01-01";
    case "all": return "0000-00-00";
  }
}

function binKey(date: string, interval: Interval): string {
  if (interval === "day") return date;
  if (interval === "month") return date.slice(0, 7);
  // ISO week
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function buildModel(data: ExplorerData, o: ModelOpts) {
  const today = todayISO();
  const from = rangeStart(o.range, today);
  let i0 = data.dates.findIndex((d) => d >= from);
  if (i0 < 0) i0 = 0;
  const dates = data.dates.slice(i0);

  const chosen = data.assets.filter((a) => o.sel.includes(a.id));
  const series: SeriesDef[] = [];
  const raw: (number | null)[][] = [];

  const priceOf = (a: ExplorerAsset) => (o.nativeCcy && (o.metric === "price" || o.metric === "price_pct") ? a.priceNative : a.priceEUR);

  for (const a of chosen) {
    const color = categoryColor(a.category, o.dark);
    if (o.usePerLot) {
      a.lots.forEach((lot, li) => {
        const vals = dates.map((d, i) => {
          if (d < lot.date) return null;
          const p = a.priceEUR[i0 + i];
          if (p == null) return null;
          if (o.metric === "gain_abs") return (p - lot.priceEUR) * lot.quantity;
          return p / lot.priceEUR - 1; // price_pct & gain_pct per lot are the same thing
        });
        series.push({
          key: `a${a.id}l${lot.txnId}`,
          label: `${a.name} · buy ${fmtDate(lot.date)}`,
          color,
          dash: dashFor(li) ?? dashFor(a.dashIndex),
          assetId: a.id,
        });
        raw.push(vals);
      });
      continue;
    }

    let vals: (number | null)[];
    if (o.metric === "price") {
      const p = priceOf(a);
      vals = dates.map((_, i) => p[i0 + i]);
    } else if (o.metric === "price_pct") {
      const p = priceOf(a);
      let baseIdx = i0;
      if (o.rebase === "firstbuy" && a.lots.length) {
        const fb = data.dates.indexOf(a.lots[0].date);
        if (fb >= 0) baseIdx = fb;
      }
      let base: number | null = null;
      for (let j = baseIdx; j < data.dates.length; j++) {
        if (p[j] != null) { base = p[j]; break; }
      }
      vals = dates.map((_, i) => {
        const v = p[i0 + i];
        return v != null && base ? v / base - 1 : null;
      });
    } else if (o.metric === "value") {
      vals = dates.map((_, i) => a.valueEUR[i0 + i]);
    } else if (o.metric === "gain_abs") {
      vals = dates.map((_, i) => {
        const v = a.valueEUR[i0 + i];
        const c = a.costEUR[i0 + i];
        const r = a.realizedEUR[i0 + i];
        return v != null && c != null ? v - c + (r ?? 0) : null;
      });
    } else {
      vals = dates.map((_, i) => {
        const v = a.valueEUR[i0 + i];
        const c = a.costEUR[i0 + i];
        return v != null && c != null && c > 0 ? (v - c) / c : null;
      });
    }
    // Value/gain series are meaningless for assets never transacted.
    if ((o.metric === "value" || o.metric === "gain_abs" || o.metric === "gain_pct") && a.txns.length === 0) continue;
    series.push({ key: `a${a.id}`, label: a.name, color, dash: dashFor(a.dashIndex), assetId: a.id });
    raw.push(vals);
  }

  let rows: Record<string, string | number | null>[];
  let outDates = dates;

  if (o.cumulative) {
    rows = dates.map((d, i) => {
      const r: Record<string, string | number | null> = { date: d };
      series.forEach((s, si) => (r[s.key] = raw[si][i]));
      return r;
    });
  } else {
    // Per-period change: one point per bin, at the bin's last date.
    const bins: { key: string; endIdx: number; startIdx: number }[] = [];
    let cur = "";
    for (let i = 0; i < dates.length; i++) {
      const k = binKey(dates[i], o.interval);
      if (k !== cur) {
        bins.push({ key: k, startIdx: i, endIdx: i });
        cur = k;
      } else bins[bins.length - 1].endIdx = i;
    }
    const ratio = o.metric === "price_pct" || o.metric === "price";
    rows = bins.map((b, bi) => {
      const r: Record<string, string | number | null> = { date: dates[b.endIdx] };
      series.forEach((s, si) => {
        const prevEnd = bi > 0 ? raw[si][bins[bi - 1].endIdx] : raw[si][b.startIdx];
        const end = raw[si][b.endIdx];
        if (prevEnd == null || end == null) r[s.key] = null;
        else if (ratio && o.metric === "price_pct") {
          // period return needs the underlying ratio: (1+end)/(1+prev) - 1
          r[s.key] = (1 + end) / (1 + prevEnd) - 1;
        } else r[s.key] = end - prevEnd;
      });
      return r;
    });
    outDates = rows.map((r) => r.date as string);
  }

  // Downsample very long cumulative windows, always keeping trade dates & endpoints.
  if (o.cumulative && rows.length > 700) {
    const keep = new Set<string>();
    for (const a of chosen) for (const t of a.txns) keep.add(t.date);
    const stride = Math.ceil(rows.length / 700);
    rows = rows.filter((r, i) => i % stride === 0 || i === rows.length - 1 || keep.has(r.date as string));
    outDates = rows.map((r) => r.date as string);
  }

  // Trade markers with the y value of their series at that date.
  const trades: TradeMark[] = [];
  if (o.cumulative) {
    const rowByDate = new Map(rows.map((r) => [r.date as string, r]));
    for (const a of chosen) {
      for (const t of a.txns) {
        if (t.date < (outDates[0] ?? "9999")) continue;
        const keys = series.filter((s) => s.assetId === a.id).map((s) => s.key);
        for (const k of keys) {
          const row = rowByDate.get(t.date);
          const y = row ? (row[k] as number | null) : null;
          if (y != null) trades.push({ txnId: t.id, date: t.date, type: t.type, seriesKey: k, y });
        }
      }
    }
  } else {
    for (const a of chosen) {
      for (const t of a.txns) {
        if (t.date >= (outDates[0] ?? "9999")) trades.push({ txnId: t.id, date: t.date, type: t.type, seriesKey: "", y: null });
      }
    }
  }

  return { rows, series, trades };
}
