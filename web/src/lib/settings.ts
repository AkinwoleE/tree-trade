"use client";
import { useEffect, useState } from "react";

export interface Settings { showEntries: boolean; showBusts: boolean }
const KEY = "treetrade.settings";
const DEF: Settings = { showEntries: true, showBusts: true };
const read = (): Settings => {
  try {
    return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEF;
  }
};

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(DEF);
  useEffect(() => {
    setS(read());
    const on = () => setS(read());
    window.addEventListener("treetrade-settings", on);
    return () => window.removeEventListener("treetrade-settings", on);
  }, []);
  const update = (p: Partial<Settings>) => {
    const n = { ...read(), ...p };
    localStorage.setItem(KEY, JSON.stringify(n));
    window.dispatchEvent(new Event("treetrade-settings"));
  };
  return [s, update];
}
