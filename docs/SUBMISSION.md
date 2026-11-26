# Sooth Hedge: submission

## Tech stack tags (8)

1. BNB Smart Chain
2. Solidity
3. Foundry
4. Atlas Oracle
5. CoinMarketCap API
6. Cournot
7. Node.js
8. viem

## Links

- Repository: https://github.com/Tora-Build/sooth-hedge
- Live demo: TODO (GitHub Pages, after the mainnet deploy)
- Video (3 minutes or less): TODO

## One-page write-up

### Problem and audience

People who hold tokenized stocks on BNB Chain (for example IWMB) have no simple way to protect against a price drop. Options desks are not on-chain, and insurance cover needs a claims vote.

Sooth Hedge sells protection as a market: "You pay $X. You get $Y if IWMB is below $260 on Dec 1." Atlas Oracle settles it on-chain. No person decides the result. A risk agent prices every strike from CoinMarketCap data and Cournot evidence, and trades when the market price is wrong.

Audience: holders of tokenized stocks and BNB who want downside protection, and traders and agents who want to sell it.

### Endpoints and feeds

| Source | What we use | Where in the code |
|---|---|---|
| Atlas Oracle MultiFeed (BSC mainnet) | `fetch(bytes4)` for settlement and live price | `contracts/src/PriceFeedAdjudicator.sol`, `web/app.js` |
| CoinMarketCap Pro API | `/v3/cryptocurrency/quotes/latest`, `/v1/k-line/candles` (30-day volatility), `/v3/fear-and-greed/latest`, `/v1/global-metrics/quotes/latest` | `agent/src/cmc.mjs` |
| Cournot Intelligence Oracle | `/intelligence/v1/resolve`, `/intelligence/v1/probability` (probability with evidence) | `agent/src/cournot.mjs` |
| Chainlink (BSC) | BNB/USD and BTC/USD, only where Atlas has no feed yet | `contracts/script/DeployHedge.s.sol` |

Usage can be checked two ways: the CMC API logs on our key, and the on-chain reads of the Atlas feed in each settlement transaction.

### Contract addresses (BSC mainnet)

TODO after deploy: PriceFeedAdjudicator, NodeFactory, MarketFactory, AMM, markets. They will also be in `contracts/deployments/56.json`.

### Next steps

- Move BNB and BTC markets to Atlas feeds when Atlas publishes them.
- A real stablecoin as collateral in place of the demo hUSD.
- Markets that the Creator agent opens and rolls each week.
- Idle collateral earns yield (for example Venus) while protection is open.
