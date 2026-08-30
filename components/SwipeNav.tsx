"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

// Same order as the tab bar in Nav.tsx.
const TABS = ["/", "/charts", "/capital", "/transactions"];

/** Horizontal swipe anywhere on the page switches to the adjacent tab. */
export default function SwipeNav() {
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    const idx =
      path === "/" || path.startsWith("/asset")
        ? 0
        : TABS.findIndex((t) => t !== "/" && path.startsWith(t));
    if (idx < 0) return;

    let st: { x: number; y: number } | null = null;

    const onStart = (e: TouchEvent) => {
      st = null;
      if (e.touches.length !== 1) return;
      const t = e.target;
      if (t instanceof Element) {
        // Charts own horizontal drags (zoom), and horizontally scrollable
        // regions (tables) own their swipes.
        if (t.closest(".touch-pan-y, .recharts-wrapper")) return;
        for (let el: Element | null = t; el && el !== document.body; el = el.parentElement) {
          if (el.scrollWidth > el.clientWidth + 1) {
            const ox = getComputedStyle(el).overflowX;
            if (ox === "auto" || ox === "scroll") return;
          }
        }
      }
      st = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const onEnd = (e: TouchEvent) => {
      const s = st;
      st = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      // A deliberate horizontal swipe: long enough and clearly not a scroll.
      if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
      const next = TABS[idx + (dx < 0 ? 1 : -1)];
      if (next) router.push(next);
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [path, router]);

  return null;
}
