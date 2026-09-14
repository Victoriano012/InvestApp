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

// Last good response per URL, so returning to a tab renders instantly with
// the previous data while a fresh copy loads in the background.
const jsonCache = new Map<string, unknown>();
// One request per URL at a time: useJson and prefetchJson join the same promise.
const inflight = new Map<string, Promise<unknown>>();

// Resolves once the first useJson request on the page has settled, so
// background prefetches don't compete with the first paint.
let firstLoaded: (() => void) | undefined;
export const afterFirstLoad = new Promise<void>((r) => (firstLoaded = r));

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || r.statusText);
  return j;
}

/**
 * Fetch `url` (joining an in-flight request if any) and cache the result.
 * The API answers from its market-data cache with `stale: true` when a
 * refresh is available; then `onStale` gets the cached copy right away and
 * the promise resolves with the `?fresh=1` follow-up a few seconds later.
 */
function load(url: string, onStale?: (j: unknown) => void): Promise<unknown> {
  const hit = inflight.get(url);
  if (hit) return hit;
  const p = fetchJson(url)
    .then(async (j) => {
      jsonCache.set(url, j);
      if (!(j && typeof j === "object" && (j as { stale?: unknown }).stale === true)) return j;
      onStale?.(j);
      const fresh = await fetchJson(url + (url.includes("?") ? "&" : "?") + "fresh=1").catch(() => j);
      jsonCache.set(url, fresh);
      return fresh;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** Warm the cache for other tabs (fills only missing entries). */
export function prefetchJson(urls: string[]): void {
  for (const url of urls) {
    if (jsonCache.has(url) || inflight.has(url)) continue;
    load(url).catch(() => {
      /* it'll load on visit */
    });
  }
}

export function useJson<T>(url: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(() => (jsonCache.get(url) as T | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setError(null);
    // Stale-while-revalidate: show the cached copy (or a loading state when
    // there is none), then always fetch fresh.
    setData(((jsonCache.get(url) as T | undefined) ?? null) as T | null);
    load(url, (j) => alive && setData(j as T))
      .then((j) => alive && setData(j as T))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => firstLoaded?.());
    return () => {
      alive = false;
    };
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}
