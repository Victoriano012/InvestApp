"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDark, useJson, useMobile, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import { fmtDate, fmtDayShort, fmtEUR, fmtPct, fmtSignedEUR } from "@/lib/format";
import { categoryColor } from "@/lib/palette";
import { assetLabel, CATEGORIES, CATEGORY_LABEL, type Holding, type PortfolioSummary, type ReturnStats } from "@/lib/types";

const SORT_OPTIONS = [
  { key: "category", label: "Group" },
  { key: "value", label: "Current value" },
  { key: "invested", label: "Money put in" },
  { key: "gain", label: "Gain" },
  { key: "first", label: "Ann. since 1st buy" },
  { key: "last", label: "Ann. since last buy" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

const CAT_ORDER = new Map(CATEGORIES.map((c, i) => [c.key, i]));

function Delta({ v, money }: { v: number | null | undefined; money?: boolean }) {
  if (v == null || !isFinite(v)) return <span className="text-muted">—</span>;
  const cls = v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink2";
  return <span className={cls}>{money ? fmtSignedEUR(v) : fmtPct(v)}</span>;
}

/** Annualized rate cell; short holding periods are flagged instead of extrapolated. */
function Annual({ s, date }: { s: ReturnStats | null; date?: string | null }) {
  const when = date ? (
    <span className="ml-1 text-[10px] text-muted" title={fmtDate(date)}>
      {fmtDayShort(date)}
    </span>
  ) : null;
  if (!s) return <span className="text-muted">—</span>;
  if (s.days < 30)
    return (
      <span className="text-muted" title={`Ann. return: ${fmtPct(s.annualPct)}`}>
        {fmtPct(s.totalPct)}
        {when}
      </span>
    );
  return (
    <>
      <Delta v={s.annualPct} />
      {when}
    </>
  );
}

export default function PortfolioView() {
  const { data, error, reload } = useJson<PortfolioSummary>("/api/portfolio");
  const [mode, toggleMode] = useValueMode();
  const [sortKey, setSortKey] = useState<SortKey>("category");
  const [sortAsc, setSortAsc] = useState(false);
  const dark = useDark();
  const mobile = useMobile();

  // Restore the last-used sort (shared behavior with the €/% toggle).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("investapp.portfolioSort");
      if (!raw) return;
      const [k, dir] = raw.split(":");
      if (SORT_OPTIONS.some((o) => o.key === k)) setSortKey(k as SortKey);
      setSortAsc(dir === "asc");
    } catch {
      /* default */
    }
  }, []);
  const setSort = (k: SortKey, asc: boolean) => {
    setSortKey(k);
    setSortAsc(asc);
    try {
      localStorage.setItem("investapp.portfolioSort", `${k}:${asc ? "asc" : "desc"}`);
    } catch {
      /* fine */
    }
  };

  const pctMode = mode === "pct";
  const holdings = data?.holdings;
  const heldSorted = useMemo(() => {
    const held = (holdings ?? []).filter((h) => h.quantity > 0 || h.txnCount > 0);
    if (sortKey === "category") {
      // Fixed CATEGORIES order, keeping the DB order within each category
      // (stable sort) — reversing wholesale only when ascending.
      const arr = [...held].sort(
        (a, b) => (CAT_ORDER.get(a.asset.category) ?? 99) - (CAT_ORDER.get(b.asset.category) ?? 99)
      );
      return sortAsc ? arr.reverse() : arr;
    }
    const val = (h: Holding): number => {
      switch (sortKey) {
        case "value":
          return h.valueEUR;
        case "invested":
          return h.costEUR;
        case "gain":
          return pctMode ? (h.unrealizedPct ?? -Infinity) : h.unrealizedEUR;
        case "first":
          return h.sinceFirstBuy?.annualPct ?? -Infinity;
        case "last":
          return h.sinceLastBuy?.annualPct ?? -Infinity;
      }
    };
    const arr = [...held].sort((a, b) => val(a) - val(b));
    if (!sortAsc) arr.reverse();
    return arr;
  }, [holdings, sortKey, sortAsc, pctMode]);

  if (error)
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-sm">
        <p className="text-down">Failed to load portfolio: {error}</p>
        <button onClick={reload} className="mt-3 rounded-md border border-line px-3 py-1.5">Retry</button>
      </div>
    );
  if (!data) return <p className="p-6 text-sm text-muted">Loading portfolio…</p>;

  const watch = data.holdings.filter((h) => h.quantity === 0 && h.txnCount === 0);
  const pct = pctMode;

  return (
    <div className="space-y-5">
      {/* Summary tiles + sort controls: one line on desktop, stacked on phones */}
      <div className="space-y-5 md:flex md:items-end md:justify-between md:gap-4 md:space-y-0">
      <div className="grid grid-cols-2 gap-2 md:flex-1 md:grid-cols-3 md:gap-3">
        <Tile label="Total value" value={fmtEUR(data.totalValueEUR)} />
        <Tile
          label="Unrealized"
          value={pct
            ? fmtPct(data.totalCostEUR > 0 ? data.totalUnrealizedEUR / data.totalCostEUR : null)
            : fmtSignedEUR(data.totalUnrealizedEUR)}
          tone={data.totalUnrealizedEUR}
        />
        <Tile label="Invested" value={fmtEUR(data.totalInvestedEUR)} sub={data.totalRealizedEUR !== 0 ? `realized ${fmtSignedEUR(data.totalRealizedEUR)}` : undefined} className="hidden md:block md:col-span-1" />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <select
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink2"
              value={sortKey}
              onChange={(e) => setSort(e.target.value as SortKey, sortAsc)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setSort(sortKey, !sortAsc)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink2"
            title={sortAsc ? "Ascending — click for descending" : "Descending — click for ascending"}
            aria-label="Toggle sort direction"
          >
            {sortAsc ? "↑" : "↓"}
          </button>
          <ModeToggle mode={mode} onToggle={toggleMode} />
        </div>
      </div>
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
            {heldSorted.map((h) => (
              <Row key={h.asset.id} h={h} pct={pct} dark={dark} />
            ))}
          </tbody>
        </table>
        {heldSorted.length === 0 && <Empty />}
      </div>

      {/* Holdings — compact table on mobile */}
      <div className="rounded-lg border border-line bg-surface md:hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-2.5 py-2 align-top font-medium">Asset</th>
              <th className="px-2 py-2 align-top font-medium" title="Small figure underneath: unrealized gain">{pct ? "Weight" : "Value"}</th>
              <th className="px-2.5 py-2 align-top font-medium" title="Annualized return since your first buy (top) and since your most recent buy (below)">
                <div>Ann. 1st</div>
                <div>Ann. last</div>
              </th>
            </tr>
          </thead>
          <tbody>
            {heldSorted.map((h) => (
              <MobileRow key={h.asset.id} h={h} pct={pct} dark={dark} />
            ))}
          </tbody>
        </table>
        {heldSorted.length === 0 && <Empty />}
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
                <span>{assetLabel(h.asset, mobile)}</span>
                <span className="text-xs text-muted">{h.asset.kind === "basket" ? "basket" : h.asset.symbol}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function Tile({ label, value, tone, sub, className = "" }: { label: string; value: string; tone?: number; sub?: string; className?: string }) {
  const cls = tone == null ? "" : tone > 0 ? "text-up" : tone < 0 ? "text-down" : "";
  return (
    <div className={`rounded-lg border border-line bg-surface px-3 py-2.5 ${className}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function AssetLabel({ h, dark, plain }: { h: Holding; dark: boolean; plain?: boolean }) {
  const mobile = useMobile();
  const lots = h.txnCount > 1 ? `${h.lots.filter((l) => l.remaining > 0).length} lots` : null;
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColor(h.asset.category, dark) }} />
      <div>
        <div className="font-medium">{assetLabel(h.asset, mobile)}</div>
        {plain ? (
          lots && <div className="text-xs text-muted">{lots}</div>
        ) : (
          <div className="text-xs text-muted">
            {h.asset.kind === "basket"
              ? "Basket"
              : h.asset.category === "gold" || h.asset.category === "crypto"
                ? h.asset.symbol
                : `${h.asset.symbol} · ${CATEGORY_LABEL[h.asset.category]}`}
            {lots && ` · ${lots}`}
          </div>
        )}
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
      <td className="tnum px-3 py-2.5 text-right"><Annual s={h.sinceFirstBuy} date={h.firstBuyDate} /></td>
      <td className="tnum px-3 py-2.5 text-right"><Annual s={h.sinceLastBuy} date={h.lastBuyDate} /></td>
    </tr>
  );
}

function MobileRow({ h, pct, dark }: { h: Holding; pct: boolean; dark: boolean }) {
  const router = useRouter();
  return (
    <tr
      className="cursor-pointer border-b border-line/60 last:border-0"
      onClick={() => router.push(`/asset/${h.asset.id}`)}
    >
      <td className="px-2.5 py-2"><AssetLabel h={h} dark={dark} plain /></td>
      <td className="tnum px-2 py-2 text-right">
        <div className="font-medium">{pct ? fmtPct(h.weightPct, false) : fmtEUR(h.valueEUR)}</div>
        <div className="text-[11px]">
          <Delta v={pct ? h.unrealizedPct : h.unrealizedEUR} money={!pct} />
        </div>
      </td>
      <td className="tnum px-2.5 py-2 text-right text-xs">
        <div><Annual s={h.sinceFirstBuy} /></div>
        <div><Annual s={h.sinceLastBuy} /></div>
      </td>
    </tr>
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
