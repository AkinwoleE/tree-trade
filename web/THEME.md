# Tree Trade themes

Light (default unless the OS prefers dark): the warm "paper" palette in `src/app/globals.css` `@theme`.
Dark: APTree's dark palette, taken verbatim from the `.dark { … }` CSS variable block in aptree.io's
stylesheet `https://aptree.io/_next/static/css/d014782f15713d5f.css` / `c38187bbd71ac05a.css` (fetched 2026-10-15, shadcn-style tokens).

| Role | aptree.io variable | Hex |
|---|---|---|
| Page background | `--background` | `#0a0f0a` |
| Cards / popovers | `--card`, `--popover` | `#061408` |
| Secondary surface / hover / muted | `--secondary`, `--muted`, `--accent` | `#1a2e1a` |
| Border | `--border` | `#6ee7b733` (solid ≈ `#1a2e1a`–`#24402c` used) |
| Text primary | `--foreground`, `--text-primary` | `#f0fdf4` |
| Text secondary | `--text-secondary` / `--muted-foreground` | `#f0fdf4b3` / `#9ca3af` |
| Primary | `--primary` / `--primary-dark` | `#4ade80` / `#22c55e` |
| Accent | `--accent-1` / `--accent-2` (also `--ring`) | `#6ee7b7` / `#34d399` |
| Text on primary | `--primary-foreground` | `#0a0f0a` |
| Success / up | `--accent-2` / chart-3 | `#34d399` / `#10b981` |
| Danger | `--error` / `--destructive` | `#ef4444` / `#dc2626` (text `#f87171`) |
| Chart greens | `--chart-1..5` | `#6ee7b7 #34d399 #10b981 #059669 #047857` |

aptree.io's light `:root` (for reference): bg `#fff`, text `#111214`, primary `#00a86b`, accent `#00c278`, border `#e5e7eb`.
aptree.io ships `<html lang="en">` without `.dark`, i.e. it defaults to light — so Tree Trade keeps light as default.

Mechanism: `html.dark` overrides the remapped Tailwind zinc/indigo/emerald/rose/amber variables; an inline
script in `layout.tsx` applies the stored choice (`localStorage["treetrade-theme"]`) or `prefers-color-scheme`
before paint. Charts read `CHART[theme]` from `src/lib/theme.tsx`.
