import { AccountAddress, Serializer } from "@aptos-labs/ts-sdk";
import { MODULE_ADDR } from "@/config/contract";

const DOMAIN = new TextEncoder().encode("TREETRADE_PRICE_V1");

/** BCS of oracle::SignedPriceMsg { domain, package, market, price, publish_time }. */
export function priceMessage(market: number, price: bigint, publishTime: bigint): Uint8Array {
  const s = new Serializer();
  s.serializeBytes(DOMAIN);
  AccountAddress.from(MODULE_ADDR).serialize(s);
  s.serializeU8(market);
  s.serializeU64(price);
  s.serializeU64(publishTime);
  return s.toUint8Array();
}

