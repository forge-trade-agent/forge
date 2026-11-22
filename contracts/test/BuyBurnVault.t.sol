// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BuyBurnVault} from "../src/BuyBurnVault.sol";
import {MockBurnRoute} from "./mocks/Mocks.sol";

contract BuyBurnVaultTest is BaseTest {
    MockBurnRoute internal route;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public override {
        super.setUp();
        route = new MockBurnRoute(address(vault), seal, 1000e18); // 1 unit in -> 1000 FORGE
        usd.mint(address(vault), 1_000e6);
        vm.deal(address(vault), 10 ether);
    }

    function _activate() internal {
        vm.prank(governor);
        vault.queueRoute(address(route));
        vm.warp(block.timestamp + 2 days);
        vault.activateRoute();
    }

    function test_queueAndActivate_afterDelay() public {
        vm.prank(governor);
        vault.queueRoute(address(route));
        assertEq(vault.pendingRoute(), address(route));
        assertEq(vault.pendingEta(), block.timestamp + 2 days);

        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(abi.encodeWithSelector(BuyBurnVault.TimelockActive.selector, vault.pendingEta()));
        vault.activateRoute();

        vm.warp(block.timestamp + 1);
        vm.prank(makeAddr("anyone"));
        vault.activateRoute();
        assertEq(address(vault.route()), address(route));
    }

    function test_revert_queueByNonGovernor() public {
        vm.prank(keeper);
        vm.expectRevert(BuyBurnVault.NotAuthorized.selector);
        vault.queueRoute(address(route));
    }

    function test_revert_queueRouteForOtherVault() public {
        MockBurnRoute other = new MockBurnRoute(makeAddr("otherVault"), seal, 1e18);
        vm.prank(governor);
        vm.expectRevert(BuyBurnVault.RouteMismatch.selector);
        vault.queueRoute(address(other));
    }

    function test_cancelRoute() public {
        vm.startPrank(governor);
        vault.queueRoute(address(route));
        vault.cancelRoute();
        vm.stopPrank();
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(BuyBurnVault.NoPendingRoute.selector);
        vault.activateRoute();
    }

    function test_revert_burnWithoutRoute() public {
        vm.prank(keeper);
        vm.expectRevert(BuyBurnVault.NoActiveRoute.selector);
        vault.burn(address(usd), 100e6, 1);
    }

    function test_burnStable() public {
        _activate();
        vm.prank(keeper);
        uint256 burned = vault.burn(address(usd), 100e6, 1);
        assertEq(burned, (100e6 * 1000e18) / 1e18);
        assertEq(seal.balanceOf(DEAD), burned);
        assertEq(vault.totalBurned(), burned);
        assertEq(usd.balanceOf(address(vault)), 900e6);
        assertEq(usd.allowance(address(vault), address(route)), 0);
    }

    function test_burnEth() public {
        _activate();
        vm.prank(keeper);
        vault.burn(address(0), 1 ether, 1);
        assertEq(address(vault).balance, 9 ether);
        assertEq(seal.balanceOf(DEAD), 1000e18);
    }

    function test_revert_minOutNotMet() public {
        _activate();
        vm.prank(keeper);
        vm.expectRevert();
        vault.burn(address(usd), 100e6, 100e6 * 1000 + 1);
    }

    function test_revert_lyingRouteCaughtBySecondCheck() public {
        _activate();
        route.setLieFactor(2); // reports 2x what it actually burned
        uint256 real = 100e6 * 1000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BuyBurnVault.InsufficientOutput.selector, real, real + 1));
        vault.burn(address(usd), 100e6, real + 1);
    }

    function test_revert_burnByStranger() public {
        _activate();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(BuyBurnVault.NotAuthorized.selector);
        vault.burn(address(usd), 100e6, 1);
    }

    function test_revert_burnMoreThanBalance() public {
        _activate();
        vm.prank(keeper);
        vm.expectRevert(BuyBurnVault.BadAmount.selector);
        vault.burn(address(usd), 1_000e6 + 1, 1);
    }

    function test_feesFromEscrowLandInVault() public {
        _activate();
        uint256 before = usd.balanceOf(address(vault));
        // settle a deal through the real escrow
        _lock(_terms(1e18, address(usd), 5_000e6));
        vm.prank(seller);
        escrow.deliver(_terms(1e18, address(usd), 5_000e6));
        assertEq(usd.balanceOf(address(vault)) - before, (5_000e6 * 250) / 10_000);
    }
}
