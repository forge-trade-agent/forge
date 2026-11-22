// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";
import {BuyBurnVault} from "../src/BuyBurnVault.sol";
import {FaucetToken} from "../src/testnet/FaucetToken.sol";

/// @notice Robinhood Chain TESTNET (46630) deployment of Forge: a test $FORGE and a test dollar
/// (both claimable from a faucet, no value), then the vault and the escrow exactly as on mainnet.
/// Env: GOVERNOR, KEEPER (use a Safe), optional MIN_HOLDING (default 1,000,000 FORGE).
/// Dry run:  forge script script/DeployTestnet.s.sol --rpc-url robinhood_testnet --sender <your address>
/// Deploy:   forge script script/DeployTestnet.s.sol --rpc-url robinhood_testnet --broadcast --interactives 1
contract DeployTestnet is Script {
    function run() external returns (FaucetToken forge, FaucetToken usd, BuyBurnVault vault, OtcEscrow escrow) {
        require(block.chainid == 46630, "Robinhood Chain testnet only (46630)");
        address governor = vm.envAddress("GOVERNOR");
        address keeper = vm.envAddress("KEEPER");
        require(governor != address(0) && keeper != address(0), "GOVERNOR and KEEPER are required");
        uint256 minHolding = vm.envOr("MIN_HOLDING", uint256(1_000_000e18));

        vm.startBroadcast();
        forge = new FaucetToken("Forge (testnet)", "FORGE", 18, 2_000_000e18);
        usd = new FaucetToken("Test Dollar (testnet)", "tUSD", 6, 1_000_000e6);
        vault = new BuyBurnVault(address(forge), governor, keeper);
        escrow = new OtcEscrow(
            address(usd),
            [uint256(10_000e6), uint256(100_000e6)], // stable fee tiers: 10k / 100k
            [uint256(4e18), uint256(40e18)], // ETH fee tiers: 4 / 40 ETH
            address(vault),
            address(forge),
            minHolding
        );
        vm.stopBroadcast();

        console2.log("FORGE (test)", address(forge));
        console2.log("tUSD        ", address(usd));
        console2.log("BuyBurnVault", address(vault));
        console2.log("OtcEscrow   ", address(escrow));
        console2.log("deploy block", block.number);

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "deployBlock", block.number);
        vm.serializeAddress(j, "PlatformToken", address(forge));
        vm.serializeAddress(j, "Stable", address(usd));
        vm.serializeAddress(j, "BuyBurnVault", address(vault));
        string memory out = vm.serializeAddress(j, "OtcEscrow", address(escrow));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
