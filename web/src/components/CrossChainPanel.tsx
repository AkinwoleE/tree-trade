"use client";
import { visibleInterval } from "@/lib/visible-interval";
// Cross-chain USDC deposit via Circle CCTP V2 (testnet):
// 1) burn USDC on an EVM testnet with the user's own EVM wallet (TokenMessengerV2.depositForBurn),
// 2) Circle's Iris attests, 3) /api/cctp/receive relays Circle's receive script on Aptos, minting
// Circle USDC to the user's Aptos address, 4) user deposits it 1:1 via usdc_gateway::wrap_and_deposit.
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, pad, type EIP1193Provider } from "viem";
import { APTOS_DOMAIN, APTOS_TESTNET_USDC, EVM_SOURCES, EVM_TOKEN_MESSENGER_V2, FINALITY_STANDARD, type EvmSource } from "@/lib/cctp/config";
import { aptos } from "@/lib/chain";
import { ENTRY } from "@/config/contract";
import type { Submit } from "@/lib/hooks";

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const TM_V2 = [
  { type: "function", name: "depositForBurn", stateMutability: "nonpayable", inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" },
    { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
    { name: "minFinalityThreshold", type: "uint32" } ], outputs: [] },
] as const;

type Pending = { src: string; domain: number; hash: string; amount: string; recipient: string; at: number; status?: string };
const LS = "treetrade.cctp.pending";
const loadPending = (): Pending[] => { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch { return []; } };
const savePending = (p: Pending[]) => localStorage.setItem(LS, JSON.stringify(p.slice(-10)));

function evmProvider(): EIP1193Provider | null {
  const w = window as unknown as { ethereum?: EIP1193Provider & { providers?: EIP1193Provider[] } };
  return w.ethereum ?? null;
}

export function CrossChainPanel({ submit, busy }: { submit: Submit; busy: boolean }) {
  const { account } = useWallet();
  const aptosAddr = account?.address.toString() ?? "";
  const [src, setSrc] = useState<EvmSource>(EVM_SOURCES[1]);
  const [amount, setAmount] = useState("10");
  const [evmAddr, setEvmAddr] = useState<`0x${string}` | null>(null);
  const [evmBal, setEvmBal] = useState<string | null>(null);
  const [circleBal, setCircleBal] = useState<bigint>(0n);
  const [msg, setMsg] = useState<string>("");
  const [pending, setPending] = useState<Pending[]>([]);

  useEffect(() => setPending(loadPending()), []);

  const refreshAptos = useCallback(async () => {
    if (!aptosAddr) return;
    try {
      const [b] = await aptos.view({ payload: { function: "0x1::primary_fungible_store::balance", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [aptosAddr, APTOS_TESTNET_USDC] } });
      setCircleBal(BigInt(String(b)));
    } catch { /* store may not exist yet */ }
  }, [aptosAddr]);
  useEffect(() => { void refreshAptos(); return visibleInterval(() => void refreshAptos(), 30_000); }, [refreshAptos]);

  const refreshEvm = useCallback(async (addr: `0x${string}`, s: EvmSource) => {
    const pc = createPublicClient({ transport: http(s.rpc) });
    const b = await pc.readContract({ address: s.usdc, abi: ERC20, functionName: "balanceOf", args: [addr] });
    setEvmBal(formatUnits(b, 6));
  }, []);
  useEffect(() => { if (evmAddr) void refreshEvm(evmAddr, src).catch(() => setEvmBal(null)); }, [evmAddr, src, refreshEvm]);

  // poll relayer for in-flight burns
  useEffect(() => {
    const live = pending.filter((p) => !["minted", "already_minted"].includes(p.status ?? ""));
    if (!live.length) return;
    const t = setInterval(async () => {
      const next = [...loadPending()];
      for (const p of next) {
        if (["minted", "already_minted"].includes(p.status ?? "")) continue;
        try {
          const r = await fetch("/api/cctp/receive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDomain: p.domain, txHash: p.hash }) });
          const j = await r.json();
          p.status = j.status ?? j.error;
        } catch { /* retry next tick */ }
      }
      savePending(next); setPending(next); void refreshAptos();
    }, 15000);
    return () => clearInterval(t);
  }, [pending, refreshAptos]);

  const connectEvm = async () => {
    const eth = evmProvider();
    if (!eth) { setMsg("No EVM wallet found (install MetaMask, or use Phantom's EVM account)."); return; }
    const wc = createWalletClient({ transport: custom(eth) });
    const [a] = await wc.requestAddresses();
    setEvmAddr(a);
  };

  const bridge = async () => {
    const eth = evmProvider();
    if (!eth || !evmAddr || !aptosAddr) return;
    try {
      const amt = parseUnits(amount || "0", 6);
      if (amt <= 0n) { setMsg("Enter an amount"); return; }
      const chain = { id: src.chainId, name: src.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [src.rpc] } } };
      const wc = createWalletClient({ account: evmAddr, chain, transport: custom(eth) });
      try { await wc.switchChain({ id: src.chainId }); } catch { await wc.addChain({ chain }); await wc.switchChain({ id: src.chainId }); }
      const pc = createPublicClient({ chain, transport: http(src.rpc) });
      const allowance = await pc.readContract({ address: src.usdc, abi: ERC20, functionName: "allowance", args: [evmAddr, EVM_TOKEN_MESSENGER_V2] });
      if (allowance < amt) {
        setMsg(`Approve USDC on ${src.name}…`);
        const h = await wc.writeContract({ address: src.usdc, abi: ERC20, functionName: "approve", args: [EVM_TOKEN_MESSENGER_V2, amt] });
        await pc.waitForTransactionReceipt({ hash: h });
      }
      setMsg(`Burn ${amount} USDC on ${src.name} → Aptos…`);
      const mintRecipient = pad(aptosAddr as `0x${string}`, { size: 32 });
      const zero = pad("0x0", { size: 32 });
      const hash = await wc.writeContract({ address: EVM_TOKEN_MESSENGER_V2, abi: TM_V2, functionName: "depositForBurn", args: [amt, APTOS_DOMAIN, mintRecipient, src.usdc, zero, 0n, FINALITY_STANDARD] });
      await pc.waitForTransactionReceipt({ hash });
      const p: Pending = { src: src.key, domain: src.domain, hash, amount, recipient: aptosAddr, at: Date.now(), status: "pending_attestation" };
      const next = [...loadPending(), p]; savePending(next); setPending(next);
      setMsg("Burned. Waiting for Circle attestation (standard transfer, ~15–20 min on testnet)…");
      void refreshEvm(evmAddr, src);
    } catch (e) {
      setMsg(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  };

  const units = circleBal;
  return (
    <div className="card mt-3 space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Deposit from another chain</h3>
        <span className="text-xs text-zinc-500">Circle CCTP · testnet</span>
      </div>

      <div className="rounded-lg bg-zinc-900/40 p-3">
        <div className="flex justify-between"><span className="text-zinc-500">Circle USDC on Aptos</span><span className="font-mono">{formatUnits(units, 6)}</span></div>
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary flex-1 py-1.5" disabled={busy || units === 0n}
            onClick={() => submit("Deposit Circle USDC", ENTRY.gatewayWrapAndDeposit, [units])}>Deposit all to Tree Trade</button>
          <button className="btn btn-ghost py-1.5" disabled={busy || units === 0n}
            onClick={() => submit("Swap to test USDC", ENTRY.gatewayWrap, [units])}>Swap 1:1</button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <select className="input min-w-[11rem] flex-1 bg-transparent px-3 py-1.5" value={src.key} onChange={(e) => setSrc(EVM_SOURCES.find((s) => s.key === e.target.value)!)}>
            {EVM_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            <option disabled>Solana Devnet (soon)</option>
          </select>
          <input className="input w-28 px-3 py-1.5 text-right" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        {!evmAddr ? (
          <button className="btn btn-ghost w-full py-1.5" onClick={connectEvm}>Connect EVM wallet</button>
        ) : (
          <>
            <div className="flex justify-between text-xs text-zinc-500"><span>{evmAddr.slice(0, 6)}…{evmAddr.slice(-4)}</span><span>USDC on {src.name}: {evmBal ?? "…"}</span></div>
            <button className="btn btn-primary w-full py-1.5" disabled={!aptosAddr} onClick={bridge}>Bridge to my Aptos account</button>
          </>
        )}
        <p className="text-xs text-zinc-500">Need test USDC? Get it free at faucet.circle.com (pick {src.name}). Gas on Aptos is sponsored.</p>
        {msg && <p className="text-xs text-amber-400 break-words">{msg}</p>}
      </div>

      {pending.length > 0 && (
        <div className="space-y-1 text-xs">
          {pending.slice().reverse().map((p) => (
            <div key={p.hash} className="flex justify-between gap-2">
              <a className="font-mono underline" target="_blank" rel="noreferrer" href={(EVM_SOURCES.find((s) => s.key === p.src)?.explorer ?? "") + p.hash}>{p.amount} USDC · {p.hash.slice(0, 10)}…</a>
              <span className={["minted", "already_minted"].includes(p.status ?? "") ? "text-emerald-400" : "text-zinc-500"}>{(p.status ?? "").replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
