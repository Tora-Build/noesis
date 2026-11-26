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
- Live demo: https://tora-build.github.io/sooth-hedge/
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

Agent trade on mainnet (BUY NO on the $262 level, CMC-priced): [`0x43404133…3197`](https://bscscan.com/tx/0x43404133605c50e799b9ba1683c0c605a5114dbc1cc0d88ee2e8de8952fd3197).

The adjudicator has no guardian and a veto period of 0: only the feed decides.

### Next steps

- Move BNB and BTC markets to Atlas feeds when Atlas publishes them.
- A real stablecoin as collateral in place of the demo hUSD.
- Markets that the Creator agent opens and rolls each week.
- Idle collateral earns yield (for example Venus) while protection is open.
