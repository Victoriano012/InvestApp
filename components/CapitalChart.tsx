"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDark, useJson, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import { fmtDate, fmtDateShort, fmtEUR, fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { categoryColor, chrome } from "@/lib/palette";
import { CATEGORIES, CATEGORY_LABEL, type CapitalData, type Category } from "@/lib/types";

export default function CapitalChart() {
  const { data, error } = useJson<CapitalData>("/api/capital");
  const [mode, toggleMode] = useValueMode();
  const dark = useDark();
  const C = chrome(dark);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const pct = mode === "pct";

  const model = useMemo(() => {
    if (!data || data.dates.length === 0) return null;
    const txnDateSet = new Set(data.txnDates.map((t) => t.date));
    let rows = data.dates.map((d, i) => {
      const r: Record<string, string | number> = { date: d };
      for (const c of CATEGORIES) r[c.key] = data.byCategory[c.key][i] ?? 0;
      return r;
    });
    if (rows.length > 700) {
      const stride = Math.ceil(rows.length / 700);
      rows = rows.filter((r, i) => i % stride === 0 || i === rows.length - 1 || txnDateSet.has(r.date as string));
    }
    const activeCats = CATEGORIES.filter((c) => data.byCategory[c.key].some((v) => v > 0));
    return { rows, activeCats };
  }, [data]);

  if (error) return <p className="p-6 text-sm text-down">Failed to load: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!model || data.txnDates.length === 0)
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Invested capital</h1>
        <p className="rounded-lg border border-line bg-surface p-8 text-center text-sm text-muted">
          No transactions yet — this chart shows how your invested capital is split across categories over time.
        </p>
      </div>
    );

  const { rows, activeCats } = model;
  const selected = selectedDate ? data.txnDates.find((t) => t.date === selectedDate) ?? null : null;

  // A click anywhere near a marker line selects the nearest transaction date (±5 days).
  const onChartClick = (e: { activeLabel?: string | number } | null) => {
    const label = e?.activeLabel;
    if (typeof label !== "string") return;
    const clicked = Date.parse(label);
    let best: string | null = null;
    let bestDist = 5 * 86400000 + 1;
    for (const t of data.txnDates) {
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Invested capital</h1>
          <p className="text-xs text-muted">
            Cost basis of what you hold, split by category. Vertical lines are transactions — tap one for details.
          </p>
        </div>
        <ModeToggle mode={mode} onToggle={toggleMode} />
      </div>

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
                tickFormatter={(d: string) => fmtDateShort(d)}
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
                content={<CapTip pct={pct} chromeC={C} dark={dark} />}
                cursor={{ stroke: C.muted, strokeWidth: 1, strokeDasharray: "3 3" }}
              />
              {activeCats.map((c) => (
                <Area
                  key={c.key}
                  type="stepAfter"
                  dataKey={c.key}
                  name={c.label}
                  stackId="cap"
                  stroke={C.surface}
                  strokeWidth={1}
                  fill={categoryColor(c.key, dark)}
                  fillOpacity={0.85}
                  isAnimationActive={false}
                />
              ))}
              {data.txnDates.map((t) => (
                <ReferenceLine
                  key={t.date}
                  x={t.date}
                  stroke={t.date === selectedDate ? C.ink : C.ink}
                  strokeWidth={t.date === selectedDate ? 2.5 : 1.5}
                  opacity={t.date === selectedDate ? 1 : 0.55}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-2 pb-1 text-xs text-ink2">
          {activeCats.map((c) => (
            <span key={c.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: categoryColor(c.key, dark) }} />
              {c.label}
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

function CapTip({
  active,
  payload,
  label,
  pct,
  chromeC,
  dark,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; dataKey?: string; payload?: Record<string, number> }[];
  label?: string;
  pct: boolean;
  chromeC: ReturnType<typeof chrome>;
  dark: boolean;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const total = CATEGORIES.reduce((s, c) => s + (Number(row[c.key]) || 0), 0);
  return (
    <div
      className="rounded-md border px-2.5 py-2 text-xs shadow-sm"
      style={{ background: chromeC.surface, borderColor: chromeC.grid, color: chromeC.ink }}
    >
      <div className="mb-1 font-medium">{label ? fmtDate(label) : ""} · {fmtEUR(total)}</div>
      {[...payload].reverse().map((p, i) => {
        const v = Number(row[p.dataKey as string]) || 0;
        if (v === 0) return null;
        return (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5" style={{ color: chromeC.inkSecondary }}>
              <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: categoryColor(p.dataKey as Category, dark) }} />
              {CATEGORY_LABEL[p.dataKey as Category]}
            </span>
            <span className="tnum">{pct ? fmtPct(total > 0 ? v / total : 0, false) : fmtEUR(v)}</span>
          </div>
        );
      })}
    </div>
  );
}
