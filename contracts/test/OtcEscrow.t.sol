// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";
import {MockERC20, FeeOnTransferToken, NoReturnToken, RejectEther, BlocklistToken} from "./mocks/Mocks.sol";

contract OtcEscrowTest is BaseTest {
    // ------------------------------------------------------------------ identity

    function test_dealIdIsHashOfTerms() public view {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        assertEq(escrow.dealIdOf(t), keccak256(abi.encode(t)));
    }

    function test_changingAnyTermChangesDealId() public view {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        bytes32 id = escrow.dealIdOf(t);
        t.price += 1;
        assertTrue(escrow.dealIdOf(t) != id);
    }

    // ------------------------------------------------------------------ happy paths

    function test_settle_stable_tier0() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        bytes32 id = _lock(t);
        assertEq(uint8(escrow.status(id)), uint8(OtcEscrow.Status.PaymentLocked));

        vm.prank(seller);
        escrow.deliver(t);

        uint256 fee = (5_000e6 * 250) / 10_000;
        assertEq(stock.balanceOf(buyer), 100e18);
        assertEq(usd.balanceOf(payout), 5_000e6 - fee);
        assertEq(usd.balanceOf(address(vault)), fee);
        assertEq(usd.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.status(id)), uint8(OtcEscrow.Status.Settled));
    }

    function test_settle_eth() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(0), 1 ether);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);

        uint256 fee = (1 ether * 250) / 10_000;
        assertEq(stock.balanceOf(buyer), 100e18);
        assertEq(payout.balance, 1 ether - fee);
        assertEq(address(vault).balance, fee);
        assertEq(address(escrow).balance, 0);
    }

    function test_feeTiers() public view {
        assertEq(escrow.feeBps(address(usd), 9_999e6, false), 250);
        assertEq(escrow.feeBps(address(usd), 10_000e6, false), 200);
        assertEq(escrow.feeBps(address(usd), 100_000e6, false), 150);
        assertEq(escrow.feeBps(address(0), 3.99 ether, false), 250);
        assertEq(escrow.feeBps(address(0), 4 ether, false), 200);
        assertEq(escrow.feeBps(address(0), 40 ether, false), 150);
        assertEq(escrow.feeBps(address(usd), 1e6, true), 200);
        assertEq(escrow.feeBps(address(usd), 100_000e6, true), 100);
    }

    function test_holderDiscount_buyerHolds() public {
        seal.mint(buyer, MIN_HOLDING);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 50_000e6);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        assertEq(usd.balanceOf(address(vault)), (50_000e6 * 150) / 10_000);
    }

    function test_holderDiscount_sellerHolds() public {
        seal.mint(seller, MIN_HOLDING);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        assertEq(usd.balanceOf(address(vault)), (5_000e6 * 200) / 10_000);
    }

    function test_holderDiscount_belowMinimum() public {
        seal.mint(buyer, MIN_HOLDING - 1);
        assertFalse(escrow.isHolder(buyer));
    }

    function test_referrerGetsHalfTheFee() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 20_000e6);
        t.referrer = referrer;
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        uint256 fee = (20_000e6 * 200) / 10_000;
        assertEq(usd.balanceOf(referrer), fee / 2);
        assertEq(usd.balanceOf(address(vault)), fee - fee / 2);
        assertEq(usd.balanceOf(payout), 20_000e6 - fee);
    }

    function test_partialFills_independentDeals() public {
        OtcEscrow.Terms memory a = _terms(40e18, address(usd), 2_000e6);
        OtcEscrow.Terms memory b = _terms(60e18, address(usd), 3_000e6);
        b.salt = keccak256("part-2");
        _lock(a);
        _lock(b);
        vm.startPrank(seller);
        escrow.deliver(a);
        escrow.deliver(b);
        vm.stopPrank();
        assertEq(stock.balanceOf(buyer), 100e18);
    }

    // ------------------------------------------------------------------ ordering & lifecycle

    function test_revert_deliverBeforePayment() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(OtcEscrow.BadStatus.selector, OtcEscrow.Status.None));
        escrow.deliver(t);
    }

    function test_revert_doubleDeposit() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OtcEscrow.BadStatus.selector, OtcEscrow.Status.PaymentLocked));
        escrow.depositPayment(t);
    }

    function test_revert_doubleDeliver() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.startPrank(seller);
        escrow.deliver(t);
        vm.expectRevert(abi.encodeWithSelector(OtcEscrow.BadStatus.selector, OtcEscrow.Status.Settled));
        escrow.deliver(t);
        vm.stopPrank();
    }

    function test_revert_wrongDeliverer() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.NotSeller.selector);
        escrow.deliver(t);
    }

    function test_refundAfterDeadline() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        uint256 before = usd.balanceOf(buyer);
        _lock(t);
        vm.warp(t.deadline + 1);
        vm.prank(makeAddr("anyone"));
        escrow.refund(t);
        assertEq(usd.balanceOf(buyer), before);
        assertEq(uint8(escrow.status(escrow.dealIdOf(t))), uint8(OtcEscrow.Status.Refunded));
    }

    function test_revert_refundBeforeDeadline() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.warp(t.deadline);
        vm.expectRevert(OtcEscrow.DeadlineNotPassed.selector);
        escrow.refund(t);
    }

    function test_revert_deliverAfterDeadline() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.warp(t.deadline + 1);
        vm.prank(seller);
        vm.expectRevert(OtcEscrow.DeadlinePassed.selector);
        escrow.deliver(t);
    }

    function test_revert_refundAfterSettle() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        vm.warp(t.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(OtcEscrow.BadStatus.selector, OtcEscrow.Status.Settled));
        escrow.refund(t);
    }

    function test_revert_cannotRelockAfterRefund() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        _lock(t);
        vm.warp(t.deadline + 1);
        escrow.refund(t);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.DeadlinePassed.selector);
        escrow.depositPayment(t);
    }

    // ------------------------------------------------------------------ paying in the platform token

    function _fundSealBuyer(uint256 amount) internal {
        seal.mint(buyer, amount);
        vm.prank(buyer);
        seal.approve(address(escrow), type(uint256).max);
    }

    function test_tokenPay_flatFeeBurnedAtSettlement() public {
        uint256 price = 2_000_000e18; // any size: always a flat 1.5%
        _fundSealBuyer(price);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), price);
        bytes32 id = _lock(t);
        uint256 fee = (price * 150) / 10_000;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit OtcEscrow.FeeBurned(id, address(seal), fee);
        vm.prank(seller);
        escrow.deliver(t);
        assertEq(stock.balanceOf(buyer), 100e18);
        assertEq(seal.balanceOf(payout), price - fee);
        assertEq(seal.balanceOf(escrow.DEAD()), fee, "protocol share burned");
        assertEq(seal.balanceOf(address(vault)), 0, "nothing goes to the vault");
        assertEq(seal.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLocked(address(seal)), 0);
    }

    function test_tokenPay_referrerStillGetsHalf() public {
        uint256 price = 10_000e18;
        _fundSealBuyer(price);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), price);
        t.referrer = referrer;
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        uint256 fee = (price * 150) / 10_000;
        assertEq(seal.balanceOf(referrer), fee / 2);
        assertEq(seal.balanceOf(escrow.DEAD()), fee - fee / 2);
        assertEq(seal.balanceOf(payout), price - fee);
    }

    function test_tokenPay_holderDiscountDoesNotStack() public view {
        assertEq(escrow.feeBps(address(seal), 1, false), 150);
        assertEq(escrow.feeBps(address(seal), 1, true), 150);
        assertEq(escrow.feeBps(address(seal), type(uint128).max, true), 150);
    }

    function test_tokenPay_refundReturnsTokens() public {
        uint256 price = 5_000e18;
        _fundSealBuyer(price);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), price);
        _lock(t);
        assertEq(seal.balanceOf(buyer), 0);
        vm.warp(t.deadline + 1);
        escrow.refund(t);
        assertEq(seal.balanceOf(buyer), price);
        assertEq(seal.balanceOf(escrow.DEAD()), 0, "nothing burned on a refund");
    }

    function test_revert_tokenPay_cannotTradeTheTokenForItself() public {
        _fundSealBuyer(1_000e18);
        seal.mint(seller, 1_000e18);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), 1_000e18);
        t.token = address(seal);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.InvalidToken.selector);
        escrow.depositPayment(t);
    }

    function test_revert_tokenPay_disabledWithoutPlatformToken() public {
        OtcEscrow plain = new OtcEscrow(
            address(usd), [uint256(10_000e6), uint256(100_000e6)], [uint256(4 ether), uint256(40 ether)], address(vault), address(0), 0
        );
        _fundSealBuyer(1_000e18);
        vm.prank(buyer);
        seal.approve(address(plain), type(uint256).max);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), 1_000e18);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.UnsupportedPayToken.selector);
        plain.depositPayment(t);
    }

    function testFuzz_tokenPay_splitConservesPrice(uint256 price, bool withRef) public {
        price = bound(price, 1e6, 1e30);
        _fundSealBuyer(price);
        OtcEscrow.Terms memory t = _terms(100e18, address(seal), price);
        if (withRef) t.referrer = referrer;
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        uint256 out = seal.balanceOf(payout) + seal.balanceOf(escrow.DEAD()) + seal.balanceOf(referrer);
        assertEq(out, price, "every unit of the price is accounted for");
        assertEq(seal.balanceOf(payout), price - (price * 150) / 10_000);
    }

    // ------------------------------------------------------------------ validation

    function test_revert_unsupportedPayToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        OtcEscrow.Terms memory t = _terms(100e18, address(other), 5_000e6);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.UnsupportedPayToken.selector);
        escrow.depositPayment(t);
    }

    function test_revert_wrongMsgValue() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(0), 1 ether);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.WrongMsgValue.selector);
        escrow.depositPayment{value: 0.5 ether}(t);

        OtcEscrow.Terms memory s = _terms(100e18, address(usd), 5_000e6);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.WrongMsgValue.selector);
        escrow.depositPayment{value: 1}(s);
    }

    function test_revert_referrerIsParty() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.referrer = payout;
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.InvalidReferrer.selector);
        escrow.depositPayment(t);
    }

    function test_revert_sameParty() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.seller = buyer;
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.SameParty.selector);
        escrow.depositPayment(t);
    }

    function test_revert_feesExceedPrice() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.relayerFee = 4_900e6;
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.FeesExceedPrice.selector);
        escrow.depositPayment(t);
    }

    function test_revert_deadlineTooFar() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.deadline = uint64(block.timestamp + 31 days);
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.DeadlineTooFar.selector);
        escrow.depositPayment(t);
    }

    function test_revert_tokenNotContract() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.token = makeAddr("eoa");
        vm.prank(buyer);
        vm.expectRevert(OtcEscrow.InvalidToken.selector);
        escrow.depositPayment(t);
    }

    // ------------------------------------------------------------------ hostile tokens

    function test_revert_feeOnTransferToken() public {
        FeeOnTransferToken tax = new FeeOnTransferToken();
        tax.mint(seller, 1_000e18);
        vm.prank(seller);
        tax.approve(address(escrow), type(uint256).max);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.token = address(tax);
        _lock(t);
        vm.prank(seller);
        vm.expectRevert(OtcEscrow.TransferAmountMismatch.selector);
        escrow.deliver(t);
    }

    function test_noReturnToken_settles() public {
        NoReturnToken nrt = new NoReturnToken();
        nrt.mint(seller, 1_000e6);
        vm.prank(seller);
        nrt.approve(address(escrow), type(uint256).max);
        OtcEscrow.Terms memory t = _terms(500e6, address(usd), 5_000e6);
        t.token = address(nrt);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        assertEq(nrt.balanceOf(buyer), 500e6);
    }

    // ------------------------------------------------------------------ permits & Ghost mode

    function test_deliverWithPermit() public {
        (address ghost, uint256 ghostPk) = makeAddrAndKey("ghost");
        stock.mint(ghost, 100e18);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.seller = ghost;
        _lock(t);
        OtcEscrow.PermitData memory p = _signPermit(stock, ghostPk, address(escrow), 100e18, block.timestamp + 1 hours);
        vm.deal(ghost, 1 ether);
        vm.prank(ghost);
        escrow.deliverWithPermit(t, p);
        assertEq(stock.balanceOf(buyer), 100e18);
    }

    function test_permitFrontRun_doesNotBlock() public {
        (address ghost, uint256 ghostPk) = makeAddrAndKey("ghost");
        stock.mint(ghost, 100e18);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.seller = ghost;
        _lock(t);
        OtcEscrow.PermitData memory p = _signPermit(stock, ghostPk, address(escrow), 100e18, block.timestamp + 1 hours);
        // attacker submits the permit first
        stock.permit(ghost, address(escrow), p.value, p.deadline, p.v, p.r, p.s);
        vm.prank(ghost);
        escrow.deliverWithPermit(t, p);
        assertEq(stock.balanceOf(buyer), 100e18);
    }

    function test_ghostMode_relayedDelivery() public {
        (address ghost, uint256 ghostPk) = makeAddrAndKey("ghost");
        stock.mint(ghost, 100e18);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.seller = ghost;
        t.relayerFee = 3e6;
        bytes32 id = _lock(t);

        OtcEscrow.PermitData memory p = _signPermit(stock, ghostPk, address(escrow), 100e18, block.timestamp + 1 hours);
        uint256 authDeadline = block.timestamp + 10 minutes;
        bytes memory sig = _signDeliver(ghostPk, id, relayer, authDeadline);

        vm.prank(relayer);
        escrow.deliverFor(t, p, authDeadline, sig);

        uint256 fee = (5_000e6 * 250) / 10_000;
        assertEq(ghost.balance, 0, "ghost never needed gas");
        assertEq(stock.balanceOf(buyer), 100e18);
        assertEq(usd.balanceOf(relayer), 3e6);
        assertEq(usd.balanceOf(payout), 5_000e6 - fee - 3e6);
    }

    function test_revert_ghostMode_otherRelayer() public {
        (address ghost, uint256 ghostPk) = makeAddrAndKey("ghost");
        stock.mint(ghost, 100e18);
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.seller = ghost;
        bytes32 id = _lock(t);
        OtcEscrow.PermitData memory p = _signPermit(stock, ghostPk, address(escrow), 100e18, block.timestamp + 1 hours);
        uint256 authDeadline = block.timestamp + 10 minutes;
        bytes memory sig = _signDeliver(ghostPk, id, relayer, authDeadline);

        vm.prank(makeAddr("thief"));
        vm.expectRevert(OtcEscrow.InvalidSignature.selector);
        escrow.deliverFor(t, p, authDeadline, sig);
    }

    function test_revert_ghostMode_expiredAuth() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        bytes32 id = _lock(t);
        uint256 authDeadline = block.timestamp + 1;
        bytes memory sig = _signDeliver(sellerPk, id, relayer, authDeadline);
        vm.warp(authDeadline + 1);
        vm.prank(relayer);
        vm.expectRevert(OtcEscrow.AuthorizationExpired.selector);
        escrow.deliverFor(t, _noPermit(), authDeadline, sig);
    }

    function test_directDelivery_relayerFeeStaysWithSeller() public {
        OtcEscrow.Terms memory t = _terms(100e18, address(usd), 5_000e6);
        t.relayerFee = 3e6;
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        uint256 fee = (5_000e6 * 250) / 10_000;
        assertEq(usd.balanceOf(payout), 5_000e6 - fee);
    }

    // ------------------------------------------------------------------ hostile receivers

    function test_rejectingEthPayout_isDeferredAndClaimable() public {
        RejectEther rej = new RejectEther();
        OtcEscrow.Terms memory t = _terms(100e18, address(0), 1 ether);
        t.sellerPayout = address(rej);
        _lock(t);
        vm.prank(seller);
        escrow.deliver(t); // must not revert
        uint256 net = 1 ether - (1 ether * 250) / 10_000;
        assertEq(escrow.owed(address(0), address(rej)), net);

        address to = makeAddr("claimTo");
        vm.prank(address(rej));
        escrow.claim(address(0), to);
        assertEq(to.balance, net);
        assertEq(escrow.totalOwed(address(0)), 0);
    }

    function test_blockedReferrer_doesNotBlockSettlement() public {
        BlocklistToken busd = new BlocklistToken();
        OtcEscrow e = new OtcEscrow(
            address(busd), [uint256(10_000e6), uint256(100_000e6)], [uint256(4 ether), uint256(40 ether)],
            address(vault), address(seal), MIN_HOLDING
        );
        busd.mint(buyer, 10_000e6);
        busd.setBlocked(referrer, true);
        vm.prank(buyer);
        busd.approve(address(e), type(uint256).max);
        vm.prank(seller);
        stock.approve(address(e), type(uint256).max);

        OtcEscrow.Terms memory t = _terms(100e18, address(busd), 5_000e6);
        t.referrer = referrer;
        vm.prank(buyer);
        e.depositPayment(t);
        vm.prank(seller);
        e.deliver(t);
        assertEq(stock.balanceOf(buyer), 100e18);
        assertEq(e.owed(address(busd), referrer), ((5_000e6 * 250) / 10_000) / 2);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_splitConservesPrice(uint256 price, uint256 relayerFee, bool holder, bool withRef) public {
        price = bound(price, 1e6, 5_000_000e6);
        relayerFee = bound(relayerFee, 0, price / 2);
        if (holder) seal.mint(buyer, MIN_HOLDING);

        OtcEscrow.Terms memory t = _terms(1e18, address(usd), price);
        t.relayerFee = relayerFee;
        if (withRef) t.referrer = referrer;

        (uint256 fee, uint256 refFee, uint256 vaultFee, uint256 net) = escrow.quote(t);
        assertEq(fee, refFee + vaultFee);
        assertEq(net + fee + relayerFee, price);
        assertLe(fee * 10_000, price * escrow.MAX_FEE_BPS());

        _lock(t);
        vm.prank(seller);
        escrow.deliver(t);
        assertEq(usd.balanceOf(address(escrow)), 0);
        assertEq(usd.balanceOf(payout) + usd.balanceOf(address(vault)) + usd.balanceOf(referrer), price);
    }

    function testFuzz_feeBpsNeverAboveCap(uint256 price, bool eth, bool discounted) public view {
        uint256 bps = escrow.feeBps(eth ? address(0) : address(usd), price, discounted);
        assertLe(bps, escrow.MAX_FEE_BPS());
        assertGe(bps, 100);
    }
}
