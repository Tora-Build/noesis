# NOESIS: submission

Price the Unknown. Autonomous financial intelligence infrastructure, built on Sooth.

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

- Repository: https://github.com/Tora-Build/noesis
- Live demo: https://noesis-7fg.pages.dev
- Video (3 minutes or less): TODO

## One-page write-up

### Problem and audience

People who hold tokenized stocks on BNB Chain (for example IWMB) have no simple way to protect against a price drop. Options desks are not on-chain, and insurance cover needs a claims vote.

NOESIS sells protection as a market: "You pay $X. You get $Y if IWMB is below $260 on Dec 1." Atlas Oracle settles it on-chain. No person decides the result. A risk agent prices every strike from CoinMarketCap data and Cournot evidence, and trades when the market price is wrong.

On the page you drag a floor line on the live Atlas price chart. One level pays a fixed amount below the floor. Staircase spreads the cover over several levels, so the payout grows as the price falls, like a put. A multi-path view shows each level with its market chance and the agent's fair price. With a wallet connected, the page reads your real IWMB, EWZB and BNB balances.

Audience: holders of tokenized stocks and BNB who want downside protection, and traders and agents who want to sell it.

### Endpoints and feeds

| Source | What we use | Where in the code |
|---|---|---|
| Atlas Oracle MultiFeed (BSC mainnet) | `fetch(bytes4)` for settlement and live price | `contracts/src/PriceFeedAdjudicator.sol`, `web/app.js` |
| CoinMarketCap Pro API | `/v3/cryptocurrency/quotes/latest`, `/v1/k-line/candles` (BNB volatility), 1d to 90d price changes from quotes (volatility for tokenized stocks), `/v3/fear-and-greed/latest`, `/v1/global-metrics/quotes/latest` | `agent/src/cmc.mjs` |
| Cournot Intelligence Oracle | `/intelligence/v1/resolve`, `/intelligence/v1/probability` (probability with evidence) | `agent/src/cournot.mjs` |
| Chainlink (BSC) | BNB/USD and BTC/USD, only where Atlas has no feed yet | `contracts/script/DeployHedge.s.sol` |

Usage can be checked two ways: the CMC API logs on our key, and the on-chain reads of the Atlas feed in each settlement transaction.

### Contract addresses (BSC mainnet)

| Contract | Address |
|---|---|
| adjudicator | [`0xa17feCd30c8E1c2C9BcfE19469f20EFF4e7e2be9`](https://bscscan.com/address/0xa17feCd30c8E1c2C9BcfE19469f20EFF4e7e2be9) |
| marketFactory | [`0x6791413bd196c065d4Ff456F319Db94CA1db44f2`](https://bscscan.com/address/0x6791413bd196c065d4Ff456F319Db94CA1db44f2) |
| amm | [`0xDcb89dB01415885FF8EC1F74E50386C8673B0557`](https://bscscan.com/address/0xDcb89dB01415885FF8EC1F74E50386C8673B0557) |
| nodeFactory | [`0x5Dd9B526cf00dc00Eeb7fe2de8c2AB8ac5Ac52cE`](https://bscscan.com/address/0x5Dd9B526cf00dc00Eeb7fe2de8c2AB8ac5Ac52cE) |
| registry | [`0xBfC8D0157e0Aea4f5eEE1F5eA7c58cf092169b2e`](https://bscscan.com/address/0xBfC8D0157e0Aea4f5eEE1F5eA7c58cf092169b2e) |
| stable | [`0x43614DeE734791F241328a8d70fC4c975ccC3778`](https://bscscan.com/address/0x43614DeE734791F241328a8d70fC4c975ccC3778) |

`stable` is hUSD-DEMO, a demo token with no value.

| Market | Address |
|---|---|
| IWMB below $265 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0xe6a4830f3A5E650aACB1C90e42D68644f719eAAd`](https://bscscan.com/address/0xe6a4830f3A5E650aACB1C90e42D68644f719eAAd) |
| IWMB below $262 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0x760CFE1724ECc31f8b5FaA9832b0772E1664F52b`](https://bscscan.com/address/0x760CFE1724ECc31f8b5FaA9832b0772E1664F52b) |
| IWMB below $257 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0xF5A4830030dD92293D8084B85A272CAF55c09C43`](https://bscscan.com/address/0xF5A4830030dD92293D8084B85A272CAF55c09C43) |
| BNB below $530 at 2026-12-01 21:00 UTC (Chainlink) | [`0xac3142571C30E8BB79633D1E00061598577B292B`](https://bscscan.com/address/0xac3142571C30E8BB79633D1E00061598577B292B) |
| IWMB below $268 at 2026-11-26 18:00 UTC (Atlas Oracle) | [`0xBBFDd23ED7a16FE31Ee8eCb54bF1f0EcdB9aea4f`](https://bscscan.com/address/0xBBFDd23ED7a16FE31Ee8eCb54bF1f0EcdB9aea4f) |
| IWMB below $268 at 2026-11-27 08:10 UTC (Atlas Oracle) | [`0x76DB6d06D715d8191A4703a3391342fC59Fb17e9`](https://bscscan.com/address/0x76DB6d06D715d8191A4703a3391342fC59Fb17e9) |
| EWZB below $30.6 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0x8B51Fb36E83ca23C7EfbD316E87648D85BD45cd0`](https://bscscan.com/address/0x8B51Fb36E83ca23C7EfbD316E87648D85BD45cd0) |
| EWZB below $30.4 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0x22c7803f59803EB0B0771A715DEF5E00fF30687C`](https://bscscan.com/address/0x22c7803f59803EB0B0771A715DEF5E00fF30687C) |
| EWZB below $29.8 at 2026-12-01 21:00 UTC (Atlas Oracle) | [`0xCb7418F01429E7Fbf11bEC081737d32AFfC1cCFc`](https://bscscan.com/address/0xCb7418F01429E7Fbf11bEC081737d32AFfC1cCFc) |
| BNB below $465.00 at 2026-11-27 22:00 UTC (Chainlink) | [`0x4fB5166B9038756e88F522dbCce8F0A69bbBf146`](https://bscscan.com/address/0x4fB5166B9038756e88F522dbCce8F0A69bbBf146) |
| BNB below $450.00 at 2026-11-27 22:00 UTC (Chainlink) | [`0x2aF678988d67d03741B46a9E40B56Be4caAbE4e7`](https://bscscan.com/address/0x2aF678988d67d03741B46a9E40B56Be4caAbE4e7) |

Agent trades on mainnet (CMC-priced): BUY NO on IWMB $262 [`0x43404133…3197`](https://bscscan.com/tx/0x43404133605c50e799b9ba1683c0c605a5114dbc1cc0d88ee2e8de8952fd3197), BUY YES on EWZB $30.40 [`0xcd64e62d…`](https://bscscan.com/tx/0xcd64e62dd3398972d0cce2f0260692e4dab4f784135307eab17570672c1fb9cc) and EWZB $29.80 [`0xe188f0c1…`](https://bscscan.com/tx/0xe188f0c194cbf658ea11d276bcc641bdca49342f8a4a0c506fb890db50821f12).

Cournot: the two BNB markets at 2026-11-27 22:00 UTC state the opposite claim of Cournot markets 113137 and 113109. The agent uses 1 - p from Cournot (1% and 10%) with its evidence.

The adjudicator has no guardian and a veto period of 0: only the feed decides.

### Next steps

- Move BNB and BTC markets to Atlas feeds when Atlas publishes them.
- A real stablecoin as collateral in place of the demo hUSD.
- Markets that the Creator agent opens and rolls each week.
- Idle collateral earns yield (for example Venus) while protection is open.
