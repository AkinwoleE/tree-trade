/**
 * Decibel access for the hedger, behind one interface so the sync logic runs against either
 *  - LiveDecibelClient: writes via @decibeltrade/sdk DecibelWriteDex.placeOrder, reads via fullnode view functions
 *    (no Geomi key needed; probed on testnet, see HEDGE_DESIGN.md), or
 *  - MockDecibelClient: in-memory book with async fills, partial fills and injectable failures.
 */
import { countingClient } from "../usage";
import { Aptos, AptosConfig, Network, type Account } from "@aptos-labs/ts-sdk";
import { DecibelWriteDex, TimeInForce, getMarketAddr, type DecibelConfig } from "@decibeltrade/sdk";
import { delegationFor, type DelegationStatus, type MarketSpec } from "../../../web/src/lib/hedge";

export interface DecibelPosition {
  /** signed size units, positive = long */
  size: bigint;
  /** average entry, price units (6 dp); 0 when flat */
  entryPx: bigint;
  /** accrued funding cost in USDC raw, positive = cost (perp_engine::get_position_unrealized_funding_cost) */
  fundingCost: bigint;
}

export interface OrderRequest {
  subaccount: string;
  market: MarketSpec;
  isBuy: boolean;
  size: bigint;
  price: bigint;
  reduceOnly: boolean;
  clientOrderId: string;
}

/** `unknown`: the transaction may have been submitted (e.g. the wait timed out); do not resubmit blindly. */
export type OrderResult = { ok: true; orderId?: string; txHash: string } | { ok: false; error: string; unknown?: boolean };

/** Bound on placeOrder (build, sign, submit, wait); the SDK's wait has no overall timeout. */
const PLACE_TIMEOUT_MS = 45_000;

export interface DecibelClient {
  readonly mode: "live" | "mock";
  /** address the hedger signs with (users delegate to it) */
  readonly hedgerAddress: string;
  marketSpec(name: string): Promise<MarketSpec>;
  markPrice(market: MarketSpec): Promise<bigint>;
  position(subaccount: string, market: MarketSpec): Promise<DecibelPosition>;
  delegation(subaccount: string, market: MarketSpec): Promise<DelegationStatus>;
  /** true while an order is still resting or queued for async matching */
  orderPending(market: MarketSpec, orderId: string): Promise<boolean>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

export class LiveDecibelClient implements DecibelClient {
  readonly mode = "live" as const;
  readonly hedgerAddress: string;
  private readonly aptos: Aptos;
  private readonly write: DecibelWriteDex;
  private readonly pkg: string;
  private readonly specs = new Map<string, MarketSpec>();
  /** funding accrues slowly; refresh it at most once a minute per position */
  private readonly funding = new Map<string, { at: number; v: bigint }>();

  constructor(private readonly cfg: DecibelConfig, signer: Account, nodeApiKey?: string) {
    this.hedgerAddress = signer.accountAddress.toString();
    this.pkg = cfg.deployment.package;
    this.aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: cfg.fullnodeUrl, client: countingClient(), clientConfig: nodeApiKey ? { API_KEY: nodeApiKey } : undefined }));
    // skipSimulate: with simulation the SDK reserves max(2x simulated max gas, 250k) gas units, more than a
    // small service balance can cover; without it the SDK's own 250k default applies.
    this.write = new DecibelWriteDex(cfg, signer, { nodeApiKey, skipSimulate: true });
  }

  private async view<T = unknown>(fn: string, args: unknown[]): Promise<T[]> {
    return (await this.aptos.view({
      payload: { function: `${this.pkg}::${fn}` as `${string}::${string}::${string}`, functionArguments: args as never[] },
    })) as T[];
  }

  /** Market parameters are static; read once per market (7 views) and cached. */
  async marketSpec(name: string): Promise<MarketSpec> {
    const hit = this.specs.get(name);
    if (hit) return hit;
    const addr = getMarketAddr(name, this.cfg.deployment.perpEngineGlobal).toString();
    const one = async (f: string) => (await this.view<string>(`perp_engine::${f}`, [addr]))[0];
    const [sz, lot, min, tick, lev, minPx, maxPx] = await Promise.all(
      ["market_sz_decimals", "market_lot_size", "market_min_size", "market_ticker_size", "market_max_leverage", "market_min_price", "market_max_price"].map(one),
    );
    const spec: MarketSpec = {
      name,
      addr,
      szDecimals: Number(sz),
      lotSize: BigInt(lot),
      minSize: BigInt(min),
      tickSize: BigInt(tick),
      maxLeverage: Number(lev),
      minPrice: BigInt(minPx),
      maxPrice: BigInt(maxPx),
    };
    this.specs.set(name, spec);
    return spec;
  }

  async markPrice(m: MarketSpec): Promise<bigint> {
    return BigInt((await this.view<string>("perp_engine::get_mark_price", [m.addr]))[0]);
  }

  async position(subaccount: string, m: MarketSpec): Promise<DecibelPosition> {
    const [opt] = await this.view<{ vec: { size: string; is_long: boolean; avg_acquire_entry_px: string }[] }>("perp_engine::view_position", [subaccount, m.addr]);
    const p = opt?.vec?.[0];
    if (!p || BigInt(p.size) === 0n) return { size: 0n, entryPx: 0n, fundingCost: 0n };
    const k = `${subaccount}|${m.addr}`;
    let f = this.funding.get(k);
    if (!f || Date.now() - f.at > 60_000) {
      const [v] = await this.view<string>("perp_engine::get_position_unrealized_funding_cost", [subaccount, m.addr]).catch(() => [String(f?.v ?? 0n)]);
      f = { at: Date.now(), v: BigInt(v) };
      this.funding.set(k, f);
    }
    const size = BigInt(p.size);
    return { size: p.is_long ? size : -size, entryPx: BigInt(p.avg_acquire_entry_px), fundingCost: f.v };
  }

  async delegation(subaccount: string, m: MarketSpec): Promise<DelegationStatus> {
    const [perms] = await this.view("dex_accounts::view_delegated_permissions", [subaccount]);
    return delegationFor(perms, this.hedgerAddress, m.addr, Math.floor(Date.now() / 1000));
  }

  async orderPending(m: MarketSpec, orderId: string): Promise<boolean> {
    const [rem] = await this.view<string>("perp_engine::get_remaining_size_for_order", [m.addr, orderId]);
    return BigInt(rem) > 0n;
  }

  async placeOrder(r: OrderRequest): Promise<OrderResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<OrderResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, unknown: true, error: `placeOrder timed out after ${PLACE_TIMEOUT_MS} ms; outcome unknown` }), PLACE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.place(r), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async place(r: OrderRequest): Promise<OrderResult> {
    try {
      const res = await this.write.placeOrder({
        marketName: r.market.name,
        price: Number(r.price),
        size: Number(r.size),
        isBuy: r.isBuy,
        timeInForce: TimeInForce.ImmediateOrCancel,
        isReduceOnly: r.reduceOnly,
        clientOrderId: r.clientOrderId,
        subaccountAddr: r.subaccount,
        tickSize: Number(r.market.tickSize),
      });
      return res.success ? { ok: true, orderId: res.orderId, txHash: res.transactionHash } : { ok: false, error: res.error };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mock                                                                */
/* ------------------------------------------------------------------ */

interface MockOrder {
  id: string;
  req: OrderRequest;
  /** ticks until matched */
  wait: number;
}

/**
 * In-memory Decibel stand-in. Orders are acknowledged immediately and filled on a later `step()`
 * (Decibel matching is asynchronous). `fillRatio` < 1 simulates IOC partial fills; `failNext` injects errors;
 * `delegated` controls the permission check.
 */
export class MockDecibelClient implements DecibelClient {
  readonly mode = "mock" as const;
  readonly hedgerAddress = "0x" + "4".repeat(64);
  positions = new Map<string, bigint>();
  marks = new Map<string, bigint>([
    ["BTC/USD", 81_000_000_000n],
    ["ETH/USD", 2_370_000_000n],
  ]);
  delegated = new Set<string>(); // `${subaccount}|${market}`
  orders: MockOrder[] = [];
  placed: OrderRequest[] = [];
  fillRatio = 1;
  fillDelay = 1;
  failNext: string[] = [];
  private seq = 0;

  static readonly SPECS: Record<string, MarketSpec> = {
    // Live testnet values (perp_engine views, 2026-10-15).
    "BTC/USD": { name: "BTC/USD", addr: "0xb7c", szDecimals: 9, lotSize: 10_000n, minSize: 20_000n, tickSize: 1_000_000n, maxLeverage: 40, minPrice: 1n, maxPrice: 10n ** 15n },
    "ETH/USD": { name: "ETH/USD", addr: "0xe74", szDecimals: 8, lotSize: 10_000n, minSize: 50_000n, tickSize: 100_000n, maxLeverage: 20, minPrice: 1n, maxPrice: 10n ** 15n },
  };

  key = (sub: string, m: MarketSpec | string) => `${sub}|${typeof m === "string" ? m : m.name}`;
  delegate(sub: string, market: string) {
    this.delegated.add(this.key(sub, market));
  }

  async marketSpec(name: string) {
    const s = MockDecibelClient.SPECS[name];
    if (!s) throw new Error(`unknown market ${name}`);
    return s;
  }
  async markPrice(m: MarketSpec) {
    return this.marks.get(m.name)!;
  }
  async position(sub: string, m: MarketSpec): Promise<DecibelPosition> {
    return { size: this.positions.get(this.key(sub, m)) ?? 0n, entryPx: this.marks.get(m.name)!, fundingCost: 0n };
  }
  async delegation(sub: string, m: MarketSpec): Promise<DelegationStatus> {
    const ok = this.delegated.has(this.key(sub, m));
    return { canTrade: ok, scope: ok ? "market" : undefined, excessive: [] };
  }
  async orderPending(_m: MarketSpec, orderId: string) {
    return this.orders.some((o) => o.id === orderId);
  }
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const err = this.failNext.shift();
    if (err) return { ok: false, error: err };
    if (!this.delegated.has(this.key(req.subaccount, req.market)))
      return { ok: false, error: "ENOT_SUBACCOUNT_OWNER_OR_LACKS_PERP_TRADING_PERMISSIONS(0x3)" };
    if (req.size < req.market.minSize || req.size % req.market.lotSize !== 0n) return { ok: false, error: "EINVALID_SIZE" };
    if (req.price % req.market.tickSize !== 0n) return { ok: false, error: "EPRICE_NOT_RESPECTING_TICKER_SIZE" };
    const id = String(++this.seq);
    this.placed.push(req);
    this.orders.push({ id, req, wait: this.fillDelay });
    return { ok: true, orderId: id, txHash: `0xmock${id}` };
  }
  /** Advance async matching by one tick. */
  step() {
    const still: MockOrder[] = [];
    for (const o of this.orders) {
      if (--o.wait > 0) {
        still.push(o);
        continue;
      }
      const k = this.key(o.req.subaccount, o.req.market);
      const cur = this.positions.get(k) ?? 0n;
      let fill = (o.req.size * BigInt(Math.round(this.fillRatio * 1000))) / 1000n;
      fill -= fill % o.req.market.lotSize;
      if (o.req.reduceOnly) {
        const abs = cur < 0n ? -cur : cur;
        if (fill > abs) fill = abs; // reduce-only never flips
      }
      this.positions.set(k, cur + (o.req.isBuy ? fill : -fill));
    }
    this.orders = still;
  }
}
