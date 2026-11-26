# NOESIS

Price the Unknown. Live demo: https://noesis-7fg.pages.dev

NOESIS is built on Sooth. The code and contracts below use the working name Sooth Hedge.

Risk markets for agents on BNB Chain.

CoinMarketCap finds the risk. Cournot gives the odds, with evidence. The Atlas Consensus Score says how much to trust the data. Sooth prices and trades the risk. Atlas Oracle settles it on-chain, with no person in the loop.

## What it does

1. **Markets on prices.** Each market asks a price question, for example "IWMB below $264 at 2026-12-01 05:00 UTC" or "BNB below $560 at 2026-12-01 05:00 UTC". It trades on a Sooth node on BSC mainnet (LMSR AMM and order book).
2. **Settlement from the feed.** `PriceFeedAdjudicator` reads the Atlas Oracle MultiFeed (or a Chainlink-style feed) and proposes the outcome itself. Anyone can call `settleFromFeed`. By default there is no guardian and no veto window (`VETO_SECONDS=0`): only the feed decides. Then anyone calls `settle`.
3. **The risk agent.** For each market the agent reads:
   - CoinMarketCap: spot, Fear and Greed, global metrics, and volatility: realized from 30 daily DEX candles for BNB, or from 24h to 90d price changes for tokenized stocks (they have no DEX candles).
   - Cournot Intelligence Oracle: the probability of the same claim, with its evidence.
   - Sooth: the market's YES price.
   - Atlas Pull API (Atlas markets): the Consensus Score, read with our API key. The response's signed price payload is checked against the Atlas signer. If the API fails, the feed is missing or the data is more than 15 min old, the agent does not trade. HEALTHY: full size. DEGRADED: half size. WARNING, CRITICAL, SPLIT_MARKET, UNKNOWN or a bad signature: no trade. The key (`ATLAS_API_KEY`) stays on the server.

   It blends these into a fair probability and a risk score. If the gap to the Sooth price is larger than the threshold, it buys YES or NO with a capped Kelly size. Otherwise it holds. Each decision is written to a report with every input and the evidence.
4. **The page.** `web/` shows each market with the feed price, the Sooth price, Cournot, the CMC model, the risk and the agent's decision. A wallet can trade, settle from the feed, finalize and claim.

## Market kinds

| Kind | YES when |
|---|---|
| Close above / below | The first feed price at or after the deadline is past the strike. A read later than `maxDelay` (default 300 s, at most 3600 s) gives INVALID. |
| Touch above / below | Any feed price published after the market opened and before the deadline is past the strike. Settles early. At the deadline with no touch, NO. **Off by default:** `CreateMarket` refuses touch kinds unless `ALLOW_TOUCH=1`, because a trader can buy and settle in one tx right after a cross. |

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
git clone --recursive <this repo> && cd noesis
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

# One market (example: BNB closes at or below $560 on 2026-12-01 05:00 UTC, Chainlink BNB/USD)
QUESTION='BNB below $560 at 2026-12-01 05:00 UTC (Chainlink)' DEADLINE=1796101200 \
SOURCE=1 FEED=0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE KIND=1 \
STRIKE=560000000000000000000 PROB=150000000000000000 \
forge script script/DeployHedge.s.sol:CreateMarket --rpc-url bsc --broadcast

# One Atlas market (IWMB, Atlas feed id 1166, close above $270)
QUESTION='IWMB above $270 at 2026-12-01 05:00 UTC (Atlas Oracle)' DEADLINE=1796101200 \
SOURCE=0 FEED=0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa FEED_ID=1166 KIND=0 \
STRIKE=270000000000000000000 PROB=450000000000000000 \
forge script script/DeployHedge.s.sol:CreateMarket --rpc-url bsc --broadcast
```

The deploy uses about 87M gas (about 0.0045 BNB at 0.05 gwei).

A strike ladder of close-below markets for one Atlas asset (strikes below spot, no duplicates,
a clean step near 0.5% of spot, deeper markets by default: `--bbase 1000 --max-input 5000`):

```sh
RPC=$BSC_RPC_URL PRIVATE_KEY=0x... node scripts/create-ladder.mjs \
  --symbol IWMB --feed-id 1166 --deadline 1796101200 --steps 0.99,0.98,0.96 --sigma 0.25 --dry
```

Options: `--kind 1` (close below, default) or `0`; `--round <dollars>`; `--max-delay 300`;
`--bbase`, `--max-input` (collateral units). Touch kinds need `--allow-touch`. Drop `--dry` to send.

### Fork runs (anvil)

Fork runs must not write the mainnet file. Set `DEPLOYMENT_FILE` (relative to `contracts/`):

```sh
anvil --fork-url $BSC_RPC_URL &
cd contracts
export DEPLOYMENT_FILE=deployments/fork-56.json   # gitignored
PRIVATE_KEY=<anvil key> forge script script/DeployHedge.s.sol:DeployHedge --rpc-url http://127.0.0.1:8545 --broadcast
cd .. && node scripts/build-web.mjs --rpc http://127.0.0.1:8545 --page-rpc http://127.0.0.1:8545 && npm run web:serve
```

### Run the agent and the page

```sh
cd agent
node run.mjs --market 0xMARKET                        # dry run, free Cournot resolve
node run.mjs --market 0xMARKET --cournot-id 113195    # with Cournot probability (one call per id, ever)
node run.mjs --market 0xMARKET --execute              # sends the trade (PRIVATE_KEY)
node keeper.mjs 0xM1 0xM2 --execute --loop 60         # settles from the feed (loop 10 s or more)
cd .. && npm run agent:clean && (cd agent && node run.mjs --market 0xMARKET) && npm run web   # http://127.0.0.1:8080
```

The agent reads `agent/.env`, then the repo root `.env`. Values already in the environment win, and
no value is ever printed. `node --env-file=../.env run.mjs ...` also works. The RPC comes from
`--rpc`, `RPC_URL` or `BSC_RPC_URL`.

`npm run agent:clean` clears `agent/out/` (old reports). It keeps the Cournot cache in `agent/cache/`.

See `agent/README.md` for every option.

**HOLD on a stale Atlas feed is intended.** Atlas stock feeds (IWMB, EWZB, ...) only publish while
the stock market is open. At night and on weekends the feed gets older than 900 s, the agent raises
`FEED_STALE` and holds. It does not trade on an old price.

### The page and its RPC

`npm run web:config` (and `npm run web`) builds `web/config.json` and `web/reports/`.

- `--rpc` (default `BSC_RPC_URL`) is only used to read the chain during the build. It can be a
  private keyed URL. It is never written to the page.
- `--page-rpc` (default `https://bsc-dataseed.bnbchain.org`) is written to `config.json`, so it is
  public. The build refuses any URL that is not a public BSC RPC: `bsc-dataseed*.bnbchain.org`,
  `bsc-dataseed*.binance.org`, `bsc-rpc.publicnode.com`, or `127.0.0.1` / `localhost` for local use.
- Only reports for markets in the config, on the same AMM and chain, are copied. Each report holds
  the block number, the AMM state and the feed time it read, so anyone can check it on chain.

### Publish to GitHub Pages

```sh
npm run pages -- --no-push     # build into a temp dir and look at it first
npm run pages                  # build and push to the gh-pages branch of origin
```

It builds from `contracts/deployments/56.json` (chain 56 only), with the public page RPC and the
filtered reports, and force-pushes one commit to `gh-pages`. `main` and `develop` are not touched.
Once, in GitHub: Settings, Pages, "Deploy from a branch", `gh-pages`, `/ (root)`. The page is then
at `https://tora-build.github.io/noesis/`. The live demo uses Cloudflare Pages: https://noesis-7fg.pages.dev

## Addresses (BSC mainnet)

| Item | Address |
|---|---|
| Atlas Oracle MultiFeed | `0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa` |
| Chainlink BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| Chainlink BTC/USD | `0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf` |
| PriceFeedAdjudicator, node, markets | see `contracts/deployments/56.json` after deploy |

## Limits

- **Touch markets are off by default.** A trader could buy and settle in one tx right after a cross. If you turn them on (`ALLOW_TOUCH=1`), a touch that nobody submits between two feed reads is missed.
- **Demo collateral:** hUSD-DEMO ("Sooth Hedge Demo USD (no value)") is a demo token with no value. Anyone can take 1,000 a day from its faucet. Pass `STABLE=<token>` to deploy on a real stablecoin.
- **Chainlink for BNB and BTC:** Atlas has no public push feed for BNB or BTC yet, so those markets use Chainlink. They move to Atlas when Atlas publishes those feeds.
- **Cournot calls:** each IP gets 3 free Cournot probability calls. After that a call costs $0.01. The agent never pays by itself. The bot only reuses cached answers (`BOT_COURNOT_IDS=0xMARKET:ID[:invert],…`), and `COURNOT_OFFLINE=1` stops any call on a cache miss.
- **Consensus Score is off-chain.** The agent uses it to size trades. Settlement still reads only the on-chain Atlas feed.
