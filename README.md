# Sooth Hedge

Risk markets for agents on BNB Chain.

CoinMarketCap finds the risk. Cournot gives the odds, with evidence. Sooth prices and trades the risk. Atlas Oracle settles it on-chain, with no person in the loop.

## What it does

1. **Markets on prices.** Each market asks a price question, for example "IWMB above $270 at 2026-12-01 05:00 UTC" or "BNB above $600 at any time before 2026-12-01". It trades on a Sooth node on BSC mainnet (LMSR AMM and order book).
2. **Settlement from the feed.** `PriceFeedAdjudicator` reads the Atlas Oracle MultiFeed (or a Chainlink-style feed) and proposes the outcome itself. Anyone can call `settleFromFeed`. A guardian can veto during a short window. Then anyone calls `settle`.
3. **The risk agent.** For each market the agent reads:
   - CoinMarketCap: spot, realized volatility from candles, Fear and Greed.
   - Cournot Intelligence Oracle: the probability of the same claim, with its evidence.
   - Sooth: the market's YES price.

   It blends these into a fair probability and a risk score. If the gap to the Sooth price is larger than the threshold, it buys YES or NO with a capped Kelly size. Otherwise it holds. Each decision is written to a report with every input and the evidence.
4. **The page.** `web/` shows each market with the feed price, the Sooth price, Cournot, the CMC model, the risk and the agent's decision. A wallet can trade, settle from the feed, finalize and claim.

## Market kinds

| Kind | YES when |
|---|---|
| Close above / below | The first feed price at or after the deadline is past the strike. A read later than `maxDelay` gives INVALID. |
| Touch above / below | Any feed price published after the market opened and before the deadline is past the strike. Settles early. At the deadline with no touch, NO. |

Only feeds named at deployment can be used. They are part of the frozen profile hash, so a market creator cannot bring a fake feed.

## New in this hackathon, and existing work

- **New:**
  - `contracts/src/PriceFeedAdjudicator.sol` and its tests.
  - The BSC deploy scripts (`contracts/script/`).
  - The whole risk agent (`agent/`).
  - The demo page (`web/`).
  - The BSC mainnet deployment.
- **Existing (used as a library):** the Sooth protocol contracts, [sooth-factory](https://github.com/Tora-Build/sooth-factory) v0.1.1 (MIT), as a git submodule. We did not change them.

## Run it

```sh
git clone --recursive <this repo> && cd sooth-hedge
npm install && (cd agent && npm install)

# Contracts: build and test (the fork test needs BSC_RPC_URL)
cd contracts && forge test && cd ..

# Agent tests (no network)
cd agent && npm test && cd ..
```

### Deploy to BSC mainnet

```sh
cd contracts
export BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
export PRIVATE_KEY=0x...   # never commit it
forge script script/DeployHedge.s.sol:DeployHedge --rpc-url bsc --broadcast
# writes deployments/56.json

# One market (example: BNB touches $600 before 2026-12-01 05:00 UTC, Chainlink BNB/USD)
QUESTION='BNB price above $600 at any time before 2026-12-01 05:00 UTC' DEADLINE=1796101200 \
SOURCE=1 FEED=0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE KIND=2 \
STRIKE=600000000000000000000 PROB=100000000000000000 \
forge script script/DeployHedge.s.sol:CreateMarket --rpc-url bsc --broadcast

# One Atlas market (IWMB, Atlas feed id 1166, close above $270)
QUESTION='IWMB above $270 at 2026-12-01 05:00 UTC (Atlas Oracle)' DEADLINE=1796101200 \
SOURCE=0 FEED=0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa FEED_ID=1166 KIND=0 \
STRIKE=270000000000000000000 PROB=450000000000000000 \
forge script script/DeployHedge.s.sol:CreateMarket --rpc-url bsc --broadcast
```

The deploy uses about 87M gas (about 0.0045 BNB at 0.05 gwei).

### Run the agent and the page

```sh
cd agent
node run.mjs --market 0xMARKET --rpc $BSC_RPC_URL                       # dry run, free Cournot resolve
node run.mjs --market 0xMARKET --rpc $BSC_RPC_URL --cournot-id 113195   # with Cournot probability
PRIVATE_KEY=0x... node run.mjs --market 0xMARKET --rpc $BSC_RPC_URL --execute
node keeper.mjs --rpc $BSC_RPC_URL 0xM1 0xM2 --execute --loop 60       # settles from the feed
cd .. && npm run web                                                     # http://127.0.0.1:8080
```

See `agent/README.md` for every option.

## Addresses (BSC mainnet)

| Item | Address |
|---|---|
| Atlas Oracle MultiFeed | `0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa` |
| Chainlink BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| Chainlink BTC/USD | `0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf` |
| PriceFeedAdjudicator, node, markets | see `contracts/deployments/56.json` after deploy |

## Limits

- **Missed touches:** a touch that nobody submits between two feed reads is missed. The keeper reads every minute, and the Atlas heartbeat is 60 s.
- **Demo collateral:** hUSD is a demo token with no value. Anyone can take 1,000 a day from its faucet. Pass `STABLE=<token>` to deploy on a real stablecoin.
- **Chainlink for BNB and BTC:** Atlas has no public push feed for BNB or BTC yet, so those markets use Chainlink. They move to Atlas when Atlas publishes those feeds.
- **Cournot calls:** each IP gets 3 free Cournot probability calls. After that a call costs $0.01. The agent never pays by itself.
