// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console2} from "forge-std/Script.sol";
import {HedgeSetup} from "./HedgeSetup.sol";

/// @notice Deploy one Sooth node and the PriceFeedAdjudicator on BSC.
///
///   PRIVATE_KEY=0x… forge script script/DeployHedge.s.sol --rpc-url bsc --broadcast
///
/// Env: PRIVATE_KEY (required), STABLE (optional collateral; empty deploys the hUSD demo
/// token), VETO_SECONDS (default 0: no guardian, only the feed decides). Writes
/// deployments/<chainId>.json. An anvil fork of BSC also has chain id 56: set
/// DEPLOYMENT_FILE for fork runs so the mainnet file is never overwritten.
contract DeployHedge is Script, HedgeSetup {
    /// Atlas Oracle push MultiFeed, BSC mainnet (atlasoracle.io/feeds).
    address constant ATLAS_MULTIFEED = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    /// Chainlink BNB/USD and BTC/USD, BSC mainnet. Used until Atlas adds these pairs.
    address constant CHAINLINK_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant CHAINLINK_BTC_USD = 0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf;

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(key);
        address stable = vm.envOr("STABLE", address(0));
        uint48 veto = uint48(vm.envOr("VETO_SECONDS", uint256(0)));
        address[] memory feeds = new address[](3);
        feeds[0] = ATLAS_MULTIFEED;
        feeds[1] = CHAINLINK_BNB_USD;
        feeds[2] = CHAINLINK_BTC_USD;

        vm.startBroadcast(key);
        Deployment memory d = _deployAll(admin, stable, veto, feeds);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "block", block.number);
        vm.serializeAddress(k, "admin", admin);
        vm.serializeAddress(k, "stable", d.stable);
        vm.serializeAddress(k, "registry", d.registry);
        vm.serializeAddress(k, "nodeFactory", d.factory);
        vm.serializeAddress(k, "roles", d.node.roles);
        vm.serializeAddress(k, "book", d.node.book);
        vm.serializeAddress(k, "amm", d.node.amm);
        vm.serializeAddress(k, "ammVault", d.node.ammVault);
        vm.serializeAddress(k, "bookVault", d.node.bookVault);
        vm.serializeAddress(k, "marketFactory", d.node.marketFactory);
        vm.serializeAddress(k, "positionManager", d.node.positionManager);
        vm.serializeAddress(k, "atlasMultiFeed", ATLAS_MULTIFEED);
        vm.serializeAddress(k, "chainlinkBnbUsd", CHAINLINK_BNB_USD);
        vm.serializeAddress(k, "chainlinkBtcUsd", CHAINLINK_BTC_USD);
        string memory out = vm.serializeAddress(k, "adjudicator", d.adjudicator);
        string memory path =
            vm.envOr(
                "DEPLOYMENT_FILE",
                string.concat("deployments/", vm.toString(block.chainid), ".json")
            );
        vm.writeJson(out, path);
        console2.log("adjudicator", d.adjudicator);
        console2.log("marketFactory", d.node.marketFactory);
        console2.log("amm", d.node.amm);
        console2.log("stable", d.stable);
        console2.log("written", path);
    }
}

/// @notice Create one price market on the deployed node.
///
///   PRIVATE_KEY=0x… QUESTION="…" DEADLINE=1796101200 SOURCE=1 FEED=0x… KIND=2 \
///   STRIKE=600e18 PROB=0.3e18 forge script script/DeployHedge.s.sol:CreateMarket \
///   --rpc-url bsc --broadcast
///
/// Env: QUESTION, DEADLINE (unix s), SOURCE (0 Atlas, 1 AggregatorV3), FEED, FEED_ID
/// (Atlas numeric id, 0 for AggregatorV3), KIND (0 close above, 1 close below, 2 touch
/// above, 3 touch below), STRIKE (wei, 18 dec), PROB (wad), BBASE (default 200e18),
/// MAX_DELAY (default 3600), MAX_INPUT (default 1000e18).
contract CreateMarket is Script, HedgeSetup {
    function run() external returns (address market) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        string memory path =
            vm.envOr(
                "DEPLOYMENT_FILE",
                string.concat("deployments/", vm.toString(block.chainid), ".json")
            );
        string memory json = vm.readFile(path);
        Deployment memory d;
        d.stable = vm.parseJsonAddress(json, ".stable");
        d.adjudicator = vm.parseJsonAddress(json, ".adjudicator");
        d.node.marketFactory = vm.parseJsonAddress(json, ".marketFactory");
        d.node.ammVault = vm.parseJsonAddress(json, ".ammVault");
        d.node.bookVault = vm.parseJsonAddress(json, ".bookVault");

        NewMarket memory m;
        m.question = vm.envString("QUESTION");
        m.deadline = uint64(vm.envUint("DEADLINE"));
        m.terms.source = uint8(vm.envUint("SOURCE"));
        m.terms.feed = vm.envAddress("FEED");
        m.terms.feedId = bytes4(uint32(vm.envOr("FEED_ID", uint256(0))));
        m.terms.kind = uint8(vm.envUint("KIND"));
        // Touch markets can be bought and settled in one transaction after a cross.
        require(m.terms.kind <= 1 || vm.envOr("ALLOW_TOUCH", false), "TOUCH_DISABLED");
        m.terms.strikeWad = vm.envUint("STRIKE");
        m.terms.maxDelay = uint64(vm.envOr("MAX_DELAY", uint256(300)));
        m.initialProbabilityWad = vm.envUint("PROB");
        m.bBase = vm.envOr("BBASE", uint256(200e18));
        m.maxInput = vm.envOr("MAX_INPUT", uint256(1000e18));

        vm.startBroadcast(key);
        (bool ok, bytes memory owner) = d.stable.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && abi.decode(owner, (address)) == vm.addr(key)) {
            (ok,) = d.stable.call(
                abi.encodeWithSignature("mint(address,uint256)", vm.addr(key), m.maxInput)
            );
            require(ok, "MINT");
        }
        (ok,) = d.stable.call(
            abi.encodeWithSignature("approve(address,uint256)", d.node.marketFactory, m.maxInput)
        );
        require(ok, "APPROVE");
        market = _createMarket(d, m);
        vm.stopBroadcast();
        // The address printed in simulation can differ from the mined one. Read the
        // market from the MarketConfigured event of the adjudicator.
        console2.log("market (simulated)", market);
    }
}
