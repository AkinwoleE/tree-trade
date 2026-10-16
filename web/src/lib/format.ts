export const fmtUsd = (n: number | undefined, digits = 2) =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtNum = (n: number | undefined, digits = 2) =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export const fmtPx = (n: number | undefined) => fmtUsd(n, n !== undefined && n < 10 ? 4 : 2);
