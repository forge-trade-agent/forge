// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBurnRoute} from "../../src/interfaces/IBurnRoute.sol";

contract MockERC20 is ERC20Permit {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) ERC20Permit(n) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Takes a 1% tax on every transfer.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Tax", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0xBEEF), tax);
            super._update(from, to, value - tax);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev USDT-style token: transfer/transferFrom/approve return nothing.
contract NoReturnToken {
    string public constant name = "NoReturn";
    string public constant symbol = "NRT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Rejects ETH and can be configured to reject ERC-20 receipt via a blocklist token.
contract RejectEther {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev Stablecoin with a blocklist (USDC-style), used to test deferred payouts.
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocklist USD", "BUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "blocked");
        super._update(from, to, value);
    }
}

/// @dev Route that "buys" at a fixed rate by minting the burn token to the dead address.
contract MockBurnRoute is IBurnRoute {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable override VAULT;
    MockERC20 public immutable BURN;
    uint256 public rate; // burn tokens per 1 unit of input (scaled 1e18)
    uint256 public lieFactor = 1; // >1 makes the route over-report output

    constructor(address vault, MockERC20 burnToken, uint256 rate_) {
        VAULT = vault;
        BURN = burnToken;
        rate = rate_;
    }

    function setLieFactor(uint256 f) external {
        lieFactor = f;
    }

    function buyAndBurn(address payToken, uint256 amountIn, uint256) external payable override returns (uint256) {
        require(msg.sender == VAULT, "vault");
        if (payToken == address(0)) require(msg.value == amountIn, "value");
        else IERC20(payToken).transferFrom(VAULT, address(this), amountIn);
        uint256 out = (amountIn * rate) / 1e18;
        BURN.mint(DEAD, out);
        return out * lieFactor;
    }
}
