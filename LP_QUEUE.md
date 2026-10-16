# LP / payout queue / fees: Paper Trade parity (exchange V2, 2026-10-15)
Upgrade tx 0x924f921a1911a56c1fb289494d50b664e9f0e3ffe7239496cb133ef2f9456245, init_v2 0xbbb6e349e8c7ca61e36e4e2d9a1cfadf87ce98dfa35c193fa94b90f71447a1f7,
seed removal (50,000 USDC to deployer) 0x102ae7d7bcaf2dfad1868167d3d6e1897e8d384b9d3c0281d9fcdcf118b09631.
Rules: see move/sources/exchange.move "V2" section; tests: move/sources/v2_tests.move; prod check: keeper/src/verify/queue-e2e.ts (log keeper/queue-e2e.log).
Not implemented: PT liquidation bust-buffer trigger (we still use 0.5% maintenance), min notional $1k / max $10M, per-side OI keeper.
