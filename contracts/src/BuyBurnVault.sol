// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBurnRoute} from "./interfaces/IBurnRoute.sol";

/// @title BuyBurnVault
/// @notice Receives protocol fees (ETH or stablecoin). The ONLY thing it can do with them is buy
///         the burn token through the active route and send it to 0x…dEaD.
///         - Nobody can withdraw fees. There is no withdraw function.
///         - Route changes wait ROUTE_DELAY (48h) in public before they can be activated.
///         - Min-out is checked by the route AND re-checked here against the dead address balance.
contract BuyBurnVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant ROUTE_DELAY = 2 days;

    IERC20 public immutable BURN_TOKEN;
    /// @notice Can queue or cancel a route, and trigger burns. Cannot move fees anywhere else.
    address public immutable GOVERNOR;
    /// @notice Hot key that triggers burns (e.g. a bot). Cannot change routes.
    address public immutable KEEPER;

    IBurnRoute public route;
    address public pendingRoute;
    uint64 public pendingEta;

    uint256 public totalBurned;
    mapping(address payToken => uint256) public totalSpent;

    event FeeReceived(address indexed payToken, address indexed from, uint256 amount);
    event RouteQueued(address indexed route, uint64 eta);
    event RouteCancelled(address indexed route);
    event RouteActivated(address indexed route);
    event Burned(address indexed payToken, uint256 amountIn, uint256 amountBurned, address indexed route);

    error NotAuthorized();
    error ZeroAddress();
    error NotAContract();
    error NoPendingRoute();
    error TimelockActive(uint64 eta);
    error NoActiveRoute();
    error BadAmount();
    error RouteMismatch();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error OverSpent();

    constructor(address burnToken, address governor, address keeper) {
        if (burnToken == address(0) || governor == address(0) || keeper == address(0)) revert ZeroAddress();
        BURN_TOKEN = IERC20(burnToken);
        GOVERNOR = governor;
        KEEPER = keeper;
    }

    receive() external payable {
        emit FeeReceived(address(0), msg.sender, msg.value);
    }

    // ------------------------------------------------------------------------------------------
    // Route timelock
    // ------------------------------------------------------------------------------------------

    function queueRoute(address newRoute) external {
        if (msg.sender != GOVERNOR) revert NotAuthorized();
        if (newRoute == address(0)) revert ZeroAddress();
        if (newRoute.code.length == 0) revert NotAContract();
        if (IBurnRoute(newRoute).VAULT() != address(this)) revert RouteMismatch();
        pendingRoute = newRoute;
        pendingEta = uint64(block.timestamp + ROUTE_DELAY);
        emit RouteQueued(newRoute, pendingEta);
    }

    function cancelRoute() external {
        if (msg.sender != GOVERNOR) revert NotAuthorized();
        address r = pendingRoute;
        if (r == address(0)) revert NoPendingRoute();
        pendingRoute = address(0);
        pendingEta = 0;
        emit RouteCancelled(r);
    }

    /// @notice Anyone can switch on a queued route once its public delay has elapsed.
    function activateRoute() external {
        address r = pendingRoute;
        if (r == address(0)) revert NoPendingRoute();
        if (block.timestamp < pendingEta) revert TimelockActive(pendingEta);
        route = IBurnRoute(r);
        pendingRoute = address(0);
        pendingEta = 0;
        emit RouteActivated(r);
    }

    // ------------------------------------------------------------------------------------------
    // Burn
    // ------------------------------------------------------------------------------------------

    /// @param payToken address(0) for ETH, otherwise an ERC-20 fee asset held by the vault
    /// @param amountIn amount of fee asset to spend
    /// @param minOut   minimum burn tokens that must reach the dead address (slippage guard)
    function burn(address payToken, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 burned)
    {
        if (msg.sender != KEEPER && msg.sender != GOVERNOR) revert NotAuthorized();
        IBurnRoute r = route;
        if (address(r) == address(0)) revert NoActiveRoute();
        if (amountIn == 0 || minOut == 0) revert BadAmount();

        uint256 deadBefore = BURN_TOKEN.balanceOf(DEAD);
        uint256 vaultBefore = _balance(payToken);
        if (amountIn > vaultBefore) revert BadAmount();

        uint256 reported;
        if (payToken == address(0)) {
            reported = r.buyAndBurn{value: amountIn}(payToken, amountIn, minOut);
        } else {
            IERC20(payToken).forceApprove(address(r), amountIn);
            reported = r.buyAndBurn(payToken, amountIn, minOut);
            IERC20(payToken).forceApprove(address(r), 0);
        }

        // Second, independent check: what actually arrived at the dead address.
        burned = BURN_TOKEN.balanceOf(DEAD) - deadBefore;
        if (burned < minOut || reported < minOut) revert InsufficientOutput(burned, minOut);
        if (vaultBefore - _balance(payToken) > amountIn) revert OverSpent();

        totalBurned += burned;
        totalSpent[payToken] += amountIn;
        emit Burned(payToken, amountIn, burned, address(r));
    }

    function _balance(address payToken) internal view returns (uint256) {
        return payToken == address(0) ? address(this).balance : IERC20(payToken).balanceOf(address(this));
    }
}
