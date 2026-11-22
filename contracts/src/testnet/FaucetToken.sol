// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FaucetToken
/// @notice TESTNET ONLY. A token with no value that anyone can claim from, so people can try the
/// desk on Robinhood Chain testnet: the test $FORGE (until the real one launches) and a test dollar
/// for paying. Never deploy this on mainnet.
contract FaucetToken is ERC20 {
    uint8 private immutable _decimals;
    /// @notice Amount handed out per claim, in base units.
    uint256 public immutable drip;
    uint256 public constant COOLDOWN = 1 days;
    mapping(address => uint256) public lastClaim;

    error TooSoon(uint256 nextClaimAt);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 drip_) ERC20(name_, symbol_) {
        require(block.chainid != 4663, "testnet only");
        _decimals = decimals_;
        drip = drip_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Claim `drip` tokens, once a day per address.
    function claim() external {
        uint256 next = lastClaim[msg.sender] + COOLDOWN;
        if (lastClaim[msg.sender] != 0 && block.timestamp < next) revert TooSoon(next);
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, drip);
    }
}
