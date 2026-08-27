import type { Category } from "./types";

/**
 * Validated categorical palette (adjacent-pair CVD-safe in this order, both modes).
 * Slot assignment is fixed by category: identity never repaints when filters change.
 * Assets within a category share the hue and differ by dash pattern + label.
 */
const LIGHT: Record<Category, string> = {
  etf: "#2a78d6", // blue
  us_stock: "#eb6834", // orange
  arg_stock: "#1baf7a", // aqua
  gold: "#eda100", // yellow
  crypto: "#e87ba4", // magenta
};

const DARK: Record<Category, string> = {
  etf: "#3987e5",
  us_stock: "#d95926",
  arg_stock: "#199e70",
  gold: "#c98500",
  crypto: "#d55181",
};

export function categoryColor(cat: Category, dark: boolean): string {
  return dark ? DARK[cat] : LIGHT[cat];
}

/** Dash patterns for assets sharing a category hue (index = order within category). */
export const DASHES = ["", "7 4", "2 3", "11 4 2 4"];

export function dashFor(i: number): string | undefined {
  const d = DASHES[i % DASHES.length];
  return d === "" ? undefined : d;
}

export interface ChartChrome {
  surface: string;
  ink: string;
  inkSecondary: string;
  muted: string;
  grid: string;
  axis: string;
  up: string;
  down: string;
}

export function chrome(dark: boolean): ChartChrome {
  return dark
    ? {
        surface: "#1a1a19",
        ink: "#ffffff",
        inkSecondary: "#c3c2b7",
        muted: "#898781",
        grid: "#2c2c2a",
        axis: "#383835",
        up: "#0ca30c",
        down: "#e66767",
      }
    : {
        surface: "#fcfcfb",
        ink: "#0b0b0b",
        inkSecondary: "#52514e",
        muted: "#898781",
        grid: "#e1e0d9",
        axis: "#c3c2b7",
        up: "#006300",
        down: "#d03b3b",
      };
}
