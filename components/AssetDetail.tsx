"use client";

import Link from "next/link";
import { useDark, useJson, useValueMode } from "./hooks";
import ModeToggle from "./ModeToggle";
import { fmtDate, fmtEUR, fmtMoney, fmtNum, fmtPct, fmtSignedEUR } from "@/lib/format";
import { categoryColor } from "@/lib/palette";
import { CATEGORY_LABEL, type BasketComponent, type PortfolioSummary, type Txn } from "@/lib/types";

function D({ v, money }: { v: number | null | undefined; money?: boolean }) {
  if (v == null || !isFinite(v)) return <span className="text-muted">—</span>;
  const cls = v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink2";
  return <span className={cls}>{money ? fmtSignedEUR(v) : fmtPct(v)}</span>;
}

export default function AssetDetail({ id }: { id: number }) {
  const { data, error } = useJson<PortfolioSummary>("/api/portfolio");
  const { data: txns } = useJson<Txn[]>(`/api/transactions?asset=${id}`);
  const [mode, toggleMode] = useValueMode();
  const dark = useDark();

  if (error) return <p className="p-6 text-sm text-down">Failed to load: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const h = data.holdings.find((x) => x.asset.id === id);
  if (!h) return <p className="p-6 text-sm text-muted">Unknown asset.</p>;
  const pct = mode === "pct";
  const sells = (txns ?? []).filter((t) => t.type === "sell");
  const isBasket = h.asset.kind === "basket";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="h-3 w-3 rounded-full" style={{ background: categoryColor(h.asset.category, dark) }} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{h.asset.name}</h1>
            <p className="text-xs text-muted">
              {isBasket ? "Basket (equal parts per buy)" : h.asset.symbol} · {CATEGORY_LABEL[h.asset.category]} · quoted in {h.asset.currency}
            </p>
          </div>
        </div>
        <ModeToggle mode={mode} onToggle={toggleMode} />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-3">
        {isBasket ? (
          <Tile label="Per €1 invested" value={h.priceNative != null ? fmtEUR(h.priceNative) : "—"} sub="value of 1€ put in (avg. across buys)" />
        ) : (
          <Tile label={`Price (${h.asset.currency})`} value={fmtMoney(h.priceNative, h.asset.currency)} sub={h.asset.currency !== "EUR" ? fmtEUR(h.priceEUR) : undefined} />
        )}
        <Tile
          label={isBasket ? "Invested" : "Held"}
          value={isBasket ? fmtEUR(h.costEUR) : fmtNum(h.quantity)}
          sub={pct ? fmtPct(h.weightPct, false) + " of portfolio" : fmtEUR(h.valueEUR)}
        />
        <Tile label="Unrealized" value={pct ? fmtPct(h.unrealizedPct) : fmtSignedEUR(h.unrealizedEUR)} tone={h.unrealizedEUR} />
      </div>

      {isBasket && <BasketComponents id={id} />}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink2">Performance per buy</h2>
        {h.lots.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">
            No buys yet. Add one in <Link className="text-accent underline" href="/transactions">Activity</Link>.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Bought</th>
                  <th className="px-3 py-2 text-right font-medium">{isBasket ? "Amount (€)" : "Qty"}</th>
                  {!isBasket && <th className="px-3 py-2 text-right font-medium">Entry ({h.asset.currency})</th>}
                  <th className="px-3 py-2 text-right font-medium">{pct ? "Total %" : "Gain €"}</th>
                  <th className="px-3 py-2 text-right font-medium" title="Geometric mean monthly return since this buy">Mean monthly</th>
                  <th className="px-3 py-2 text-right font-medium" title="Annualized return since this buy">Annualized</th>
                  <th className="px-3 py-2 text-right font-medium">Held</th>
                </tr>
              </thead>
              <tbody>
                {h.lots.map((lot) => {
                  const short = lot.stats.days < 30;
                  return (
                    <tr key={lot.txnId} className={`border-b border-line/60 last:border-0 ${lot.remaining === 0 ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2">{fmtDate(lot.date)}{lot.remaining === 0 && <span className="ml-1.5 text-xs text-muted">(sold)</span>}</td>
                      <td className="tnum px-3 py-2 text-right">
                        {isBasket ? fmtEUR(lot.remaining) : fmtNum(lot.remaining)}
                        {lot.remaining !== lot.quantity && (
                          <span className="text-xs text-muted"> / {isBasket ? fmtEUR(lot.quantity) : fmtNum(lot.quantity)}</span>
                        )}
                      </td>
                      {!isBasket && (
                        <td className="tnum px-3 py-2 text-right">
                          {fmtNum(lot.priceNative, 2)}
                          {h.asset.currency !== "EUR" && <div className="text-xs text-muted">{fmtEUR(lot.priceEUR)}</div>}
                        </td>
                      )}
                      <td className="tnum px-3 py-2 text-right"><D v={pct ? lot.stats.totalPct : lot.gainEUR} money={!pct} /></td>
                      <td className="tnum px-3 py-2 text-right">
                        {short ? <span className="text-muted" title="Held under 30 days — rate not meaningful yet">—</span> : <D v={lot.stats.monthlyPct} />}
                      </td>
                      <td className="tnum px-3 py-2 text-right">
                        {short ? <span className="text-muted" title="Held under 30 days — rate not meaningful yet">—</span> : <D v={lot.stats.annualPct} />}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-xs text-muted">{lot.stats.days}d</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1.5 text-xs text-muted">
          Returns are price-based in EUR (includes currency moves), from your actual entry price incl. fees. Rates under 30 days of holding are hidden — too noisy to annualize.
        </p>
      </section>

      {sells.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink2">Sells</h2>
          <div className="rounded-lg border border-line bg-surface">
            {sells.map((s) => (
              <div key={s.id} className="flex items-center justify-between border-b border-line/60 px-3 py-2 text-sm last:border-0">
                <span>{fmtDate(s.date)}</span>
                <span className="tnum">{isBasket ? fmtEUR(s.quantity * s.price) : <>{fmtNum(s.quantity)} × {fmtMoney(s.price, h.asset.currency)}</>}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-muted">Realized P&L</span>
              <span className="tnum"><D v={h.realizedEUR} money /></span>
            </div>
          </div>
        </section>
      )}

      <div className="flex gap-2">
        <Link href={`/charts?assets=${id}`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm">View in charts</Link>
        <Link href="/transactions" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm">Add transaction</Link>
      </div>
    </div>
  );
}

function BasketComponents({ id }: { id: number }) {
  const { data: comps } = useJson<BasketComponent[]>(`/api/assets/${id}/components`);
  if (!comps || comps.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 text-xs font-semibold text-ink2">Components ({comps.length}) — each buy is split equally among them</div>
      <div className="flex flex-wrap gap-1.5">
        {comps.map((c) => (
          <span key={c.id} className="rounded-md border border-line/70 px-2 py-1 text-xs">
            <span className="font-medium">{c.symbol}</span> <span className="text-muted">{c.name}</span>
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">Edit the list on the Activity page (☰ next to the basket).</p>
    </div>
  );
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: number; sub?: string }) {
  const cls = tone == null ? "" : tone > 0 ? "text-up" : tone < 0 ? "text-down" : "";
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="tnum text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
