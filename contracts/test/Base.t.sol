// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";
import {BuyBurnVault} from "../src/BuyBurnVault.sol";
import {MockERC20} from "./mocks/Mocks.sol";

abstract contract BaseTest is Test {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    OtcEscrow internal escrow;
    BuyBurnVault internal vault;
    MockERC20 internal usd; // 6 decimals
    MockERC20 internal stock; // 18 decimals, permit-capable
    MockERC20 internal seal; // platform token

    address internal buyer = makeAddr("buyer");
    address internal seller;
    uint256 internal sellerPk;
    address internal payout = makeAddr("payout");
    address internal referrer = makeAddr("referrer");
    address internal relayer = makeAddr("relayer");
    address internal governor = makeAddr("governor");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant MIN_HOLDING = 1_000_000e18;

    function setUp() public virtual {
        (seller, sellerPk) = makeAddrAndKey("seller");
        usd = new MockERC20("USD Global", "USDG", 6);
        stock = new MockERC20("Tesla", "TSLA", 18);
        seal = new MockERC20("Forge", "FORGE", 18);
        vault = new BuyBurnVault(address(seal), governor, keeper);
        escrow = new OtcEscrow(
            address(usd),
            [uint256(10_000e6), uint256(100_000e6)],
            [uint256(4 ether), uint256(40 ether)],
            address(vault),
            address(seal),
            MIN_HOLDING
        );

        usd.mint(buyer, 10_000_000e6);
        vm.deal(buyer, 1_000 ether);
        stock.mint(seller, 1_000_000e18);

        vm.prank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        vm.prank(seller);
        stock.approve(address(escrow), type(uint256).max);
    }

    function _terms(uint256 amount, address payToken, uint256 price) internal view returns (OtcEscrow.Terms memory t) {
        t = OtcEscrow.Terms({
            buyer: buyer,
            seller: seller,
            token: address(stock),
            amount: amount,
            payToken: payToken,
            price: price,
            sellerPayout: payout,
            referrer: address(0),
            relayerFee: 0,
            deadline: uint64(block.timestamp + 1 hours),
            salt: keccak256("salt")
        });
    }

    function _noPermit() internal pure returns (OtcEscrow.PermitData memory p) {}

    function _lock(OtcEscrow.Terms memory t) internal returns (bytes32 id) {
        vm.prank(buyer);
        if (t.payToken == address(0)) id = escrow.depositPayment{value: t.price}(t);
        else id = escrow.depositPayment(t);
    }

    function _signPermit(MockERC20 token, uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (OtcEscrow.PermitData memory p)
    {
        address owner = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, token.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        p = OtcEscrow.PermitData({value: value, deadline: deadline, v: v, r: r, s: s});
    }

    function _signDeliver(uint256 pk, bytes32 dealId, address rel, uint256 authDeadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.deliverDigest(dealId, rel, authDeadline));
        return abi.encodePacked(r, s, v);
    }
}
