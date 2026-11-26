// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AdjudicatorBase} from "sooth-factory/adjudicators/AdjudicatorBase.sol";
import {ITruthMarket} from "sooth-factory/interfaces/ITruthMarket.sol";

/// @notice Atlas Oracle push MultiFeed (docs.atlasoracle.io, oracle-atlas/push-oracle-interfaces).
interface IAtlasMultiFeed {
    struct PriceSnapshot {
        uint80 price;
        uint48 aggregatedTs;
        uint48 onchainTs;
    }

    function fetch(bytes4 feedId) external view returns (PriceSnapshot memory);
    function decimals() external view returns (uint8);
}

/// @notice Chainlink-style feed. Atlas SingleFeed contracts use this interface too.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80);
}

/**
 * @title PriceFeedAdjudicator
 * @notice Settles Sooth markets from an on-chain price feed. No person resolves.
 *         Anyone can call settleFromFeed; the adjudicator is its own resolver.
 *
 *         Market kinds (typeConfig.kind):
 *         - CLOSE_ABOVE / CLOSE_BELOW: the feed price that the first settleFromFeed
 *           call after the deadline reads decides. That price must be published at or
 *           after the deadline and no later than deadline + maxDelay, else INVALID.
 *           Any update inside that window can decide, so keep maxDelay short (a few
 *           heartbeats, at most MAX_DELAY_CAP) and run a keeper at each deadline.
 *         - TOUCH_ABOVE / TOUCH_BELOW: YES as soon as anyone shows a feed price past
 *           the strike, published after the market opened and before the deadline.
 *           At the deadline with no such proof, NO. A touch between two reads that
 *           nobody submits is missed; keepers read often (Atlas heartbeat is 60 s).
 *           Touch markets trade until settleFromFeed, so a trader can buy YES and settle
 *           in one transaction once the feed has crossed. Do not open them with real
 *           liquidity; the deploy scripts create CLOSE markets only.
 *
 *         Only feeds named at deployment can be used, and they are part of the
 *         frozen profile hash, so a market creator cannot bring a fake feed.
 */
contract PriceFeedAdjudicator is AdjudicatorBase {
    uint8 public constant SOURCE_ATLAS_MULTI = 0;
    uint8 public constant SOURCE_AGGREGATOR_V3 = 1;

    uint8 public constant KIND_CLOSE_ABOVE = 0;
    uint8 public constant KIND_CLOSE_BELOW = 1;
    uint8 public constant KIND_TOUCH_ABOVE = 2;
    uint8 public constant KIND_TOUCH_BELOW = 3;
    /// @notice Longest allowed read window after the deadline for CLOSE markets.
    uint64 public constant MAX_DELAY_CAP = 1 hours;

    struct Terms {
        uint8 source;
        address feed;
        bytes4 feedId; // Atlas MultiFeed id; zero for AggregatorV3
        uint8 kind;
        uint256 strikeWad; // 18 decimals
        uint64 maxDelay; // CLOSE kinds: latest accepted read after the deadline
    }

    mapping(address market => Terms) internal _terms;
    mapping(address market => uint64) public openedAt;
    mapping(address feed => bool) public feedAllowed;
    address[] private _feeds;

    event FeedTermsSet(
        address indexed market,
        uint8 source,
        address feed,
        bytes4 feedId,
        uint8 kind,
        uint256 strikeWad,
        uint64 maxDelay
    );
    event FeedObserved(
        address indexed market, uint256 priceWad, uint64 publishedAt, uint8 outcome
    );

    error FeedNotAllowed();
    error BadTerms();
    error NotCrossed();
    error TooEarly();
    error StalePrice();

    constructor(
        address _owner,
        address _marketFactory,
        uint48 _vetoPeriod,
        address[] memory feeds
    ) AdjudicatorBase(_owner, _marketFactory, _vetoPeriod) {
        require(feeds.length != 0, BadTerms());
        for (uint256 i; i < feeds.length; ++i) {
            require(feeds[i] != address(0) && !feedAllowed[feeds[i]], BadTerms());
            feedAllowed[feeds[i]] = true;
            _feeds.push(feeds[i]);
        }
    }

    // ─── Settlement ────────────────────────────────────────────────

    /// @notice Read the feed and propose the outcome it shows. Anyone can call.
    /// @return outcome 0 NO, 1 YES, 2 INVALID (a CLOSE market read too late)
    function settleFromFeed(address market) external returns (uint8 outcome) {
        Terms memory t = _terms[market];
        require(t.feed != address(0), BadTerms());
        (uint256 priceWad, uint64 ts) = _read(t);
        uint64 deadline = ITruthMarket(market).deadline();
        bool above = t.kind == KIND_CLOSE_ABOVE || t.kind == KIND_TOUCH_ABOVE;
        bool crossed = above ? priceWad >= t.strikeWad : priceWad <= t.strikeWad;

        if (t.kind == KIND_TOUCH_ABOVE || t.kind == KIND_TOUCH_BELOW) {
            if (ts < deadline && ts >= openedAt[market] && crossed) {
                outcome = OUTCOME_YES;
            } else {
                require(block.timestamp >= deadline, NotCrossed());
                outcome = OUTCOME_NO;
            }
        } else {
            require(block.timestamp >= deadline, TooEarly());
            require(ts >= deadline, StalePrice());
            outcome = ts <= uint256(deadline) + t.maxDelay
                ? (crossed ? OUTCOME_YES : OUTCOME_NO)
                : OUTCOME_INVALID;
        }

        emit FeedObserved(market, priceWad, ts, outcome);
        // The adjudicator is the market's only resolver, so it calls resolve itself.
        this.resolve(market, outcome, keccak256(abi.encode(t.feed, t.feedId, priceWad, ts)));
    }

    /// @notice The feed price (18 decimals) and its publish time.
    function readFeed(address market) external view returns (uint256 priceWad, uint64 ts) {
        return _read(_terms[market]);
    }

    function terms(address market) external view returns (Terms memory) {
        return _terms[market];
    }

    function feeds() external view returns (address[] memory) {
        return _feeds;
    }

    function adjudicatorType() external pure override returns (string memory) {
        return "price-feed";
    }

    // ─── Hooks ─────────────────────────────────────────────────────

    function _onConfigure(address market, bytes memory typeConfig) internal override {
        Terms memory t = abi.decode(typeConfig, (Terms));
        require(feedAllowed[t.feed], FeedNotAllowed());
        require(
            t.source <= SOURCE_AGGREGATOR_V3 && t.kind <= KIND_TOUCH_BELOW
                && t.strikeWad != 0,
            BadTerms()
        );
        require((t.source == SOURCE_ATLAS_MULTI) == (t.feedId != bytes4(0)), BadTerms());
        if (t.kind <= KIND_CLOSE_BELOW) {
            require(t.maxDelay != 0 && t.maxDelay <= MAX_DELAY_CAP, BadTerms());
        }
        _read(t); // the feed must answer now
        _terms[market] = t;
        openedAt[market] = uint64(block.timestamp);
        emit FeedTermsSet(market, t.source, t.feed, t.feedId, t.kind, t.strikeWad, t.maxDelay);
    }

    function _profileExtension() internal view override returns (bytes memory) {
        return abi.encode("PRICE_FEED_V1", _feeds);
    }

    function _requiresAttestation() internal pure override returns (bool) {
        return false;
    }

    function _verifyAttestation(address, bytes calldata) internal pure override {}

    // ─── Feed reads ────────────────────────────────────────────────

    function _read(Terms memory t) internal view returns (uint256 priceWad, uint64 ts) {
        if (t.source == SOURCE_ATLAS_MULTI) {
            IAtlasMultiFeed f = IAtlasMultiFeed(t.feed);
            IAtlasMultiFeed.PriceSnapshot memory s = f.fetch(t.feedId);
            require(s.price != 0 && s.aggregatedTs != 0, StalePrice());
            priceWad = _scale(uint256(s.price), f.decimals());
            ts = uint64(s.aggregatedTs);
        } else {
            IAggregatorV3 f = IAggregatorV3(t.feed);
            (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
            require(answer > 0 && updatedAt != 0, StalePrice());
            priceWad = _scale(uint256(answer), f.decimals());
            ts = uint64(updatedAt);
        }
    }

    function _scale(uint256 v, uint8 dec) private pure returns (uint256) {
        if (dec == 18) return v;
        return dec < 18 ? v * 10 ** (18 - dec) : v / 10 ** (dec - 18);
    }
}
