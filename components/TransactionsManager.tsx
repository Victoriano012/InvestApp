"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDark, useJson } from "./hooks";
import { fmtDate, fmtMoney, fmtNum, todayISO } from "@/lib/format";
import { categoryColor } from "@/lib/palette";
import { CATEGORIES, type Asset, type Category, type Txn, type TxnType } from "@/lib/types";

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

interface TxnForm {
  id: number | null; // editing when set
  asset_id: number | "";
  type: TxnType;
  date: string;
  quantity: string;
  price: string;
  fees: string;
  note: string;
}

const emptyForm = (assetId: number | "" = ""): TxnForm => ({
  id: null,
  asset_id: assetId,
  type: "buy",
  date: todayISO(),
  quantity: "",
  price: "",
  fees: "",
  note: "",
});

export default function TransactionsManager() {
  const { data: assets, reload: reloadAssets } = useJson<Asset[]>("/api/assets");
  const { data: txns, reload: reloadTxns } = useJson<Txn[]>("/api/transactions");
  const dark = useDark();

  const [form, setForm] = useState<TxnForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const assetById = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const sorted = useMemo(
    () => [...(txns ?? [])].sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1)),
    [txns]
  );

  const set = (patch: Partial<TxnForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (form.asset_id === "" || !form.quantity || !form.price) {
      setMsg("Asset, quantity and price are required.");
      return;
    }
    setBusy(true);
    setMsg(null);
    const body = {
      asset_id: form.asset_id,
      type: form.type,
      date: form.date,
      quantity: Number(form.quantity),
      price: Number(form.price),
      fees: form.fees ? Number(form.fees) : 0,
      note: form.note || null,
    };
    const res = await fetch(form.id ? `/api/transactions/${form.id}` : "/api/transactions", {
      method: form.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setMsg(j?.error || "Failed to save.");
      return;
    }
    setForm(emptyForm(form.asset_id));
    reloadTxns();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this transaction?")) return;
    await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    reloadTxns();
  };

  const startEdit = (t: Txn) => {
    setForm({
      id: t.id,
      asset_id: t.asset_id,
      type: t.type,
      date: t.date,
      quantity: String(t.quantity),
      price: String(t.price),
      fees: t.fees ? String(t.fees) : "",
      note: t.note ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selAsset = form.asset_id !== "" ? assetById.get(form.asset_id) : undefined;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Activity</h1>

      {/* Add / edit form */}
      <div className="rounded-lg border border-line bg-surface p-3 md:p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink2">{form.id ? "Edit transaction" : "Add transaction"}</h2>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <label className="col-span-2 block text-xs md:col-span-2">
            <span className="text-muted">Asset</span>
            <select
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.asset_id}
              onChange={(e) => set({ asset_id: e.target.value ? Number(e.target.value) : "" })}
            >
              <option value="">Choose…</option>
              {(assets ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.symbol})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted">Type</span>
            <select
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.type}
              onChange={(e) => set({ type: e.target.value as TxnType })}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted">Date</span>
            <input
              type="date"
              max={todayISO()}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Quantity{selAsset?.symbol === "GC=F" ? " (troy oz)" : ""}</span>
            <input
              type="number" step="any" min="0" inputMode="decimal" placeholder="10"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.quantity}
              onChange={(e) => set({ quantity: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Price / unit {selAsset ? `(${selAsset.currency})` : ""}</span>
            <input
              type="number" step="any" min="0" inputMode="decimal" placeholder="118.40"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.price}
              onChange={(e) => set({ price: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Fees {selAsset ? `(${selAsset.currency}, optional)` : "(optional)"}</span>
            <input
              type="number" step="any" min="0" inputMode="decimal" placeholder="0"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.fees}
              onChange={(e) => set({ fees: e.target.value })}
            />
          </label>
          <label className="col-span-2 block text-xs md:col-span-1">
            <span className="text-muted">Note (optional)</span>
            <input
              type="text" placeholder="e.g. Revolut"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.note}
              onChange={(e) => set({ note: e.target.value })}
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {form.id ? "Save changes" : "Add transaction"}
          </button>
          {form.id && (
            <button onClick={() => setForm(emptyForm())} className="rounded-md border border-line px-3 py-2 text-sm text-ink2">
              Cancel
            </button>
          )}
          {msg && <span className="text-xs text-down">{msg}</span>}
        </div>
      </div>

      {/* Transaction list */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink2">History ({sorted.length})</h2>
        {sorted.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {sorted.map((t) => {
              const a = assetById.get(t.asset_id);
              return (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: a ? categoryColor(a.category, dark) : "#888" }} />
                    <span className={`w-10 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold uppercase ${t.type === "buy" ? "bg-accent/10 text-accent" : "bg-down/10 text-down"}`}>
                      {t.type}
                    </span>
                    <div>
                      <div className="font-medium">{a?.name ?? "?"}</div>
                      <div className="text-xs text-muted">
                        {fmtDate(t.date)}
                        {t.note ? ` · ${t.note}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tnum text-xs text-ink2">
                      {fmtNum(t.quantity)} × {a ? fmtMoney(t.price, a.currency) : fmtNum(t.price)}
                      {t.fees > 0 && <span className="text-muted"> +{fmtNum(t.fees, 2)} fees</span>}
                    </span>
                    <button onClick={() => startEdit(t)} className="text-xs text-accent">Edit</button>
                    <button onClick={() => remove(t.id)} className="text-xs text-muted hover:text-down">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <AssetManager assets={assets ?? []} onChanged={() => { reloadAssets(); reloadTxns(); }} dark={dark} />
    </div>
  );
}

// ---------- asset management ----------

function AssetManager({ assets, onChanged, dark }: { assets: Asset[]; onChanged: () => void; dark: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<SearchResult | null>(null);
  const [category, setCategory] = useState<Category>("etf");
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        const j = await r.json();
        setResults(Array.isArray(j) ? j : []);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  const add = async () => {
    if (!adding) return;
    setErr(null);
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: adding.symbol, name: adding.name, category }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setErr(j?.error || "Failed to add asset.");
      return;
    }
    setAdding(null);
    setQ("");
    setResults([]);
    onChanged();
  };

  const rename = async (a: Asset) => {
    const name = prompt(`Display name for ${a.symbol}:`, a.name);
    if (!name || name === a.name) return;
    await fetch(`/api/assets/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    onChanged();
  };

  const remove = async (a: Asset) => {
    if (!confirm(`Remove ${a.name} (${a.symbol})?`)) return;
    const res = await fetch(`/api/assets/${a.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error || "Cannot delete.");
      return;
    }
    onChanged();
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink2">Assets</h2>
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap gap-1.5">
          {assets.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs">
              <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(a.category, dark) }} />
              <span className="font-medium">{a.name}</span>
              <span className="text-muted">{a.symbol}</span>
              <button onClick={() => rename(a)} className="ml-1 text-accent" title="Rename">✎</button>
              <button onClick={() => remove(a)} className="text-muted hover:text-down" title="Remove (only without transactions)">✕</button>
            </span>
          ))}
        </div>

        <div className="mt-3 border-t border-line pt-3">
          <label className="block text-xs">
            <span className="text-muted">Add an asset — search Yahoo Finance (ticker, ISIN or name)</span>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. IE00BFNM3G45, Amundi Nasdaq, MELI…"
              className="mt-1 w-full max-w-md rounded-md border border-line bg-surface px-2 py-2 text-sm"
            />
          </label>
          {searching && <p className="mt-1 text-xs text-muted">Searching…</p>}
          {results.length > 0 && !adding && (
            <div className="mt-2 max-w-xl overflow-hidden rounded-md border border-line">
              {results.map((r) => (
                <button
                  key={r.symbol}
                  onClick={() => setAdding(r)}
                  className="flex w-full items-center justify-between gap-2 border-b border-line/60 px-2.5 py-1.5 text-left text-xs last:border-0 hover:bg-line/30"
                >
                  <span>
                    <span className="font-semibold">{r.symbol}</span> <span className="text-ink2">{r.name}</span>
                  </span>
                  <span className="shrink-0 text-muted">{r.exchange} · {r.type}</span>
                </button>
              ))}
            </div>
          )}
          {adding && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span>
                Add <span className="font-semibold">{adding.symbol}</span> as
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="rounded-md border border-line bg-surface px-2 py-1.5"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              <button onClick={add} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Add</button>
              <button onClick={() => setAdding(null)} className="rounded-md border border-line px-3 py-1.5 text-ink2">Cancel</button>
              {err && <span className="text-down">{err}</span>}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        The exchange listing matters: pick the one your broker actually trades (currency shown in the price field follows it).
      </p>
    </section>
  );
}
