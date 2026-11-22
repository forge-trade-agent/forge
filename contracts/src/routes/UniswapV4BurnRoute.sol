// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBurnRoute} from "../interfaces/IBurnRoute.sol";
import {IPoolManagerMinimal, IUnlockCallback, PoolKey, SwapParams} from "../interfaces/IPoolManagerMinimal.sol";

/// @title UniswapV4BurnRoute
/// @notice Buys the burn token through fixed Uniswap v4 paths and delivers it to 0x…dEaD.
///         No owner, no settings: paths are fixed in the constructor. Only the vault can call it,
///         and it holds nothing between burns.
contract UniswapV4BurnRoute is IBurnRoute, IUnlockCallback {
    using SafeERC20 for IERC20;

    struct Hop {
        PoolKey key;
        bool zeroForOne;
    }

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint256 public constant MAX_HOPS = 3;

    IPoolManagerMinimal public immutable POOL_MANAGER;
    address public immutable override VAULT;
    address public immutable BURN_TOKEN;

    mapping(address payToken => Hop[]) internal _paths;

    error NotVault();
    error NotPoolManager();
    error UnsupportedPayToken();
    error BadPath();
    error HooksNotAllowed();
    error PartialFill();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error WrongMsgValue();

    /// @param payTokens one entry per supported fee asset (address(0) = ETH)
    /// @param paths     paths[i] is the hop list from payTokens[i] to the burn token
    constructor(
        address poolManager,
        address vault,
        address burnToken,
        address[] memory payTokens,
        Hop[][] memory paths
    ) {
        if (payTokens.length != paths.length || payTokens.length == 0) revert BadPath();
        POOL_MANAGER = IPoolManagerMinimal(poolManager);
        VAULT = vault;
        BURN_TOKEN = burnToken;
        for (uint256 i; i < payTokens.length; ++i) {
            Hop[] memory p = paths[i];
            if (p.length == 0 || p.length > MAX_HOPS) revert BadPath();
            address cur = payTokens[i];
            for (uint256 j; j < p.length; ++j) {
                PoolKey memory k = p[j].key;
                if (k.hooks != address(0)) revert HooksNotAllowed();
                (address inC, address outC) = p[j].zeroForOne ? (k.currency0, k.currency1) : (k.currency1, k.currency0);
                if (inC != cur) revert BadPath();
                cur = outC;
                _paths[payTokens[i]].push(p[j]);
            }
            if (cur != burnToken) revert BadPath();
        }
    }

    function pathOf(address payToken) external view returns (Hop[] memory) {
        return _paths[payToken];
    }

    function buyAndBurn(address payToken, uint256 amountIn, uint256 minOut)
        external
        payable
        override
        returns (uint256 amountBurned)
    {
        if (msg.sender != VAULT) revert NotVault();
        if (_paths[payToken].length == 0) revert UnsupportedPayToken();
        if (payToken == address(0)) {
            if (msg.value != amountIn) revert WrongMsgValue();
        } else {
            if (msg.value != 0) revert WrongMsgValue();
            IERC20(payToken).safeTransferFrom(VAULT, address(this), amountIn);
        }

        bytes memory result = POOL_MANAGER.unlock(abi.encode(payToken, amountIn));
        amountBurned = abi.decode(result, (uint256));
        if (amountBurned < minOut) revert InsufficientOutput(amountBurned, minOut);
    }

    /// @dev Flash accounting: intermediate deltas of a multi-hop path cancel inside one unlock.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (address payToken, uint256 amountIn) = abi.decode(data, (address, uint256));
        Hop[] storage path = _paths[payToken];

        uint256 next = amountIn;
        for (uint256 i; i < path.length; ++i) {
            Hop memory h = path[i];
            int256 delta = POOL_MANAGER.swap(
                h.key,
                SwapParams({
                    zeroForOne: h.zeroForOne,
                    amountSpecified: -int256(next),
                    sqrtPriceLimitX96: h.zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
                }),
                ""
            );
            int128 amount0 = int128(delta >> 128);
            int128 amount1 = int128(delta);
            (int128 inD, int128 outD) = h.zeroForOne ? (amount0, amount1) : (amount1, amount0);
            if (inD >= 0 || uint256(uint128(-inD)) != next || outD <= 0) revert PartialFill();
            next = uint256(uint128(outD));
        }

        // Pay the input leg.
        if (payToken == address(0)) {
            POOL_MANAGER.settle{value: amountIn}();
        } else {
            POOL_MANAGER.sync(payToken);
            IERC20(payToken).safeTransfer(address(POOL_MANAGER), amountIn);
            POOL_MANAGER.settle();
        }
        // Deliver the output straight to the dead address.
        POOL_MANAGER.take(BURN_TOKEN, DEAD, next);
        return abi.encode(next);
    }
}
