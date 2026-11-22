// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice A route converts a fee asset into the burn token and sends the output to 0x…dEaD.
/// @dev    Only the vault may call it. For ERC-20 input the route pulls `amountIn` from the vault
///         (the vault approves exactly that amount). For native ETH input, `msg.value == amountIn`.
interface IBurnRoute {
    function VAULT() external view returns (address);

    /// @return amountBurned burn-token amount delivered to the dead address (must be >= minOut)
    function buyAndBurn(address payToken, uint256 amountIn, uint256 minOut)
        external
        payable
        returns (uint256 amountBurned);
}
