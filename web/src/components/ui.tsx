"use client";

import { useState, type ReactNode } from "react";

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="font-mono text-lg">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

/** Amount input with any number of action buttons that receive the parsed amount. */
export function AmountForm({
  placeholder,
  max,
  actions,
  disabled,
}: {
  placeholder: string;
  max?: number;
  actions: { label: string; onClick: (amount: number) => void; primary?: boolean }[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const amount = Number(value);
  const valid = value !== "" && Number.isFinite(amount) && amount > 0;
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input
          className="input pr-12"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        {max !== undefined && max > 0 && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-indigo-400 hover:text-indigo-300"
            onClick={() => setValue(String(max))}
          >
            MAX
          </button>
        )}
      </div>
      {actions.map((a) => (
        <button
          key={a.label}
          className={`btn ${a.primary ? "btn-primary" : "btn-ghost"}`}
          disabled={disabled || !valid}
          onClick={() => {
            a.onClick(amount);
            setValue("");
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
