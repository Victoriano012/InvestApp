"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDark, useJson, useMobile } from "./hooks";
import { fmtDate, fmtEUR, fmtMoney, fmtNum, todayISO } from "@/lib/format";
import { categoryColor } from "@/lib/palette";
import { assetLabel, CATEGORIES, type Asset, type BasketComponent, type Category, type Txn, type TxnType } from "@/lib/types";

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

// Yahoo's typeDisp → our category; anything unrecognized is a stock.
function inferCategory(type: string): Category {
  const t = type.toLowerCase();
  if (t.includes("etf") || t.includes("fund")) return "etf";
  if (t.includes("crypto")) return "crypto";
  if (t.includes("future")) return "gold";
  return "us_stock";
}

/** Debounced Yahoo symbol search, shared by the asset list and the basket editor. */
function useSymbolSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
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

  const clear = () => {
    setQ("");
    setResults([]);
  };
  return { q, setQ, results, searching, clear };
}

/** Search input + result list; clicking a result hands it to onPick. */
function SymbolSearch({
  label,
  search,
  onPick,
}: {
  label: string;
  search: ReturnType<typeof useSymbolSearch>;
  onPick: (r: SearchResult) => void;
}) {
  return (
    <div>
      <label className="block text-xs">
        <span className="text-muted">{label}</span>
        <input
          type="text"
          value={search.q}
          onChange={(e) => search.setQ(e.target.value)}
          placeholder="e.g. IE00BFNM3G45, Amundi Nasdaq, MELI…"
          className="mt-1 w-full max-w-md rounded-md border border-line bg-surface px-2 py-2 text-sm"
        />
      </label>
      {search.searching && <p className="mt-1 text-xs text-muted">Searching…</p>}
      {search.results.length > 0 && (
        <div className="mt-2 max-w-xl overflow-hidden rounded-md border border-line">
          {search.results.map((r) => (
            <button
              key={r.symbol}
              onClick={() => onPick(r)}
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
    </div>
  );
}

function TransactionRow({
  txn,
  asset,
  dark,
  mobile,
  editing = false,
  onEdit,
  onRemove,
}: {
  txn: Txn;
  asset?: Asset;
  dark: boolean;
  mobile: boolean;
  editing?: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const total = txn.type === "buy"
    ? txn.quantity * txn.price + txn.fees
    : txn.quantity * txn.price - txn.fees;
  const displayTotal = txn.paid_amount != null && txn.paid_currency
    ? fmtMoney(txn.paid_amount, txn.paid_currency)
    : asset?.kind === "basket"
      ? fmtEUR(total)
      : asset
        ? fmtMoney(total, asset.currency)
        : fmtNum(total, 2);

  return (
    <div
      className={editing
        ? "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm shadow-sm"
        : "flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0"}
    >
      <div className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: asset ? categoryColor(asset.category, dark) : "#888" }} />
        <span className={`w-12 rounded px-1.5 py-0.5 text-center font-semibold uppercase ${txn.type === "buy" ? "bg-accent/10 text-accent" : "bg-down/10 text-down"}`}>
          {txn.type}
        </span>
        <div>
          <div className="font-medium">{asset ? assetLabel(asset, mobile) : "?"}</div>
          <div className="text-muted">
            {fmtDate(txn.date)}
            {txn.note ? ` · ${txn.note}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="tnum text-ink2">{displayTotal}</span>
        {editing ? (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">Editing</span>
        ) : (
          <>
            <button onClick={onEdit} className="text-accent" title="Edit" aria-label="Edit">✎</button>
            <button onClick={onRemove} className="text-muted hover:text-down" title="Delete" aria-label="Delete">🗑︎</button>
          </>
        )}
      </div>
    </div>
  );
}

interface CloseCtx {
  price: number | null; // asset close on/before the date (1 for baskets)
  currency: string;
  usdPerEur: number | null;
  gbpPerEur: number | null;
  unitValue: number | null; // basket per-unit value (for sells)
}

interface TxnForm {
  id: number | null; // editing when set
  asset_id: number | "";
  type: TxnType;
  date: string;
  amount: string; // money paid/received (add mode)
  currency: string; // display currency (add mode)
  quantity: string;
  price: string;
  fees: string;
  note: string;
  paidAmount: string; // money paid/received (edit mode)
  paidCurrency: string; // display currency (edit mode)
}

const emptyForm = (assetId: number | "" = "", currency = "EUR"): TxnForm => ({
  id: null,
  asset_id: assetId,
  type: "buy",
  date: todayISO(),
  amount: "",
  currency,
  quantity: "",
  price: "",
  fees: "",
  note: "",
  paidAmount: "",
  paidCurrency: currency,
});

/** Factor converting an amount in `from` to `to`, via that day's per-EUR rates. */
function convFactor(from: string, to: string, ctx: CloseCtx): number | null {
  if (from === to) return 1;
  const perEur: Record<string, number | null | undefined> = {
    EUR: 1,
    USD: ctx.usdPerEur,
    GBP: ctx.gbpPerEur,
  };
  const f = perEur[from];
  const t = perEur[to];
  if (f == null || t == null || f <= 0 || t <= 0) return null;
  return t / f;
}

/** Number → input string without float noise (12 significant digits, no display rounding). */
function numStr(v: number): string {
  return isFinite(v) ? String(Number(v.toPrecision(12))) : "";
}

const feeSign = (t: TxnType) => (t === "buy" ? 1 : -1);

export default function TransactionsManager() {
  const { data: assets, reload: reloadAssets } = useJson<Asset[]>("/api/assets");
  const { data: txns, reload: reloadTxns } = useJson<Txn[]>("/api/transactions");
  const dark = useDark();
  const mobile = useMobile();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [form, setForm] = useState<TxnForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CloseCtx | null>(null);
  const ctxKey = useRef<string | null>(null);
  const autoPriceKey = useRef<string | null>(null);
  const refreshEditPrice = useRef(false);
  const currencyChanged = useRef(false);
  // Currency basis of the displayed money fields. Price/unit and fees share
  // one basis; the total has its own (a stored paid_amount is already in its
  // paid currency). Rebased to the selected currency once that date's rates load.
  const [editCur, setEditCur] = useState<{ ppu: string; total: string }>({ ppu: "EUR", total: "EUR" });

  const assetById = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const sorted = useMemo(
    () => [...(txns ?? [])].sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1)),
    [txns]
  );
  const editingTxn = form.id == null ? undefined : sorted.find((t) => t.id === form.id);

  const set = (patch: Partial<TxnForm>) => setForm((f) => ({ ...f, ...patch }));
  const selAsset = form.asset_id !== "" ? assetById.get(form.asset_id) : undefined;
  const selectedCurrency = form.id ? form.paidCurrency : form.currency;

  // Market context (that day's close + FX) for money-based entry, and for
  // currency conversion of the edit form's price/total fields.
  useEffect(() => {
    ctxKey.current = null;
    setCtx(null);
    if (form.asset_id === "" || !/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return;
    const key = `${form.asset_id}:${form.date}`;
    let live = true;
    fetch(`/api/close?asset=${form.asset_id}&date=${form.date}`)
      .then((r) => r.json())
      .then((j) => {
        if (live && j && !j.error) {
          ctxKey.current = key;
          setCtx(j);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [form.asset_id, form.date, form.id]);

  // Show price/unit, fees and total in the selected currency. When the
  // transaction date's rates arrive (or the currency changes), convert
  // the displayed values in place; an unsupported pair falls back to the
  // asset's own currency. The DB stays canonical in the asset currency.
  useEffect(() => {
    if (!ctx || ctxKey.current !== `${form.asset_id}:${form.date}`) return;
    const assetCur = selAsset?.currency ?? "EUR";
    const target = convFactor(assetCur, selectedCurrency, ctx) != null ? selectedCurrency : assetCur;
    if (editCur.ppu === target && editCur.total === target) return;
    const fP = convFactor(editCur.ppu, target, ctx);
    const fT = convFactor(editCur.total, target, ctx);
    if (fP == null || fT == null) return;
    const conv = (s: string, f: number) => (s && isFinite(Number(s)) ? numStr(Number(s) * f) : s);
    const preserveAnchors = currencyChanged.current;
    currencyChanged.current = false;
    setEditCur({ ppu: target, total: target });
    setForm((f) => {
      const price = conv(f.price, fP);
      if (preserveAnchors) {
        const totalRaw = f.id ? f.paidAmount : f.amount;
        const total = Number(totalRaw);
        const fee = f.fees ? Number(f.fees) : 0;
        const ppu = Number(price);
        const net = total - feeSign(f.type) * fee;
        const ok = totalRaw !== "" && isFinite(total) && isFinite(fee) && ppu > 0 && net > 0;
        return { ...f, price, quantity: ok ? numStr(net / ppu) : f.quantity };
      }
      return {
        ...f,
        price,
        fees: conv(f.fees, fP),
        ...(f.id
          ? { paidAmount: conv(f.paidAmount, fT) }
          : { amount: conv(f.amount, fT) }),
      };
    });
  }, [ctx, selAsset, selectedCurrency, editCur]);

  // Add mode starts price/unit at that day's close. Edit mode does the same
  // only after the date is explicitly changed, preserving the stored price
  // when an edit is merely opened. Manual overrides are left alone.
  useEffect(() => {
    if (!ctx || !selAsset || form.asset_id === "" || ctxKey.current !== `${form.asset_id}:${form.date}`) return;
    if (form.id && !refreshEditPrice.current) return;
    const key = `${form.asset_id}:${form.date}:${form.type}`;
    if (!form.id && autoPriceKey.current === key) return;
    const marketPrice = selAsset.kind === "basket" && form.type === "sell" ? ctx.unitValue : ctx.price;
    if (marketPrice == null || marketPrice <= 0) return;
    const target = convFactor(ctx.currency, selectedCurrency, ctx) != null ? selectedCurrency : ctx.currency;
    const factor = convFactor(ctx.currency, target, ctx);
    if (factor == null) return;
    if (form.id) refreshEditPrice.current = false;
    else autoPriceKey.current = key;
    setEditCur({ ppu: target, total: target });
    setForm((f) => {
      const price = marketPrice * factor;
      const totalRaw = f.id ? f.paidAmount : f.amount;
      const total = Number(totalRaw);
      const fee = f.fees ? Number(f.fees) : 0;
      const net = total - feeSign(f.type) * fee;
      const hasQty = totalRaw !== "" && isFinite(total) && isFinite(fee) && net > 0;
      return { ...f, price: numStr(price), quantity: hasQty ? numStr(net / price) : "" };
    });
  }, [ctx, form.id, form.asset_id, form.date, form.type, form.price, selAsset, selectedCurrency]);

  // Total and fees are the anchor values: neither changes unless edited
  // directly. Total, fees and price/unit changes recompute quantity; a
  // quantity change recomputes price/unit.
  const editTotal = (raw: string) =>
    setForm((f) => {
      const total = Number(raw), ppu = Number(f.price), fee = f.fees ? Number(f.fees) : 0;
      const net = total - feeSign(f.type) * fee;
      const ok = raw !== "" && isFinite(total) && ppu > 0 && isFinite(fee) && net > 0;
      return {
        ...f,
        ...(f.id ? { paidAmount: raw } : { amount: raw }),
        quantity: ok ? numStr(net / ppu) : f.quantity,
      };
    });
  const editQty = (raw: string) =>
    setForm((f) => {
      const totalRaw = f.id ? f.paidAmount : f.amount;
      const qty = Number(raw), total = Number(totalRaw), fee = f.fees ? Number(f.fees) : 0;
      const net = total - feeSign(f.type) * fee;
      const ok = raw !== "" && qty > 0 && totalRaw !== "" && isFinite(total) && isFinite(fee) && net > 0;
      return { ...f, quantity: raw, price: ok ? numStr(net / qty) : f.price };
    });
  const editPpu = (raw: string) =>
    setForm((f) => {
      const totalRaw = f.id ? f.paidAmount : f.amount;
      const ppu = Number(raw), total = Number(totalRaw), fee = f.fees ? Number(f.fees) : 0;
      const net = total - feeSign(f.type) * fee;
      const ok = raw !== "" && ppu > 0 && totalRaw !== "" && isFinite(total) && isFinite(fee) && net > 0;
      return { ...f, price: raw, quantity: ok ? numStr(net / ppu) : f.quantity };
    });
  const editFees = (raw: string) =>
    setForm((f) => {
      const totalRaw = f.id ? f.paidAmount : f.amount;
      const fee = raw ? Number(raw) : 0, total = Number(totalRaw), ppu = Number(f.price);
      const net = total - feeSign(f.type) * fee;
      const ok = isFinite(fee) && fee >= 0 && totalRaw !== "" && isFinite(total) && ppu > 0 && net > 0;
      return { ...f, fees: raw, quantity: ok ? numStr(net / ppu) : f.quantity };
    });

  const submit = async () => {
    setMsg(null);
    const totalRaw = form.id ? form.paidAmount : form.amount;
    if (form.asset_id === "" || !form.quantity || !form.price || (!form.id && !totalRaw)) {
      setMsg("Asset, total, quantity and price are required.");
      return;
    }
    // Displayed price/fees are in editCur.ppu — convert back to the asset
    // currency at the transaction date's rate before storing.
    const assetCur = selAsset?.currency ?? "EUR";
    const back = editCur.ppu === assetCur ? 1 : ctx ? convFactor(editCur.ppu, assetCur, ctx) : null;
    if (back == null) {
      setMsg("Waiting for that day's exchange rate — try again in a second.");
      return;
    }
    const body: Record<string, unknown> = {
      asset_id: form.asset_id,
      type: form.type,
      date: form.date,
      quantity: Number(form.quantity),
      price: Number(form.price) * back,
      fees: form.fees ? Number(form.fees) * back : 0,
      note: form.note || null,
      paid_amount: totalRaw ? Number(totalRaw) : null,
      paid_currency: totalRaw ? editCur.total : null,
    };
    setBusy(true);
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
    autoPriceKey.current = null;
    currencyChanged.current = false;
    setEditCur({ ppu: form.currency, total: form.currency });
    setForm(emptyForm(form.asset_id, form.currency));
    reloadTxns();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this transaction?")) return;
    await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    reloadTxns();
  };

  const startEdit = (t: Txn) => {
    const assetCur = assetById.get(t.asset_id)?.currency ?? "EUR";
    // Price and fees start in the asset currency (as stored), the total in its
    // paid currency; the rebase effect converts everything to the paid
    // currency once that date's rates arrive.
    refreshEditPrice.current = false;
    currencyChanged.current = false;
    setEditCur({ ppu: assetCur, total: t.paid_currency ?? assetCur });
    setForm({
      id: t.id,
      asset_id: t.asset_id,
      type: t.type,
      date: t.date,
      amount: "",
      currency: assetCur,
      quantity: String(t.quantity),
      price: String(t.price),
      fees: t.fees ? String(t.fees) : "",
      note: t.note ?? "",
      paidAmount:
        t.paid_amount != null
          ? String(t.paid_amount)
          : numStr(t.quantity * t.price + (t.type === "buy" ? 1 : -1) * t.fees),
      paidCurrency: t.paid_currency ?? assetCur,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Deep link from an asset page: /transactions?edit=<txnId> opens that
  // transaction in the editor once the data arrives, then drops the param
  // so a refresh doesn't re-open it. Consumed at most once per mount.
  const consumedEditParam = useRef(false);
  useEffect(() => {
    if (consumedEditParam.current) return;
    const idStr = searchParams.get("edit");
    if (!idStr) return;
    if (!txns || !assets) return; // startEdit needs the asset's currency
    consumedEditParam.current = true;
    const t = txns.find((x) => x.id === Number(idStr));
    if (t) startEdit(t);
    router.replace("/transactions", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startEdit is stable in behavior
  }, [searchParams, txns, assets, router]);

  // Reset the add form to its pristine state (same path a successful submit takes).
  const clearForm = () => {
    autoPriceKey.current = null;
    currencyChanged.current = false;
    refreshEditPrice.current = false;
    setEditCur({ ppu: "EUR", total: "EUR" });
    setForm(emptyForm());
    setMsg(null);
  };

  const currencyOptions = useMemo(() => {
    const base = selAsset ? selAsset.currency : "EUR";
    return [...new Set([base, "EUR", "USD", "GBP"])];
  }, [selAsset]);

  const pickAsset = (id: number | "") => {
    const a = id === "" ? undefined : assetById.get(id);
    if (form.id) {
      set({ asset_id: id });
      return;
    }
    const currency = a?.currency ?? "EUR";
    autoPriceKey.current = null;
    currencyChanged.current = false;
    setEditCur({ ppu: currency, total: currency });
    set({ asset_id: id, currency, quantity: "", price: "" });
  };

  const changeDate = (date: string) => {
    if (!form.id) {
      autoPriceKey.current = null;
      set({ date, quantity: "", price: "" });
    } else {
      refreshEditPrice.current = true;
      set({ date });
    }
  };

  const changeType = (type: TxnType) => {
    if (!form.id) {
      autoPriceKey.current = null;
      set({ type, quantity: "", price: "" });
    } else {
      setForm((f) => {
        const total = Number(f.paidAmount);
        const fee = f.fees ? Number(f.fees) : 0;
        const ppu = Number(f.price);
        const net = total - feeSign(type) * fee;
        const ok = f.paidAmount !== "" && isFinite(total) && isFinite(fee) && ppu > 0 && net > 0;
        return { ...f, type, quantity: ok ? numStr(net / ppu) : f.quantity };
      });
    }
  };

  const changeCurrency = (currency: string) => {
    currencyChanged.current = true;
    set(form.id ? { paidCurrency: currency } : { currency });
  };

  return (
    <div className="space-y-6">
      {/* Add / edit form */}
      <div className="rounded-lg border border-line bg-surface p-3 md:p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink2">{form.id ? "Edit transaction" : "Add transaction"}</h2>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <label className="col-span-2 block text-xs md:col-span-2">
            <span className="text-muted">Asset</span>
            <select
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.asset_id}
              onChange={(e) => pickAsset(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Choose…</option>
              {(assets ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {assetLabel(a, mobile)} {a.kind === "basket" ? "(basket)" : `(${a.symbol})`}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted">Date</span>
            <input
              type="date"
              max={todayISO()}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.date}
              onChange={(e) => changeDate(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Type</span>
            <select
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.type}
              onChange={(e) => changeType(e.target.value as TxnType)}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-muted">{form.type === "buy" ? "Total paid" : "Total received"}</span>
            <input
              type="number" step="any" min="0" inputMode="decimal" placeholder={form.id ? undefined : "500"}
              className="no-spinner mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.id ? form.paidAmount : form.amount}
              onChange={(e) => editTotal(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Fees</span>
            <input
              type="number" step="any" min="0" inputMode="decimal" placeholder="0"
              className="no-spinner mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.fees}
              onChange={(e) => editFees(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Price / unit</span>
            <input
              type="number" step="any" min="0" inputMode="decimal"
              className="no-spinner mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
              value={form.price}
              onChange={(e) => editPpu(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block text-xs">
              <span className="text-muted">Currency</span>
              <select
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
                value={selectedCurrency}
                onChange={(e) => changeCurrency(e.target.value)}
              >
                {[...new Set([...currencyOptions, selectedCurrency])].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="text-muted">Quantity</span>
              <input
                type="number" step="any" min="0" inputMode="decimal"
                className="no-spinner mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm"
                value={form.quantity}
                onChange={(e) => editQty(e.target.value)}
              />
            </label>
          </div>
          <label className="col-span-2 block text-xs md:col-span-2">
            <span className="text-muted">Note</span>
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
          {!form.id && (
            <button type="button" onClick={clearForm} className="rounded-md border border-line px-3 py-2 text-sm text-ink2">
              Clear
            </button>
          )}
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
        {editingTxn && (
          <div className="mb-4">
            <TransactionRow
              txn={editingTxn}
              asset={assetById.get(editingTxn.asset_id)}
              dark={dark}
              mobile={mobile}
              editing
              onEdit={() => {}}
              onRemove={() => {}}
            />
          </div>
        )}
        <h2 className="mb-2 text-sm font-semibold text-ink2">History ({sorted.length})</h2>
        {sorted.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {sorted.map((t) => (
              <TransactionRow
                key={t.id}
                txn={t}
                asset={assetById.get(t.asset_id)}
                dark={dark}
                mobile={mobile}
                editing={t.id === form.id}
                onEdit={() => startEdit(t)}
                onRemove={() => remove(t.id)}
              />
            ))}
          </div>
        )}
      </section>

      <AssetManager assets={assets ?? []} onChanged={() => { reloadAssets(); reloadTxns(); }} dark={dark} />
    </div>
  );
}

// ---------- asset management ----------

function AssetManager({ assets, onChanged, dark }: { assets: Asset[]; onChanged: () => void; dark: boolean }) {
  const search = useSymbolSearch();
  const [err, setErr] = useState<string | null>(null);
  const [openBasket, setOpenBasket] = useState<number | null>(null);
  const [newBasket, setNewBasket] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftShort, setDraftShort] = useState("");

  // Display in the fixed category order (DB order within a category).
  const catOrder = new Map(CATEGORIES.map((c, i) => [c.key, i]));
  const sortedAssets = [...assets].sort(
    (a, b) => (catOrder.get(a.category) ?? 99) - (catOrder.get(b.category) ?? 99)
  );

  const add = async (r: SearchResult) => {
    setErr(null);
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: r.symbol, name: r.name, category: inferCategory(r.type) }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setErr(j?.error || "Failed to add asset.");
      return;
    }
    search.clear();
    onChanged();
  };

  const createBasket = async () => {
    const name = newBasket.trim();
    if (!name) return;
    setErr(null);
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "basket", name, category: "arg_stock" }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setErr(j?.error || "Failed to create basket.");
      return;
    }
    setNewBasket("");
    onChanged();
  };

  const startEdit = (a: Asset) => {
    setEditingId(a.id);
    setDraftName(a.name);
    setDraftShort(a.short_name ?? "");
  };

  const saveEdit = async (a: Asset) => {
    const name = draftName.trim();
    const short = draftShort.trim() || null;
    if (!name) return;
    if (name === a.name && short === (a.short_name ?? null)) {
      setEditingId(null);
      return;
    }
    setErr(null);
    const res = await fetch(`/api/assets/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, short_name: short }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setErr(j?.error || "Failed to rename.");
      return;
    }
    setEditingId(null);
    onChanged();
  };

  const remove = async (a: Asset) => {
    if (!confirm(`Remove ${a.name}${a.kind === "basket" ? " (basket)" : ` (${a.symbol})`}?`)) return;
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
          {sortedAssets.map((a) =>
            editingId === a.id ? (
              <span key={a.id} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(a.category, dark) }} />
                <input
                  type="text"
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(a);
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                  placeholder="Name"
                  className="w-44 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                />
                <input
                  type="text"
                  value={draftShort}
                  onChange={(e) => setDraftShort(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(a);
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                  placeholder="Short name (optional)"
                  className="w-40 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                />
                <button onClick={() => saveEdit(a)} className="rounded-md border border-line px-2 py-1 text-ink2">Save</button>
                <button onClick={() => setEditingId(null)} className="text-muted hover:text-ink2">Cancel</button>
              </span>
            ) : (
              <span key={a.id} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(a.category, dark) }} />
                <span className="font-medium">{a.name}</span>
                {a.short_name && <span className="text-ink2">{a.short_name}</span>}
                <span className="text-muted">{a.kind === "basket" ? "Basket" : a.symbol}</span>
                {a.kind === "basket" && (
                  <button
                    onClick={() => setOpenBasket(openBasket === a.id ? null : a.id)}
                    className="ml-1 text-accent"
                    title="Edit components"
                  >
                    ☰
                  </button>
                )}
                <button onClick={() => startEdit(a)} className="ml-1 text-accent" title="Rename">✎</button>
                <button onClick={() => remove(a)} className="text-muted hover:text-down" title="Remove (only without transactions)">✕</button>
              </span>
            )
          )}
        </div>

        {openBasket != null && (
          <BasketEditor
            basket={assets.find((a) => a.id === openBasket) ?? null}
            onClose={() => setOpenBasket(null)}
          />
        )}

        <div className="mt-3 border-t border-line pt-3">
          <SymbolSearch label="New asset " search={search} onPick={add} />
          {err && <p className="mt-1 text-xs text-down">{err}</p>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
          <span className="text-muted">New basket (equal parts per buy):</span>
          <input
            type="text"
            value={newBasket}
            onChange={(e) => setNewBasket(e.target.value)}
            placeholder="e.g. Colección Tech"
            className="rounded-md border border-line bg-surface px-2 py-1.5"
          />
          <button onClick={createBasket} className="rounded-md border border-line px-3 py-1.5 text-ink2">Create</button>
        </div>
      </div>
    </section>
  );
}

function BasketEditor({ basket, onClose }: { basket: Asset | null; onClose: () => void }) {
  const { data: comps, reload } = useJson<BasketComponent[]>(
    basket ? `/api/assets/${basket.id}/components` : ""
  );
  const search = useSymbolSearch();
  const [err, setErr] = useState<string | null>(null);

  if (!basket) return null;

  const removeComp = async (symbol: string) => {
    await fetch(`/api/assets/${basket.id}/components?symbol=${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    });
    reload();
  };

  const addComp = async (r: SearchResult) => {
    setErr(null);
    const res = await fetch(`/api/assets/${basket.id}/components`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: r.symbol, name: r.name }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setErr(j?.error || "Failed to add component.");
      return;
    }
    search.clear();
    reload();
  };

  return (
    <div className="mt-3 rounded-md border border-line p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold">{basket.name} — components</span>
        <button onClick={onClose} className="text-muted hover:text-ink2">Close ✕</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(comps ?? []).map((c) => (
          <span key={c.id} className="flex items-center gap-1.5 rounded-md border border-line/70 px-2 py-1 text-xs">
            <span className="font-medium">{c.symbol}</span>
            <span className="text-muted">{c.name}</span>
            <button onClick={() => removeComp(c.symbol)} className="text-muted hover:text-down" title="Remove component">✕</button>
          </span>
        ))}
        {comps && comps.length === 0 && <span className="text-xs text-muted">No components yet.</span>}
      </div>
      <div className="mt-2">
        <SymbolSearch label="New component " search={search} onPick={addComp} />
        {err && <p className="mt-1 text-xs text-down">{err}</p>}
      </div>
    </div>
  );
}
