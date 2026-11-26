// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {CommonBase} from "forge-std/Base.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NodeFactory} from "sooth-factory/factory/NodeFactory.sol";
import {NodeDeployer} from "sooth-factory/factory/NodeDeployer.sol";
import {NodeTypes} from "sooth-factory/factory/NodeTypes.sol";
import {ReleaseRegistry} from "sooth-factory/factory/ReleaseRegistry.sol";
import {CreationCodeStore} from "sooth-factory/factory/CreationCodeStore.sol";
import {NodeRoles} from "sooth-factory/policy/NodeRoles.sol";
import {TruthMarket} from "sooth-factory/TruthMarket.sol";
import {MarketFactory} from "sooth-factory/MarketFactory.sol";
import {AMMEngine} from "sooth-factory/AMMEngine.sol";
import {OrderEngine} from "sooth-factory/OrderEngine.sol";
import {AmmFeeVault} from "sooth-factory/AmmFeeVault.sol";
import {BookFeeVault} from "sooth-factory/BookFeeVault.sol";
import {IMarketFactory} from "sooth-factory/interfaces/IMarketFactory.sol";
import {IAmmFeeVault} from "sooth-factory/interfaces/IAmmFeeVault.sol";
import {IBookFeeVault} from "sooth-factory/interfaces/IBookFeeVault.sol";
import {PriceFeedAdjudicator} from "../src/PriceFeedAdjudicator.sol";

/// @notice Demo collateral for the hackathon node. It has no value. Anyone can take
///         1,000 hUSD from the faucet once a day; the owner can mint.
contract HedgeUSD is ERC20 {
    address public immutable owner;
    uint256 public constant FAUCET_AMOUNT = 1000e18;
    mapping(address => uint256) public lastFaucet;

    constructor(address _owner) ERC20("Sooth Hedge Demo USD (no value)", "hUSD-DEMO") {
        owner = _owner;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "OWNER");
        _mint(to, amount);
    }

    function faucet() external {
        require(block.timestamp >= lastFaucet[msg.sender] + 1 days, "ONCE_A_DAY");
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}

/// @notice One Sooth node with a PriceFeedAdjudicator. One admin key holds every
///         role (protocol owner, node admin and profile owner). With vetoPeriod 0 there
///         is no guardian: only the feed decides. With vetoPeriod > 0 the admin is
///         also the guardian and can veto a feed result.
abstract contract HedgeSetup is CommonBase {
    bytes32 internal constant RELEASE = keccak256("sooth-hedge-bnb-v1");
    /// sooth-factory v0.1.1 (765fa25)
    bytes20 internal constant FACTORY_REVISION =
        bytes20(hex"765fa25bb07bb7975bf5d713178c4f8cc3baadc0");

    struct Deployment {
        address stable;
        address registry;
        address factory;
        NodeTypes.Addresses node;
        address adjudicator;
    }

    /// @dev Call while broadcasting (script) or pranking (test) as `admin`.
    function _deployAll(
        address admin,
        address stable,
        uint48 vetoPeriod,
        address[] memory feeds
    ) internal returns (Deployment memory d) {
        d.stable = stable == address(0) ? address(new HedgeUSD(admin)) : stable;
        ReleaseRegistry registry = new ReleaseRegistry(admin);
        d.registry = address(registry);
        _publishRelease(registry, admin, d.stable);
        NodeFactory factory = new NodeFactory(d.registry);
        d.factory = address(factory);
        d.node = _createNode(factory, registry, admin, d.stable);

        PriceFeedAdjudicator adj =
            new PriceFeedAdjudicator(admin, d.node.marketFactory, vetoPeriod, feeds);
        if (vetoPeriod != 0) adj.approveGuardian(admin);
        adj.approveResolver(address(adj)); // only the feed resolves
        adj.setEarlyResolution(true); // TOUCH markets settle when the strike is hit
        adj.freezeProfile();
        d.adjudicator = address(adj);

        MarketFactory mf = MarketFactory(d.node.marketFactory);
        mf.setInvalidationBuffer(7 days);
        mf.setTokenAllowed(d.stable, true, mf.TOKEN_RISK_ACKNOWLEDGEMENT());
        mf.setAdjudicatorAllowed(d.adjudicator, true);
    }

    function _publishRelease(ReleaseRegistry registry, address admin, address stable)
        private
    {
        TruthMarket truth = new TruthMarket();
        ReleaseRegistry.CodeInput[6] memory codes = _storeAll();
        bytes32[6] memory hashes;
        for (uint256 i; i < 6; ++i) {
            hashes[i] = codes[i].creationHash;
        }
        registry.setStablecoin(stable, true);
        registry.publishBookPolicy(
            stable,
            NodeTypes.BookPolicy(admin, admin, 500, IBookFeeVault.BookConfig(100, 2000, 8000, admin))
        );
        registry.publishRelease(
            RELEASE,
            FACTORY_REVISION,
            keccak256(abi.encode("sooth-hedge", hashes)),
            address(truth),
            keccak256(vm.getCode("NodeDeployer.sol:NodeDeployer")),
            codes
        );
    }

    function _storeAll() private returns (ReleaseRegistry.CodeInput[6] memory codes) {
        string[6] memory names = [
            "NodeRoles.sol:NodeRoles",
            "OrderEngine.sol:OrderEngine",
            "AMMEngine.sol:AMMEngine",
            "AmmFeeVault.sol:AmmFeeVault",
            "BookFeeVault.sol:BookFeeVault",
            "MarketFactory.sol:MarketFactory"
        ];
        for (uint256 i; i < 6; ++i) {
            codes[i] = _store(vm.getCode(names[i]));
        }
    }

    function _createNode(
        NodeFactory factory,
        ReleaseRegistry registry,
        address admin,
        address stable
    ) private returns (NodeTypes.Addresses memory) {
        NodeTypes.Request memory r;
        r.releaseId = RELEASE;
        r.userSalt = keccak256("sooth-hedge-node-1");
        r.requester = admin;
        r.nodeAdmin = admin;
        r.bookToken = stable;
        r.ammSurplusRecipient = admin;
        r.expiry = uint64(block.timestamp + 1 days);
        r.expectedBookPolicyVersion = registry.activeBookPolicyVersion(stable);
        r.expectedBookPolicyHash =
            registry.bookPolicyHash(stable, r.expectedBookPolicyVersion);
        // 1% AMM fee: 80% to LPs, 10% resolution, 10% operator.
        r.ammConfig = IAmmFeeVault.AmmConfig(100, 0, 8000, 1000, 1000, admin);
        factory.beginNode(r);
        (, NodeTypes.Addresses memory a) = factory.completeNode(r);
        return a;
    }

    function _store(bytes memory code)
        private
        returns (ReleaseRegistry.CodeInput memory input)
    {
        input.length = uint32(code.length);
        input.creationHash = keccak256(code);
        uint256 count = (code.length + 24_574) / 24_575;
        input.chunks = new address[](count);
        for (uint256 c; c < count; ++c) {
            uint256 offset = c * 24_575;
            uint256 length = code.length - offset;
            if (length > 24_575) length = 24_575;
            bytes memory chunk = new bytes(length);
            for (uint256 i; i < length; ++i) {
                chunk[i] = code[offset + i];
            }
            input.chunks[c] = address(new CreationCodeStore(chunk));
        }
    }

    struct NewMarket {
        string question;
        uint64 deadline;
        PriceFeedAdjudicator.Terms terms;
        uint256 initialProbabilityWad;
        uint256 bBase; // LMSR depth, 18 decimals
        uint256 maxInput; // collateral the creator may spend, native units
    }

    /// @dev The creator must have approved the market factory for `maxInput`.
    function _createMarket(Deployment memory d, NewMarket memory m)
        internal
        returns (address market)
    {
        IMarketFactory.MarketParams memory p;
        p.question = m.question;
        p.startTime = 0; // the factory uses the block time
        p.deadline = m.deadline;
        p.adjudicator = d.adjudicator;
        p.tokenA = d.stable;
        p.bBase = m.bBase;
        p.initialProbabilityWad = m.initialProbabilityWad;
        p.adjudicatorConfig = abi.encode(d.adjudicator, m.deadline, abi.encode(m.terms));
        p.maxInputNative = m.maxInput;
        p.quoteDeadline = uint64(block.timestamp + 1 hours);
        IAmmFeeVault ammVault = IAmmFeeVault(d.node.ammVault);
        IBookFeeVault bookVault = IBookFeeVault(d.node.bookVault);
        p.expectedAmmVersion = ammVault.activeConfigVersion();
        p.expectedBookVersion = bookVault.activeConfigVersion();
        p.expectedAmmHash = ammVault.configHash(p.expectedAmmVersion);
        p.expectedBookHash = bookVault.configHash(p.expectedBookVersion);
        p.resolutionTermsHash = keccak256(abi.encode(m.question, m.terms));
        p.expectedProfileHash = PriceFeedAdjudicator(d.adjudicator).profileHash();
        p.expectedInvalidationBuffer = MarketFactory(d.node.marketFactory).invalidationBuffer();
        (market,) = MarketFactory(d.node.marketFactory).createMarket(p);
    }
}
