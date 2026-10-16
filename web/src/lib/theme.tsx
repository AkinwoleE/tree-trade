"use client";
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "treetrade-theme";

/** Inline script run before paint: localStorage choice, else prefers-color-scheme. */
export const THEME_INIT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var d=document.documentElement;d.classList.toggle("dark",t==="dark");d.style.colorScheme=t;}catch(e){}})();`;

const read = (): Theme => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light");

export function setTheme(t: Theme) {
  const d = document.documentElement;
  d.classList.toggle("dark", t === "dark");
  d.style.colorScheme = t;
  try { localStorage.setItem(KEY, t); } catch {}
}

/** Current theme; re-renders when the html.dark class changes. */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>("light");
  useEffect(() => {
    setT(read());
    const o = new MutationObserver(() => setT(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return t;
}

/** Chart palettes (lightweight-charts can't read CSS variables). */
export const CHART = {
  light: { bg: "#f4ecdc", ink: "#1c1a17", fill: "rgba(28,26,23,0.07)", fill2: "rgba(28,26,23,0.02)", grid: "rgba(28,26,23,0.07)", text: "#6b6458", cross: "rgba(28,26,23,0.35)", mark: "rgba(28,26,23,0.06)", pline: "rgba(28,26,23,0.45)", up: "#2f7d4f", down: "#a3302a", bust: "#b7791f", labelText: "#fffaf0", line: "#2f7d4f", border: "#d6c9b0" },
  dark: { bg: "#061408", ink: "#6ee7b7", fill: "rgba(110,231,183,0.14)", fill2: "rgba(110,231,183,0.01)", grid: "rgba(110,231,183,0.07)", text: "#9ca3af", cross: "rgba(240,253,244,0.35)", mark: "rgba(110,231,183,0.06)", pline: "rgba(240,253,244,0.45)", up: "#34d399", down: "#f87171", bust: "#fbbf24", labelText: "#0a0f0a", line: "#6ee7b7", border: "#1a2e1a" },
} as const;
