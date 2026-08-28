"use client";

import { useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useYAxisInverseScale,
} from "recharts";
import { useDark, useJson, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import RangeControl, { rangeWindow, type RangeSel } from "./RangeControl";
import { axisDateFmt, daysBetween, fmtDate, fmtEUR, fmtMoney, fmtNum, fmtPct, todayISO } from "@/lib/format";
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
  const [prevSel, setPrevSel] = useState<RangeSel | null>(null);
  const brushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last range set explicitly (presets/calendar) — what "Prev range" returns
  // to, so consecutive brush zooms don't overwrite it.
  const manualSel = useRef<RangeSel>({ preset: "all", from: "", to: "" });
  const dark = useDark();
  const C = chrome(dark);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [cats, setCats] = useState<Category[] | null>(null); // null = all groups

  const pct = mode === "pct";
  const catOn = (k: Category) => !cats || cats.includes(k);

  const txnMarks = useMemo(
    () =>
      (data?.txnDates ?? []).flatMap((t) =>
        t.txns.map((x) => ({
          date: t.date,
          label: `${x.type === "buy" ? "Buy" : "Sell"} ${x.assetName} · ${fmtEUR(x.amountEUR)}`,
        }))
      ),
    [data]
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
        series.push({ key: `a${a.id}`, label: a.name, color: categoryShade(a.category, shade, dark) });
        byId.set(`a${a.id}`, vals);
      }
      valuesOf = (key) => byId.get(key)!;
    }

    // Transactions of hidden groups disappear with them.
    const catTxnDates = data.txnDates
      .map((t) => ({ ...t, txns: t.txns.filter((x) => active(x.category)) }))
      .filter((t) => t.txns.length > 0);

    const win = rangeWindow(sel, todayISO());
    let i0 = data.dates.findIndex((d) => d >= win.from);
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
    return { rows, series, catTxnDates, visibleTxnDates };
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
    if (cur.size === 0) return; // at least one group stays on
    setCats(cur.size === presentCats.length ? null : [...cur]);
  };

  // Dragging the brush zooms the x-axis; the zoom commits shortly after the
  // drag settles and the previous range is kept for the "Prev range" button.
  const onBrush = (b: { startIndex?: number; endIndex?: number }) => {
    if (brushTimer.current) clearTimeout(brushTimer.current);
    const s = b.startIndex ?? 0;
    const e = b.endIndex ?? rows.length - 1;
    if (s === 0 && e === rows.length - 1) return;
    const from = rows[s]?.date as string | undefined;
    const to = rows[e]?.date as string | undefined;
    if (!from || !to || from === to) return;
    brushTimer.current = setTimeout(() => {
      setPrevSel(manualSel.current);
      setSel({ preset: "custom", from, to });
    }, 600);
  };
  const setManual = (s: RangeSel) => {
    setPrevSel(manualSel.current);
    manualSel.current = s;
    setSel(s);
  };
  const goBack = () => {
    if (!prevSel) return;
    setSel(prevSel);
    setPrevSel(sel);
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

  // A click anywhere near a marker line selects the nearest transaction date (±5 days).
  const onChartClick = (e: { activeLabel?: string | number } | null) => {
    const label = e?.activeLabel;
    if (typeof label !== "string") return;
    const clicked = Date.parse(label);
    let best: string | null = null;
    let bestDist = 5 * 86400000 + 1;
    for (const t of catTxnDates) {
      const dist = Math.abs(Date.parse(t.date) - clicked);
      if (dist < bestDist) {
        bestDist = dist;
        best = t.date;
      }
    }
    setSelectedDate(best === selectedDate ? null : best);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Market value of what you hold, split by {grouping === "category" ? "category." : "asset."} Vertical
          lines are transactions — tap one for details.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle
            options={[{ k: "category", l: "Groups" }, { k: "asset", l: "Assets" }]}
            value={grouping}
            onChange={(v) => setGrouping(v as Grouping)}
            title="Stack by category or by individual asset"
          />
          <RangeControl
            sel={sel}
            onChange={setManual}
            onBack={goBack}
            backTo={prevSel}
            txns={txnMarks}
            min={data.dates[0]}
            max={data.dates[data.dates.length - 1]}
          />
          <ModeToggle mode={mode} onToggle={toggleMode} />
        </div>
      </div>

      {presentCats.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Groups</span>
          {presentCats.map((c) => {
            const on = catOn(c.key);
            const color = categoryColor(c.key, dark);
            return (
              <button
                key={c.key}
                onClick={() => toggleCat(c.key)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                  on ? "border-transparent font-medium" : "border-line text-muted"
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

      <div className="rounded-lg border border-line bg-surface p-2 md:p-3">
        <div className="h-[320px] w-full md:h-[420px]">
          <ResponsiveContainer>
            <AreaChart
              data={rows}
              stackOffset={pct ? "expand" : "none"}
              margin={{ top: 10, right: 12, bottom: 0, left: 4 }}
              onClick={onChartClick}
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
                width={54}
                tickFormatter={(v: number) => (pct ? fmtPct(v, false, 0) : fmtEUR(v, true))}
              />
              <Tooltip
                content={<CapTip pct={pct} chromeC={C} series={series} txnDates={catTxnDates} />}
                cursor={{ stroke: C.muted, strokeWidth: 1, strokeDasharray: "3 3" }}
                isAnimationActive={false}
              />
              {series.map((s, i) => (
                <Area
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  name={s.label}
                  stackId="cap"
                  stroke={C.surface}
                  strokeWidth={1}
                  fill={s.color}
                  fillOpacity={0.85}
                  isAnimationActive={false}
                  // Hover dots mark the internal boundaries only — none on the outer top edge.
                  activeDot={i === series.length - 1 ? false : undefined}
                />
              ))}
              {txnBands.map((b) => (
                <ReferenceLine
                  key={b.id}
                  segment={[{ x: b.date, y: b.y1 }, { x: b.date, y: b.y2 }]}
                  stroke={mixHex(b.color, "#000000", dark ? 0.25 : 0.4)}
                  strokeWidth={3}
                />
              ))}
              {visibleTxnDates.map((t) => (
                <ReferenceLine
                  key={t.date}
                  x={t.date}
                  stroke={C.ink}
                  strokeWidth={t.date === selectedDate ? 2.5 : 1.5}
                  opacity={t.date === selectedDate ? 1 : 0.55}
                />
              ))}
              <Brush
                key={`${rows.length}:${rows[0]?.date ?? ""}:${rows[rows.length - 1]?.date ?? ""}`}
                dataKey="date"
                height={22}
                travellerWidth={8}
                stroke={C.axis}
                fill={C.surface}
                tickFormatter={tickFmt}
                onChange={onBrush}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-2 pb-1 text-xs text-ink2">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-muted">
            <span className="inline-block h-3 w-px" style={{ background: C.ink }} /> transaction (tap to inspect)
          </span>
        </div>
      </div>

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
                  <span className="font-medium">{t.assetName}</span>
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
          className={`px-2.5 py-1 ${value === o.k ? "bg-accent/15 font-semibold text-accent" : "text-muted hover:text-ink2"}`}
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
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; dataKey?: string; payload?: Record<string, number> }[];
  label?: string;
  coordinate?: { x?: number; y?: number };
  pct: boolean;
  chromeC: ReturnType<typeof chrome>;
  series: CapSeries[];
  txnDates: CapitalData["txnDates"];
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
      className="rounded-md border px-2.5 py-2 text-xs shadow-sm"
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
              className="flex items-center gap-1.5"
              style={{ color: hot ? chromeC.ink : chromeC.inkSecondary }}
            >
              <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tnum">{pct ? fmtPct(total > 0 ? v / total : 0, false) : fmtEUR(v)}</span>
          </div>
        );
      })}
      {nearTxn && (
        <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: chromeC.grid }}>
          {nearTxn.date !== label && (
            <div className="mb-0.5" style={{ color: chromeC.muted }}>{fmtDate(nearTxn.date)}</div>
          )}
          {nearTxn.txns.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: chromeC.inkSecondary }}>
                <span className="font-semibold uppercase" style={{ color: chromeC.ink }}>{t.type}</span>
                {t.assetName}
              </span>
              <span className="tnum">{fmtEUR(t.amountEUR)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
