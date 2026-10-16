import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/Shell";
import { THEME_INIT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Tree Trade by APTree — Aptos testnet perps",
  description: "Tree Trade: BTC/ETH perps up to 1000x on Aptos testnet, with optional hedging on Decibel",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
