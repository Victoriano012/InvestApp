"use client";

import Link from "next/link";
import { useDark, useJson, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import { fmtEUR, fmtPct, fmtSignedEUR } from "@/lib/format";
import { categoryColor } from "@/lib/palette";
import { CATEGORY_LABEL, type Holding, type PortfolioSummary, type ReturnStats } from "@/lib/types";

function Delta({ v, money }: { v: number | null | undefined; money?: boolean }) {
  if (v == null || !isFinite(v)) return <span className="text-muted">—</span>;
  const cls = v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink2";
  return <span className={cls}>{money ? fmtSignedEUR(v) : fmtPct(v)}</span>;
}

/** Annualized rate cell; short holding periods are flagged instead of extrapolated. */
function Annual({ s }: { s: ReturnStats | null }) {
  if (!s) return <span className="text-muted">—</span>;
  if (s.days < 30)
    return (
      <span className="text-muted" title={`Held only ${s.days} days — annualizing would be noise. Total so far: ${fmtPct(s.totalPct)}`}>
        {fmtPct(s.totalPct)}
        <span className="ml-1 text-[10px]">({s.days}d)</span>
      </span>
    );
  return <Delta v={s.annualPct} />;
}

export default function PortfolioView() {
  const { data, error, reload } = useJson<PortfolioSummary>("/api/portfolio");
  const [mode, toggleMode] = useValueMode();
  const dark = useDark();

  if (error)
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-sm">
        <p className="text-down">Failed to load portfolio: {error}</p>
        <button onClick={reload} className="mt-3 rounded-md border border-line px-3 py-1.5">Retry</button>
      </div>
    );
  if (!data) return <p className="p-6 text-sm text-muted">Loading portfolio…</p>;

  const held = data.holdings.filter((h) => h.quantity > 0 || h.txnCount > 0);
  const watch = data.holdings.filter((h) => h.quantity === 0 && h.txnCount === 0);
  const pct = mode === "pct";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
        <ModeToggle mode={mode} onToggle={toggleMode} />
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-3">
        <Tile label="Total value" value={fmtEUR(data.totalValueEUR)} />
        <Tile
          label="Unrealized"
          value={pct
            ? fmtPct(data.totalCostEUR > 0 ? data.totalUnrealizedEUR / data.totalCostEUR : null)
            : fmtSignedEUR(data.totalUnrealizedEUR)}
          tone={data.totalUnrealizedEUR}
        />
        <Tile label="Invested" value={fmtEUR(data.totalInvestedEUR)} sub={data.totalRealizedEUR !== 0 ? `realized ${fmtSignedEUR(data.totalRealizedEUR)}` : undefined} />
      </div>

      {data.staleQuotes.length > 0 && (
        <p className="text-xs text-muted">
          Using cached prices for {data.staleQuotes.join(", ")} (live fetch failed).
        </p>
      )}

      {/* Holdings — table on desktop */}
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 text-right font-medium">{pct ? "Weight" : "Value"}</th>
              <th className="px-3 py-2 text-right font-medium">{pct ? "Gain %" : "Gain €"}</th>
              <th className="px-3 py-2 text-right font-medium" title="Annualized return since your first buy (price-based, in EUR)">Ann. since 1st buy</th>
              <th className="px-3 py-2 text-right font-medium" title="Annualized return since your most recent buy (price-based, in EUR)">Ann. since last buy</th>
            </tr>
          </thead>
          <tbody>
            {held.map((h) => (
              <Row key={h.asset.id} h={h} pct={pct} dark={dark} />
            ))}
          </tbody>
        </table>
        {held.length === 0 && <Empty />}
      </div>

      {/* Holdings — cards on mobile */}
      <div className="space-y-2 md:hidden">
        {held.map((h) => (
          <Card key={h.asset.id} h={h} pct={pct} dark={dark} />
        ))}
        {held.length === 0 && <div className="rounded-lg border border-line bg-surface"><Empty /></div>}
      </div>

      {watch.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-ink2">Watching (no transactions yet)</h2>
          <div className="flex flex-wrap gap-2">
            {watch.map((h) => (
              <Link
                key={h.asset.id}
                href={`/asset/${h.asset.id}`}
                className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: categoryColor(h.asset.category, dark) }} />
                <span>{h.asset.name}</span>
                <span className="text-xs text-muted">{h.asset.kind === "basket" ? "basket" : h.asset.symbol}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {data.quotesAsOf && (
        <p className="text-xs text-muted">
          Prices as of {new Date(data.quotesAsOf).toLocaleTimeString()} · quotes cached 5 min · via Yahoo Finance
        </p>
      )}
    </div>
  );
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: number; sub?: string }) {
  const cls = tone == null ? "" : tone > 0 ? "text-up" : tone < 0 ? "text-down" : "";
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function AssetLabel({ h, dark }: { h: Holding; dark: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColor(h.asset.category, dark) }} />
      <div>
        <div className="font-medium">{h.asset.name}</div>
        <div className="text-xs text-muted">
          {h.asset.kind === "basket" ? "Basket" : h.asset.symbol} · {CATEGORY_LABEL[h.asset.category]}
          {h.txnCount > 1 && ` · ${h.lots.filter((l) => l.remaining > 0).length} lots`}
        </div>
      </div>
    </div>
  );
}

function Row({ h, pct, dark }: { h: Holding; pct: boolean; dark: boolean }) {
  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-line/20">
      <td className="px-3 py-2.5">
        <Link href={`/asset/${h.asset.id}`} className="block">
          <AssetLabel h={h} dark={dark} />
        </Link>
      </td>
      <td className="tnum px-3 py-2.5 text-right">{pct ? fmtPct(h.weightPct, false) : fmtEUR(h.valueEUR)}</td>
      <td className="tnum px-3 py-2.5 text-right">
        <Delta v={pct ? h.unrealizedPct : h.unrealizedEUR} money={!pct} />
      </td>
      <td className="tnum px-3 py-2.5 text-right"><Annual s={h.sinceFirstBuy} /></td>
      <td className="tnum px-3 py-2.5 text-right"><Annual s={h.sinceLastBuy} /></td>
    </tr>
  );
}

function Card({ h, pct, dark }: { h: Holding; pct: boolean; dark: boolean }) {
  return (
    <Link href={`/asset/${h.asset.id}`} className="block rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <AssetLabel h={h} dark={dark} />
        <div className="text-right">
          <div className="tnum font-semibold">{pct ? fmtPct(h.weightPct, false) : fmtEUR(h.valueEUR)}</div>
          <div className="tnum text-sm">
            <Delta v={pct ? h.unrealizedPct : h.unrealizedEUR} money={!pct} />
          </div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
        <div>
          <div className="text-muted">Ann. 1st buy</div>
          <div className="tnum"><Annual s={h.sinceFirstBuy} /></div>
        </div>
        <div>
          <div className="text-muted">Ann. last buy</div>
          <div className="tnum"><Annual s={h.sinceLastBuy} /></div>
        </div>
      </div>
    </Link>
  );
}

function Empty() {
  return (
    <div className="p-8 text-center text-sm text-muted">
      No transactions yet. Add your first buy in{" "}
      <Link href="/transactions" className="text-accent underline">Activity</Link>.
    </div>
  );
}
