import WebSocket from "ws";
import { countUpstream, decibelApiKey } from "@/lib/api-keys";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";

/**
 * Server-Sent Events relay of live BTC/ETH prices. Upstream is Decibel's testnet WebSocket
 * (market_price + top-of-book depth), authenticated server-side so the key never reaches the browser.
 * Each connection lives ~50 s (serverless limit); EventSource reconnects automatically (retry: 500 ms).
 * Without a key, or if the socket fails, it falls back to polling the public market feed once a second.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const KEY = decibelApiKey();
const WS_URL = "wss://api.testnet.aptoslabs.com/decibel/ws";
const REST = "https://api.testnet.aptoslabs.com/decibel/api/v1";
const LIFETIME_MS = 50_000;

let marketAddrs: Promise<Record<string, MarketSymbol>> | undefined;
function addrs(): Promise<Record<string, MarketSymbol>> {
  marketAddrs ??= fetch(`${REST}/markets`, { headers: { authorization: `Bearer ${KEY}` } })
    .then((r) => r.json())
    .then((ms: { market_name: string; market_addr: string }[]) => {
      const out: Record<string, MarketSymbol> = {};
      for (const m of ms) {
        const sym = m.market_name?.split("/")[0] as MarketSymbol;
        if (MARKET_SYMBOLS.includes(sym) && m.market_name.endsWith("/USD")) out[m.market_addr.toLowerCase()] = sym;
      }
      return out;
    })
    .catch((e) => {
      marketAddrs = undefined;
      throw e;
    });
  return marketAddrs;
}

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let closed = false;
  let ws: WebSocket | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let end: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (s: string) => {
        if (!closed) ctrl.enqueue(enc.encode(s));
      };
      const tick = (s: MarketSymbol, p: number, t = Date.now()) => {
        if (Number.isFinite(p) && p > 0) send(`data: ${JSON.stringify({ s, p, t })}\n\n`);
      };
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(ping);
        clearTimeout(end);
        try {
          ws?.close();
        } catch {}
        try {
          ctrl.close();
        } catch {}
      };
      req.signal.addEventListener("abort", stop);
      send("retry: 500\n\n");
      ping = setInterval(() => send(": ping\n\n"), 15_000);
      end = setTimeout(stop, LIFETIME_MS);

      const fallback = () => {
        if (poll || closed) return;
        send(`event: source\ndata: "market feed"\n\n`);
        poll = setInterval(async () => {
          try {
            const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
            const mids = (await r.json()) as Record<string, string>;
            for (const s of MARKET_SYMBOLS) if (mids[s]) tick(s, Number(mids[s]));
          } catch {}
        }, 1000);
      };

      // Prefer the top-of-book mid (like a BBO mid); use the mark only when depth has gone quiet.
      const lastDepth: Partial<Record<MarketSymbol, number>> = {};
      if (!KEY) return fallback();
      try {
        const map = await addrs();
        countUpstream("decibel_ws");
        ws = new WebSocket(WS_URL, ["decibel", KEY]);
        ws.on("open", () => {
          send(`event: source\ndata: "Decibel"\n\n`);
          for (const a of Object.keys(map)) {
            ws!.send(JSON.stringify({ Subscribe: { topic: `market_price:${a}` } }));
            ws!.send(JSON.stringify({ Subscribe: { topic: `depth:${a}:1` } }));
          }
        });
        ws.on("message", (raw) => {
          try {
            const j = JSON.parse(String(raw));
            const topic: string = j.topic ?? "";
            if (topic.startsWith("market_price:")) {
              const s = map[String(j.price?.market).toLowerCase()];
              if (s && Date.now() - (lastDepth[s] ?? 0) > 3000) tick(s, Number(j.price.mid_px ?? j.price.mark_px));
            } else if (topic.startsWith("depth:")) {
              const s = map[String(j.market).toLowerCase()];
              const bid = Number(j.bids?.[0]?.price), ask = Number(j.asks?.[0]?.price);
              if (s && bid > 0 && ask > 0) {
                lastDepth[s] = Date.now();
                tick(s, (bid + ask) / 2);
              }
            }
          } catch {}
        });
        ws.on("error", fallback);
        ws.on("close", () => !closed && fallback());
      } catch {
        fallback();
      }
    },
    cancel() {
      closed = true;
      clearInterval(poll);
      clearInterval(ping);
      clearTimeout(end);
      try {
        ws?.close();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
