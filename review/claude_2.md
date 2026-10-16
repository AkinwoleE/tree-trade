# Adversarial review: `web/src` (as of 2026-10-15 15:35)

**Concurrent edits.** Four files changed while I was reviewing: `api/sponsor/route.ts`, `api/hedge/fund/route.ts`, `api/aptos/[...path]/route.ts` and `lib/server-sponsor.ts`. They were modified after the 15:33 `.next` build, and the new comments refer to `REVIEW_2026-10-15 W-1/W-2`. I re-read all four and reviewed the latest versions; line numbers refer to them. I edited no files.

## Findings

### 1. High: anyone can reset every rate limit by flooding the shared limiter map
- **Where:** `lib/server-sponsor.ts:23` (`if (hits.size > 50_000) hits.clear()`). The same `hits` map is used by `/api/sponsor`, `/api/hedge/fund`, `/api/cctp/receive` and `/api/aptos`.
- **Scenario:**
  - An attacker POSTs about 50k junk requests to `/api/sponsor`, each with a random `sender`. The transaction only has to pass the allowlist and gas checks to reach `rateLimited(sender…)` at `sponsor/route.ts:46`.
  - A garbage `senderAuthenticator` is fine. It fails later at submit, costs no gas, but the key is already in the map.
  - Easier still: 50k proxy requests with spoofed `x-forwarded-for` values (`aptos/[...path]/route.ts:55`).
  - At 50,001 keys the map is cleared. That wipes the `global`, `ip:*`, `fund-global` and `fund:<owner>` counters, so the new global caps never hold.
- **Fix:**
  - Use a shared store such as Vercel KV or Upstash, which also fixes the per-instance problem.
  - At minimum, keep separate maps per route and per kind of key.
  - Evict oldest entries (LRU) rather than calling `clear()`, and never evict `global` or `ip:*` keys.
  - In the sponsor route, count the sender key only after verifying the sender signature (`auth.verify…` against the signing message).

### 2. High: the client IP comes from spoofable headers
- **Where:** `lib/server-sponsor.ts:28-30` (`clientIp`), used by sponsor, fund and the proxy.
- **Scenario:** Off Vercel, `x-real-ip` and `x-forwarded-for` are set by the client. That covers `next start` behind the tunnel this repo seems to use (`tunnel.log`). Each request can then claim a fresh IP, so the per-IP limits do nothing. Only the global caps are left (600 tx/min sponsor, 100/h fund), and finding 1 lets an attacker reset those too.
- **Even with honest IPs:**
  - The global caps make it easy to shut out real users: 100 junk fund calls per hour blocks every legitimate "Enable hedging".
  - The worst-case sponsor spend is still 600 × 20,000 × 200 octas ≈ 24 APT per minute.
- **Fix:**
  - Read the IP only from a header your own proxy overwrites, for example `request.ip` or `x-vercel-forwarded-for` on Vercel. Otherwise use the socket address.
  - Before sponsoring a transaction, simulate it and refuse anything that would abort, since failed transactions still burn the sponsor's gas.

### 3. High: the proxy's 3-second cache returns stale sequence numbers, so back-to-back transactions fail
- **Where:** `api/aptos/[...path]/route.ts:22` (every `GET` is cacheable), together with `lib/chain.ts:11-16` (the browser SDK goes through the proxy).
- **How:** `build.simple` reads the sequence number with `GET v1/accounts/{addr}` (`ts-sdk/.../transactionBuilder.ts:401`, `getInfo`).
- **Scenario:**
  - With 1-click trading on, the user opens a position. It confirms in about 1 s on testnet.
  - Within 3 s they close it, or press "Close All", which loops through `submitFn` (`TradePanel.tsx:300`).
  - The second build gets the cached `sequence_number = N`, so the sponsor submit fails with `SEQUENCE_NUMBER_TOO_OLD`.
  - The same happens for the wallet-signed sponsored path (`hooks.ts:285`).
- **Related:** `v1/view` is also cached for 3 s. The `refresh()` call that `useTx` makes right after confirmation can therefore show balances and positions from before the trade until the next 8 s poll.
- **Fix:**
  - Don't cache `v1/accounts/{addr}` (the bare account resource) or `v1/transactions/*`.
  - Or pass `accountSequenceNumber` explicitly when building.
  - Or have `refresh()` after a transaction send a cache-bust header that the proxy honours.

### 4. Medium-High (regression): the new proxy limit of 600/min per IP throttles the app's own UI
- **Where:** `api/aptos/[...path]/route.ts:55`. The limit is checked before the cache lookup, so cache hits count too.
- **Request load per open tab:**
  - `useChainData` (`hooks.ts:138-228`) makes about 17 global views, plus up to 25 `queue_entry` reads, plus 8 account reads, plus 2 per position, every 8 s. That is roughly 375 to 450 requests per minute with zero positions.
  - `useDecibelAccount` adds about 60 per minute.
  - So a user with about 12 positions, two tabs, or several users behind one NAT (a hackathon Wi-Fi network, for example) goes over 600/min.
- **Effect:** the views return 429. `view()` retries up to 3 times (`chain.ts:22-33`), which makes it worse, and the UI shows errors.
- **Fix:**
  - Check the limit only on cache misses, or raise it a lot.
  - Batch the reads: one view that returns the whole queue page, and one `get_positions(owner)`.

### 5. Medium: the CCTP relay route can drain sponsor gas and get the server's IP blocked by Circle
- **Where:** `api/cctp/receive/route.ts:21` (limited only by `txHash`, which the attacker chooses), `:22` (uncached call to Iris), `:35-43` (sponsor builds, signs and submits).
- **Scenario:**
  - Any completed burn to Aptos is public. Replaying its hash makes the sponsor submit `receive_message` again.
  - The replay aborts because the nonce is already used, and the sponsor still pays gas: up to 20/min per hash per instance, across any number of hashes.
  - Each call also hits Iris. Circle documents a 5-minute IP block once its rate limit is exceeded, which would break bridging for everyone.
- **Also:** the server makes all relay transactions from the sponsor as sender, and `fund` does the same. Concurrent requests read the same sequence number, so one of them fails.
- **Fix:**
  - Before submitting, call the `message_transmitter` view `is_nonce_used` and return `already_minted` if it is used.
  - Cache Iris responses per hash.
  - Add IP and global limits once findings 1 and 2 are fixed.
  - Serialize sponsor-sender transactions, or use orderless/nonce transactions.

### 6. Medium: the client polls `relay_failed` relays forever
- **Where:** `CrossChainPanel.tsx:66-76`. Only `minted` and `already_minted` count as finished.
- **Scenario:** A burn whose relay keeps failing, or that returns `{error}`, is POSTed every 15 s by every open tab, indefinitely. That is self-inflicted gas drain via finding 5.
- **Fix:** Treat `relay_failed` and 4xx errors as terminal, or back off exponentially with a maximum number of attempts.

### 7. Medium: `/api/stream` has no limit on connections
- **Where:** `api/stream/route.ts:89` opens a new keyed Decibel WebSocket per SSE client. `:77` polls Hyperliquid once per second per client when it falls back.
- **Scenario:**
  - N unauthenticated `EventSource` connections create N upstream sockets on your Decibel key.
  - In fallback mode they make N requests per second to Hyperliquid from one server IP. Hyperliquid limits by IP weight, so at around 10 clients prices stall for everyone.
- **Fix:** Use one shared upstream socket or poller per instance and fan out to subscribers. Cap connections per IP.

### 8. Medium (config footgun): server API keys reach the client bundle if the documented `NEXT_PUBLIC_*` vars are set
- **Where:**
  - `.env.example` tells operators to set `NEXT_PUBLIC_APTOS_API_KEY`.
  - `app/providers.tsx:23` inlines it into the wallet adapter config, which ships to the browser.
  - `api/activity/route.ts:13` and `api/decibel/[path]/route.ts:15` fall back to `NEXT_PUBLIC_*` keys.
- **Verified fine today:**
  - `NEXT_PUBLIC_APTOS_API_KEY` is empty in `.env.local`.
  - `.next/static` contains no `aptoslabs_…` key.
  - The only `APTOS_API_KEY` match in the bundle is the name in `chain.ts`, which is `undefined` in the browser.
- **Fix:** Remove every `NEXT_PUBLIC_*_API_KEY` reference and fallback, and delete it from `.env.example`.

### 9. Medium: fund route race and per-request gas cost
- **Where:** `api/hedge/fund/route.ts:46-54`.
- **Scenario:**
  - Three concurrent requests for the same owner all read `bal < cap` before any mint lands, so up to 3 × 1,000 USDC gets minted.
  - Every successful request costs sponsor gas, since the sponsor is the sender. Random owners plus finding 1 means the spend is unbounded.
- **Fix:** Add a per-owner in-flight lock, and include the post-mint balance in the cap. Optionally require a signature from the owner proving they control the address.

### 10. Low-Medium: the proxy path may escape `/v1` on the same host (not verified)
- **Where:** `api/aptos/[...path]/route.ts:20` (`^v1(\/|$)` regex) and `:31` (`fetch(`${UPSTREAM}/${path}`)`).
- **Scenario:** If Next decodes `%2F` inside catch-all segments, then `/api/aptos/v1/..%2F..%2Fdecibel/api/v1/prices` becomes `v1/../../decibel/...`. WHATWG URL then normalizes that to `/decibel/...` on `api.testnet.aptoslabs.com`, with your Geomi key attached.
- **Not affected:** the host is fixed, so this is not SSRF to other hosts.
- **To verify:** run `curl -i 'http://localhost:3000/api/aptos/v1/..%2F..%2Fdecibel/api/v1/markets'`.
- **Fix:** Build the URL first, then require `new URL(...).pathname.startsWith("/v1/")`. Also reject any segment that contains `..` or `%`.

### 11. Low-Medium: the 1-click session key is stored in plaintext for 7 days
- **Where:** `lib/session.ts:17` (7-day TTL), `:27` (plain `localStorage`). It is not cleared when the wallet disconnects.
- **Scenario:** Any XSS or malicious extension, or the next person on a shared machine, can read the key. They can then open and close 1000× positions for the owner, including hedged ones, until the key expires. The on-chain scope stops withdrawals.
- **Fix:**
  - Use a non-extractable WebCrypto key held in IndexedDB, or at least `sessionStorage`.
  - Shorten the TTL to about 24 h.
  - Clear the key on disconnect and on account change.

### 12. Low: the error regex can delete a valid session
- **Where:** `hooks.ts:349`.
- **Scenario:** `/0x11|0x12|…|\b1[78]\b/` matches any hex string starting with `0x11` or `0x12` (an address or hash inside a vm_status). It also matches a bare "17" or "18". An unrelated failure then calls `clearSession` and silently falls back to wallet popups.
- **Not affected:** today's `MODULE_ADDR` does not start with 0x11 or 0x12, which I checked.
- **Fix:** Match the abort codes exactly, e.g. `/E_NOT_DELEGATE|E_DELEGATION_EXPIRED|abort.*\b(17|18)\)/`.

### 13. Low: float-to-u64 conversions are inconsistent
- **Where:** `HedgePanel.tsx:144` and `:207` use `BigInt(Math.floor(a * 1e6))`.
- **Scenario:** `0.29 * 1e6 = 289999.99…` floors to 289,999, one unit short. MAX followed by deposit leaves dust.
- **Also:** `AmountForm` MAX does `String(max)`, which can produce `"1e-7"`. That becomes an amount of 0 and the transaction aborts.
- **Fix:** Parse decimal strings directly to bigint (e.g. viem `parseUnits(value, 6)`). Keep MAX as the raw bigint.

### 14. Low: malformed CCTP messages crash the route
- **Where:** `cctp/receive/route.ts:30`.
- **Scenario:** A message shorter than 12 bytes makes `getUint32(8)` throw a RangeError outside the try block, so the route returns a 500.
- **Fix:** Check the length first.

## What I checked and found fine
- **Sponsor allowlist:**
  - Only entry-function payloads are accepted; scripts and multisig are rejected.
  - The module address and function are compared after normalization (`toStringLong`), so short or long address forms can't bypass the allowlist.
  - Decibel entries need an exact `module::function` match.
  - The 60k gas limit applies only to `add_delegated_trader_and_deposit_to_subaccount`. Gas price is capped at 200, and the new 600 s expiry cap is sensible.
  - The fee payer is overwritten with the sponsor address.
- **Sender spoofing:** not possible. Submission validates the sender signature, so a spoofed sender only produces a rejected transaction. The weak spot is the limiter (finding 1), not authentication.
- **Admin functions in allowed modules:** `test_usdc::mint`, `exchange::set_*` and the others are gated by `assert_admin` or the keeper on-chain. The worst case is gas paid for an aborted transaction.
- **Delegates:** `*_as_delegate` and `hedge::open_position_hedged_as_delegate` enforce the delegation and expiry on-chain, and proceeds go only to the owner.
- **Decibel proxy:** limited to `prices` and `markets`, GET only, with a fixed base URL and no client-controlled path. Not an open proxy.
- **Other server routes:** `/api/candles` validates its inputs. `/api/hedge/status` reads only an env-configured path or URL. `/api/activity` takes no input.
- **Secrets:**
  - `SPONSOR_PRIVATE_KEY` is read only in the `server-only` module.
  - No secret names or values are in `.next/static`.
  - `.env*.local` is gitignored.
- **"Hyperliquid" in the UI:** it never reaches the client.
  - All Hyperliquid calls are server-side (`/api/prices`, `/api/stream`, `/api/candles`), and responses label the source "market feed".
  - Upstream error text is replaced with generic messages.
  - The client imports from `lib/prices` are type-only, and the built bundle contains no "hyperliquid" string.
  - The keeper's hedger errors, shown in `PositionsTable`, come from Decibel or sync code and never from price sources.
- **Bigint maths and formatting:**
  - The hedge sizing in `lib/hedge.ts` (rounding, tick and lot handling) is all bigint.
  - `toUnits` uses `Math.round` and is safe below 2^53.
  - `fromUnits` loses precision only for u128 aggregates, and only in display.
  - Stale out-of-order loads are dropped through `reqId` in `useChainData` and `useDecibelAccount`.

**Priority:** fix 1 and 2 together with a shared store and a trusted IP, then 3 (it breaks 1-click trading in normal use), then 4 (the new limit throttles normal use), then 5 and 6.
