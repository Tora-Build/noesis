# Sooth Hedge risk agent

CoinMarketCap finds the risk. Cournot gives an evidence-based probability. Sooth prices the risk. The agent decides.

## Setup

Use Node 22 or later. The only dependency is `viem`.

```sh
cd agent
npm install
npm test
```

## Environment variables

| Name | Use |
|---|---|
| `RPC_URL` | BSC RPC. You can also pass `--rpc`. `BSC_RPC_URL` is used when neither is set. |
| `PRIVATE_KEY` | Signer for `--execute`. Not needed for a dry run. The agent never logs it. |
| `AMM_ADDRESS` | Optional. Overrides the AMM found through the market factory. |
| `CMC_API_KEY` | Optional. Without it the agent uses the keyless CMC API. Each report says which (`inputs.cmc.mode`). |
| `COURNOT_API_KEY` | Optional. A prepaid Cournot key (`ck_live_...`). Sent as the `COURNOT-API-KEY` header. |
| `COURNOT_OFFLINE` | Set to `1` to block all Cournot probability calls. |

The agent and the keeper read `agent/.env`, then the repo root `.env`. A value already in the
environment wins. No value is ever printed. `node --env-file=../.env run.mjs ...` also works.
Do not commit a `.env` file. The `.gitignore` excludes `.env`, `cache/` and `out/`.

## Commands

Analyze a market. This is a dry run. It builds the trade but does not send it.

```sh
node run.mjs --market 0xMARKET --rpc $RPC_URL
```

Add the Cournot probability. Each IP gets only 3 free probability calls in total. The agent caches every attempt in `cache/` per market id, with no expiry. Failures (402, 429, 5xx, network) are cached too, and the attempt is recorded before the request is sent. So a rerun never spends another free call. Pass `--refresh-cournot` to call again on purpose. It never pays. A 402 answer gives a `COURNOT_PAYMENT_REQUIRED` alert, and the decision uses the CMC model only.

```sh
node run.mjs --market 0xMARKET --rpc $RPC_URL --cournot-id 113195
```

Without `--cournot-id`, the agent calls the free `resolve` endpoint and prints the matching id. Use `--no-cournot` to skip Cournot.

Send the trade. This needs `PRIVATE_KEY`.

```sh
PRIVATE_KEY=0x... node run.mjs --market 0xMARKET --rpc $RPC_URL --execute
```

Other options: `--asset BNB` (when the feed is unknown), `--bankroll 100`, `--threshold 0.05`, `--slippage 0.02`, `--out <dir>`, `--refresh-cournot`.

`npm run clean` (or `npm run agent:clean` from the repo root) clears `out/`. It keeps `cache/`.

Make a report from fixtures for the demo page. No network.

```sh
node run.mjs --offline --fixture test/fixtures/demo-bnb.json
```

Each run writes `out/<market>.json`. It holds every input, the Cournot evidence, the decision, the alerts and the tx data or hash. For proof it also holds:

- `chainId` and `proof`: the block number and hash the chain was read at, the AMM state (`qYes`, `qNo`, `priceWad`) and the feed price and time (`feed.ts`).
- `inputs.cmc.mode`: `keyed` or `keyless`.
- `inputs.cmc.calls`: `[{ path, at, status }]`, one per CMC HTTP request. No key and no query string. Use it to match the report to the CMC API log.

Run the keeper. It simulates `settleFromFeed` when a TOUCH market has crossed or a market passed its deadline. It simulates `settle` when `canSettle` is true. It sends only with `--execute`.

```sh
node keeper.mjs --rpc $RPC_URL 0xMARKET1 0xMARKET2 [--execute] [--loop 60]
```

`--loop` must be 10 seconds or more. The keeper keeps the hash of each tx it sent, per market. It skips that market until the tx is mined, so a slow block never causes a second send. With the default `VETO_SECONDS=0` there is no veto window: `settle` can follow `settleFromFeed` on the next tick.

## How it decides

1. Sooth price `p_s`: `AMMEngine.getMarketState(market).price`, the LMSR YES price.
2. Model `p_m`: zero-drift lognormal for CLOSE markets. Reflection principle for TOUCH markets: `N(d2) + (S/K) N(d1)`, and 1 if the feed already crossed. Spot is the on-chain feed price. Sigma is realized volatility from 30 daily CMC candles. Atlas RWA tokens have no DEX candles, so they use a default sigma.
3. Cournot `p_c`: the `point_estimate` from the probability endpoint.
4. Fair `p* = 0.6 p_c + 0.4 p_m`, or `p_m` when Cournot is missing.
5. Risk 0 to 100: 40% volatility, 25% Fear and Greed extremes, 35% closeness to the strike.
6. If `|p* - p_s| > 0.05` and risk is below 75, buy YES or NO. Size is half Kelly times `(1 - risk/100)`, capped at 10% of bankroll. Else HOLD.
7. Before a trade, the agent quotes it on chain. It bisects the shares down until the cost with fee is at most the size. If the YES price after the trade is within half the threshold of `p*` (for a YES buy: above `p* - 0.025`; for a NO buy: below `p* + 0.025`), no edge is left and it holds. The report keeps the first plan in `decision.preImpact`.
8. Alerts: `COURNOT_SOOTH_GAP` (gap over 15%), `HIGH_RISK` (70 or more), `FEED_STALE` (feed older than 900 s, also forces HOLD), `FEED_CMC_DIVERGENCE`, `COURNOT_PAYMENT_REQUIRED`, `COURNOT_UNAVAILABLE`.

HOLD on `FEED_STALE` is intended. Atlas stock feeds only publish while the stock market is open, so at night and on weekends the agent holds. It does not trade on an old price.

## Files

- `src/cmc.mjs`: CMC client, parsers, realized volatility.
- `src/cournot.mjs`: Cournot resolve and probability, cache, state handling.
- `src/model.mjs`: fair probability and risk score.
- `src/sooth.mjs`: chain reads, trade build and send.
- `src/decide.mjs`: decision and alerts.
- `src/report.mjs`: the pipeline that joins all inputs.
- `src/env.mjs`: reads `.env` files without printing values.
- `run.mjs`, `keeper.mjs`: CLIs.
- `test/`: `node --test` suites. Tests block the network.

The Cournot probability fixture is built from the Cournot `response-format.md`. It is not a live answer. The CMC fixtures and the Cournot resolve fixture are real captures from 2026-11-26.
