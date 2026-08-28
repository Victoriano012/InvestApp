"use client";

import { useCallback, useEffect, useState } from "react";

/** Tracks prefers-color-scheme so charts can pick the right palette steps. */
export function useDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const fn = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return dark;
}

/** Phone-sized viewport (Tailwind's sm breakpoint) — picks short asset names. */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    setMobile(mq.matches);
    const fn = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return mobile;
}

export type ValueMode = "abs" | "pct";

/** Global €/% display toggle, shared across pages via localStorage. */
export function useValueMode(): [ValueMode, () => void] {
  const [mode, setMode] = useState<ValueMode>("abs");
  useEffect(() => {
    try {
      const v = localStorage.getItem("investapp.valueMode");
      if (v === "pct" || v === "abs") setMode(v);
    } catch {
      /* default */
    }
  }, []);
  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === "abs" ? "pct" : "abs";
      try {
        localStorage.setItem("investapp.valueMode", next);
      } catch {
        /* fine */
      }
      return next;
    });
  }, []);
  return [mode, toggle];
}

export function useJson<T>(url: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setError(null);
    fetch(url)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || r.statusText);
        if (alive) setData(j);
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}
