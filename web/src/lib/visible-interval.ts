"use client";
/**
 * setInterval that pauses while the tab is hidden (no API calls from background tabs) and runs once
 * immediately when the tab becomes visible again. Returns a cleanup function.
 */
export function visibleInterval(tick: () => void, ms: number): () => void {
  const t = setInterval(() => {
    if (typeof document === "undefined" || !document.hidden) tick();
  }, ms);
  const onVis = () => {
    if (!document.hidden) tick();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  return () => {
    clearInterval(t);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  };
}
