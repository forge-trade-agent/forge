// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Minimal, ABI-compatible subset of Uniswap v4-core's IPoolManager.
/// @dev `Currency` is a user-defined `address` type in v4-core and `BalanceDelta` a packed
///      `int256` (amount0 in the upper 128 bits, amount1 in the lower 128 bits). Both encode
///      identically to the plain types used here.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerMinimal {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
