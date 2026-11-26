// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {HedgeSetup, HedgeUSD} from "../script/HedgeSetup.sol";
import {PriceFeedAdjudicator} from "../src/PriceFeedAdjudicator.sol";
import {AdjudicatorBase} from "sooth-factory/adjudicators/AdjudicatorBase.sol";
import {AMMEngine} from "sooth-factory/AMMEngine.sol";
import {TruthMarket} from "sooth-factory/TruthMarket.sol";

contract MockAtlas {
    struct Snap {
        uint80 price;
        uint48 aggregatedTs;
        uint48 onchainTs;
    }

    mapping(bytes4 => Snap) public snaps;

    function set(bytes4 id, uint80 price, uint256 ts) external {
        snaps[id] = Snap(price, uint48(ts), uint48(ts));
    }

    function fetch(bytes4 id) external view returns (Snap memory) {
        return snaps[id];
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract PriceFeedAdjudicatorTest is Test, HedgeSetup {
    address admin = makeAddr("admin");
    address trader = makeAddr("trader");
    MockAtlas atlas;
    MockAggregator chainlink;
    Deployment d;
    PriceFeedAdjudicator adj;
    bytes4 constant IWMB = bytes4(uint32(1166));
    uint48 constant VETO = 10 minutes;

    function setUp() public {
        vm.warp(1_800_000_000);
        atlas = new MockAtlas();
        chainlink = new MockAggregator();
        atlas.set(IWMB, 269e18, uint48(block.timestamp));
        chainlink.set(600e8, block.timestamp);
        address[] memory feeds = new address[](2);
        feeds[0] = address(atlas);
        feeds[1] = address(chainlink);
        vm.startPrank(admin);
        d = _deployAll(admin, address(0), VETO, feeds);
        HedgeUSD(d.stable).mint(admin, 1_000_000e18);
        HedgeUSD(d.stable).approve(d.node.marketFactory, type(uint256).max);
        vm.stopPrank();
        adj = PriceFeedAdjudicator(d.adjudicator);

        vm.prank(trader);
        HedgeUSD(d.stable).faucet();
        vm.prank(trader);
        HedgeUSD(d.stable).approve(d.node.amm, type(uint256).max);
    }

    function _market(uint8 source, address feed, bytes4 id, uint8 kind, uint256 strike)
        internal
        returns (address m)
    {
        NewMarket memory n;
        n.question = "test market";
        n.deadline = uint64(block.timestamp + 1 days);
        n.terms = PriceFeedAdjudicator.Terms(source, feed, id, kind, strike, 1 hours);
        n.initialProbabilityWad = 0.4e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        vm.startPrank(admin);
        m = _createMarket(d, n);
        vm.stopPrank();
    }

    function _settle(address m) internal {
        vm.warp(block.timestamp + VETO);
        adj.settle(m);
        assertTrue(TruthMarket(m).isSettled());
    }

    function test_touchAbove_yesWhenCrossed() public {
        address m = _market(0, address(atlas), IWMB, 2, 275e18);
        vm.expectRevert(PriceFeedAdjudicator.NotCrossed.selector);
        adj.settleFromFeed(m);

        // A trader buys YES before the touch.
        vm.prank(trader);
        AMMEngine(d.node.amm).tradePositions(m, 1, int256(50e18), 100e18);

        vm.warp(block.timestamp + 1 hours);
        atlas.set(IWMB, 276e18, uint48(block.timestamp));
        assertEq(adj.settleFromFeed(m), 1);
        assertEq(adj.getOutcome(m), 1);
        _settle(m);

        uint256 before = HedgeUSD(d.stable).balanceOf(trader);
        vm.prank(trader);
        AMMEngine(d.node.amm).settlePosition(m);
        assertEq(HedgeUSD(d.stable).balanceOf(trader) - before, 50e18, "50 YES pays 50");
    }

    function test_touch_oldPriceDoesNotCount() public {
        // The feed showed a crossing price before the market opened.
        atlas.set(IWMB, 280e18, uint48(block.timestamp - 1));
        address m = _market(0, address(atlas), IWMB, 2, 275e18);
        vm.expectRevert(PriceFeedAdjudicator.NotCrossed.selector);
        adj.settleFromFeed(m);
    }

    function test_touchAbove_noAtDeadline() public {
        address m = _market(0, address(atlas), IWMB, 2, 275e18);
        vm.warp(block.timestamp + 1 days);
        atlas.set(IWMB, 270e18, uint48(block.timestamp));
        assertEq(adj.settleFromFeed(m), 0);
        _settle(m);
    }

    function test_touchBelow_chainlink() public {
        address m = _market(1, address(chainlink), bytes4(0), 3, 550e18);
        vm.warp(block.timestamp + 10);
        chainlink.set(549e8, block.timestamp);
        assertEq(adj.settleFromFeed(m), 1);
    }

    function test_closeAbove_rules() public {
        address m = _market(0, address(atlas), IWMB, 0, 270e18);
        vm.expectRevert(PriceFeedAdjudicator.TooEarly.selector);
        adj.settleFromFeed(m);

        uint64 deadline = TruthMarket(m).deadline();
        vm.warp(deadline + 5);
        // Latest price is from before the deadline.
        atlas.set(IWMB, 271e18, deadline - 1);
        vm.expectRevert(PriceFeedAdjudicator.StalePrice.selector);
        adj.settleFromFeed(m);

        atlas.set(IWMB, 271e18, deadline + 2);
        assertEq(adj.settleFromFeed(m), 1);
        _settle(m);
    }

    function test_closeBelow_no() public {
        address m = _market(0, address(atlas), IWMB, 1, 260e18);
        uint64 deadline = TruthMarket(m).deadline();
        vm.warp(deadline + 60);
        atlas.set(IWMB, 265e18, deadline + 30);
        assertEq(adj.settleFromFeed(m), 0);
    }

    function test_close_lateReadIsInvalid() public {
        address m = _market(0, address(atlas), IWMB, 0, 270e18);
        uint64 deadline = TruthMarket(m).deadline();
        vm.warp(deadline + 2 hours);
        atlas.set(IWMB, 271e18, deadline + 2 hours);
        assertEq(adj.settleFromFeed(m), 2);
    }

    function test_guardianVeto_thenFeedAgain() public {
        address m = _market(0, address(atlas), IWMB, 2, 275e18);
        vm.warp(block.timestamp + 60);
        atlas.set(IWMB, 276e18, uint48(block.timestamp));
        adj.settleFromFeed(m);
        vm.prank(admin);
        adj.dispute(m);
        assertEq(adj.getPhase(m), 5);
        // Only the feed can resolve again.
        vm.prank(admin);
        vm.expectRevert();
        adj.resolve(m, 0, bytes32(0));
        assertEq(adj.settleFromFeed(m), 1);
    }

    function test_onlyFeedResolves() public {
        address m = _market(0, address(atlas), IWMB, 2, 275e18);
        vm.prank(admin);
        vm.expectRevert();
        adj.resolve(m, 1, bytes32(0));
    }

    function test_unknownFeedRejected() public {
        MockAtlas fake = new MockAtlas();
        fake.set(IWMB, 1e18, uint48(block.timestamp));
        NewMarket memory n;
        n.question = "fake";
        n.deadline = uint64(block.timestamp + 1 days);
        n.terms = PriceFeedAdjudicator.Terms(0, address(fake), IWMB, 2, 2e18, 1 hours);
        n.initialProbabilityWad = 0.5e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        vm.expectRevert(PriceFeedAdjudicator.FeedNotAllowed.selector);
        this.createExternal(n);
    }

    function createExternal(NewMarket memory n) external returns (address m) {
        vm.startPrank(admin);
        m = _createMarket(d, n);
        vm.stopPrank();
    }

    function test_badTerms() public {
        NewMarket memory n;
        n.question = "bad";
        n.deadline = uint64(block.timestamp + 1 days);
        // Atlas source without a feed id.
        n.terms = PriceFeedAdjudicator.Terms(0, address(atlas), bytes4(0), 2, 2e18, 1 hours);
        n.initialProbabilityWad = 0.5e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        vm.expectRevert(PriceFeedAdjudicator.BadTerms.selector);
        this.createExternal(n);
    }

    function test_faucetOncePerDay() public {
        vm.prank(trader);
        vm.expectRevert(bytes("ONCE_A_DAY"));
        HedgeUSD(d.stable).faucet();
    }

    function test_maxDelayCap() public {
        NewMarket memory n;
        n.question = "long window";
        n.deadline = uint64(block.timestamp + 1 days);
        n.terms = PriceFeedAdjudicator.Terms(0, address(atlas), IWMB, 1, 260e18, 1 hours + 1);
        n.initialProbabilityWad = 0.3e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        vm.expectRevert(PriceFeedAdjudicator.BadTerms.selector);
        this.createExternal(n);
    }

    function test_close_windowEdges() public {
        // A price published exactly at the deadline decides.
        address m = _market(0, address(atlas), IWMB, 1, 270e18);
        uint64 deadline = TruthMarket(m).deadline();
        vm.warp(deadline);
        atlas.set(IWMB, 270e18, deadline);
        assertEq(adj.settleFromFeed(m), 1, "price == strike counts for close below");

        // A price published exactly at deadline + maxDelay is still valid.
        address m2 = _market(0, address(atlas), IWMB, 1, 260e18);
        uint64 d2 = TruthMarket(m2).deadline();
        vm.warp(d2 + 1 hours);
        atlas.set(IWMB, 265e18, d2 + 1 hours);
        assertEq(adj.settleFromFeed(m2), 0);

        // A price published before the deadline cannot settle a close market.
        address m3 = _market(0, address(atlas), IWMB, 1, 260e18);
        vm.warp(TruthMarket(m3).deadline());
        atlas.set(IWMB, 250e18, uint48(block.timestamp - 1));
        vm.expectRevert(PriceFeedAdjudicator.StalePrice.selector);
        adj.settleFromFeed(m3);
    }
}

/// @notice The mainnet setup: veto period 0, no guardian. Only the feed decides.
contract NoGuardianTest is Test, HedgeSetup {
    address admin = makeAddr("admin");
    address trader = makeAddr("trader");

    function test_noGuardian_feedOnly() public {
        vm.warp(1_800_000_000);
        MockAtlas atlas = new MockAtlas();
        bytes4 id = bytes4(uint32(1166));
        atlas.set(id, 269e18, uint48(block.timestamp));
        address[] memory feeds = new address[](1);
        feeds[0] = address(atlas);
        vm.startPrank(admin);
        Deployment memory d = _deployAll(admin, address(0), 0, feeds);
        HedgeUSD(d.stable).mint(admin, 10_000e18);
        HedgeUSD(d.stable).approve(d.node.marketFactory, type(uint256).max);
        NewMarket memory n;
        n.question = "IWMB below 265";
        n.deadline = uint64(block.timestamp + 1 days);
        n.terms = PriceFeedAdjudicator.Terms(0, address(atlas), id, 1, 265e18, 5 minutes);
        n.initialProbabilityWad = 0.3e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        address m = _createMarket(d, n);
        vm.stopPrank();

        PriceFeedAdjudicator adj = PriceFeedAdjudicator(d.adjudicator);
        assertEq(adj.guardians().length, 0, "no guardian");
        assertEq(adj.vetoPeriod(), 0);

        vm.warp(n.deadline + 30);
        atlas.set(id, 264e18, uint48(block.timestamp));
        assertEq(adj.settleFromFeed(m), 1);

        // Nobody can veto, not even the admin.
        vm.prank(admin);
        vm.expectRevert();
        adj.dispute(m);

        // With no veto window the result can be finalized at once.
        adj.settle(m);
        assertTrue(TruthMarket(m).isSettled());
    }
}

/// @notice Reads the real Atlas MultiFeed on a BSC mainnet fork. Runs only with BSC_RPC_URL.
contract AtlasForkTest is Test, HedgeSetup {
    address constant ATLAS = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    bytes4 constant EWZB = bytes4(uint32(1165));

    function test_fork_realAtlasTouch() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        address admin = makeAddr("admin");
        address[] memory feeds = new address[](1);
        feeds[0] = ATLAS;
        vm.startPrank(admin);
        Deployment memory d = _deployAll(admin, address(0), 10 minutes, feeds);
        HedgeUSD(d.stable).mint(admin, 10_000e18);
        HedgeUSD(d.stable).approve(d.node.marketFactory, type(uint256).max);
        vm.stopPrank();
        PriceFeedAdjudicator adj = PriceFeedAdjudicator(d.adjudicator);

        NewMarket memory n;
        n.question = "EWZB above $1 before deadline";
        n.deadline = uint64(block.timestamp + 1 days);
        n.terms = PriceFeedAdjudicator.Terms(0, ATLAS, EWZB, 2, 1e18, 1 hours);
        n.initialProbabilityWad = 0.5e18;
        n.bBase = 100e18;
        n.maxInput = 1000e18;
        vm.startPrank(admin);
        address m = _createMarket(d, n);
        vm.stopPrank();
        (uint256 price, uint64 ts) = adj.readFeed(m);
        emit log_named_decimal_uint("EWZB/USD from Atlas", price, 18);
        assertGt(price, 1e18);
        assertGt(ts, 0);
        // The price was published before the market opened, so it does not count yet.
        vm.expectRevert(PriceFeedAdjudicator.NotCrossed.selector);
        adj.settleFromFeed(m);
    }
}
