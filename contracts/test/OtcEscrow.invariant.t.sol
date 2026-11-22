// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";
import {MockERC20, RejectEther} from "./mocks/Mocks.sol";

/// @dev Drives random sequences of deposit / deliver / refund / warp / claim.
contract EscrowHandler is Test {
    OtcEscrow public escrow;
    MockERC20 public usd;
    MockERC20 public stock;
    MockERC20 public seal;
    address public vault;
    RejectEther public rej;

    OtcEscrow.Terms[] internal deals;
    mapping(bytes32 => bool) public everSettled;
    uint256 public ghostFeeViolations;
    uint256 public ghostSettledThenRefunded;
    /// Sum of the protocol fee shares that must have been burned (platform-token deals).
    uint256 public ghostExpectedBurn;

    address internal buyer = address(0xB0B);
    address internal seller = address(0x5E11);

    constructor(OtcEscrow e, MockERC20 u, MockERC20 s, MockERC20 p, address v) {
        escrow = e;
        usd = u;
        stock = s;
        seal = p;
        vault = v;
        rej = new RejectEther();
        stock.mint(seller, type(uint128).max);
        vm.prank(seller);
        stock.approve(address(escrow), type(uint256).max);
        vm.startPrank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        seal.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function dealCount() external view returns (uint256) {
        return deals.length;
    }

    /// kind: 0 = ETH, 1 = USD, 2 = platform token.
    function deposit(uint256 price, uint256 amount, uint8 kind, bool hostilePayout, uint256 duration) external {
        kind = kind % 3;
        price = kind == 2 ? bound(price, 1e18, 1e30) : bound(price, 1e6, 1_000_000e6);
        amount = bound(amount, 1, 1e24);
        duration = bound(duration, 1, 7 days);
        address payToken = kind == 0 ? address(0) : kind == 1 ? address(usd) : address(seal);
        OtcEscrow.Terms memory t = OtcEscrow.Terms({
            buyer: buyer,
            seller: seller,
            token: address(stock),
            amount: amount,
            payToken: payToken,
            price: price,
            sellerPayout: hostilePayout ? address(rej) : address(0xFEE1),
            referrer: address(0),
            relayerFee: 0,
            deadline: uint64(block.timestamp + duration),
            salt: bytes32(deals.length)
        });
        if (kind == 0) {
            vm.deal(buyer, price);
            vm.prank(buyer);
            escrow.depositPayment{value: price}(t);
        } else {
            MockERC20(payToken).mint(buyer, price);
            vm.prank(buyer);
            escrow.depositPayment(t);
        }
        deals.push(t);
    }

    function deliver(uint256 idx) external {
        if (deals.length == 0) return;
        OtcEscrow.Terms memory t = deals[idx % deals.length];
        bytes32 id = escrow.dealIdOf(t);
        if (escrow.status(id) != OtcEscrow.Status.PaymentLocked || block.timestamp > t.deadline) return;
        (uint256 fee,, uint256 vaultFee,) = escrow.quote(t);
        if (fee * 10_000 > t.price * 250) ghostFeeViolations++;
        if (t.payToken == address(seal)) {
            if (fee * 10_000 != t.price * 150 - (t.price * 150) % 10_000) ghostFeeViolations++; // flat 1.5%
            ghostExpectedBurn += vaultFee;
        }
        vm.prank(seller);
        escrow.deliver(t);
        everSettled[id] = true;
    }

    function refund(uint256 idx) external {
        if (deals.length == 0) return;
        OtcEscrow.Terms memory t = deals[idx % deals.length];
        bytes32 id = escrow.dealIdOf(t);
        if (escrow.status(id) != OtcEscrow.Status.PaymentLocked || block.timestamp <= t.deadline) return;
        escrow.refund(t);
        if (everSettled[id]) ghostSettledThenRefunded++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function claimHostile() external {
        if (escrow.owed(address(0), address(rej)) == 0) return;
        vm.prank(address(rej));
        escrow.claim(address(0), address(0xC1A1));
    }
}

contract OtcEscrowInvariantTest is Test {
    OtcEscrow internal escrow;
    MockERC20 internal usd;
    MockERC20 internal stock;
    MockERC20 internal seal;
    EscrowHandler internal handler;

    function setUp() public {
        usd = new MockERC20("USD", "USDG", 6);
        stock = new MockERC20("Stock", "STK", 18);
        seal = new MockERC20("Forge", "FORGE", 18);
        address vault = address(0x7A017);
        escrow = new OtcEscrow(
            address(usd), [uint256(10_000e6), uint256(100_000e6)], [uint256(4 ether), uint256(40 ether)], vault, address(seal), 1_000_000e18
        );
        handler = new EscrowHandler(escrow, usd, stock, seal, vault);
        targetContract(address(handler));
    }

    /// Escrow holds exactly what is locked plus what is owed — never more, never less.
    function invariant_balancesMatchAccounting() public view {
        assertEq(usd.balanceOf(address(escrow)), escrow.totalLocked(address(usd)) + escrow.totalOwed(address(usd)));
        assertEq(address(escrow).balance, escrow.totalLocked(address(0)) + escrow.totalOwed(address(0)));
        assertEq(seal.balanceOf(address(escrow)), escrow.totalLocked(address(seal)) + escrow.totalOwed(address(seal)));
    }

    /// Platform-token fees: exactly the protocol share reaches the burn address, and the vault
    /// never receives platform tokens from the escrow.
    function invariant_tokenFeesBurned() public view {
        assertEq(seal.balanceOf(escrow.DEAD()), handler.ghostExpectedBurn());
        assertEq(seal.balanceOf(address(0x7A017)), 0);
    }

    /// The escrow never keeps the asset being traded.
    function invariant_noTokenLeftInEscrow() public view {
        assertEq(stock.balanceOf(address(escrow)), 0);
    }

    function invariant_feeNeverAboveCap() public view {
        assertEq(handler.ghostFeeViolations(), 0);
    }

    function invariant_settledNeverRefunded() public view {
        assertEq(handler.ghostSettledThenRefunded(), 0);
    }
}
