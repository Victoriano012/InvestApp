"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { prefetchJson } from "./hooks";

const ITEMS = [
  { href: "/", label: "Portfolio", icon: "M4 19h16M4 15l4-6 4 3 4-7 4 5" },
  { href: "/charts", label: "Charts", icon: "M4 20V10m5.5 10V4M15 20v-8m5 8V7" },
  { href: "/capital", label: "Capital", icon: "M4 4v16h16M8 16v-5m4 5V8m4 8v-3" },
  { href: "/transactions", label: "Activity", icon: "M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3-3m-3 3 3 3" },
];

export default function Nav() {
  const path = usePathname();
  // Warm the other tabs' data shortly after load so switching is instant.
  useEffect(() => {
    const t = setTimeout(
      () => prefetchJson(["/api/portfolio", "/api/series", "/api/capital", "/api/transactions", "/api/assets"]),
      1500
    );
    return () => clearTimeout(t);
  }, []);
  const active = (href: string) =>
    href === "/" ? path === "/" || path.startsWith("/asset") : path.startsWith(href);

  // Mobile header title = the active tab (asset pages belong to Portfolio).
  const title = ITEMS.find((it) => active(it.href))?.label ?? "InvestApp";

  return (
    <>
      {/* Mobile: the current tab's title as a large heading that scrolls with the page */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>

      {/* Desktop top bar */}
      <header className="hidden md:block sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-2">
          <Link href="/" className="mr-4 text-base font-semibold tracking-tight">
            InvestApp
          </Link>
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active(it.href) ? "bg-accent/10 font-medium text-accent" : "text-ink2 hover:bg-line/40"
              }`}
            >
              {it.label}
            </Link>
          ))}
          <a href="/api/auth/signout" className="ml-auto text-xs text-muted hover:text-ink2">
            Sign out
          </a>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface md:hidden pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-4">
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${
                active(it.href) ? "font-medium text-accent" : "text-muted"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={it.icon} />
              </svg>
              {it.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}
