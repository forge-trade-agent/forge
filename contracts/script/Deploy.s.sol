// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";
import {BuyBurnVault} from "../src/BuyBurnVault.sol";

/// @notice Deterministic (CREATE2) deployment of the vault and the escrow.
/// Env: STABLE, BURN_TOKEN, GOVERNOR, KEEPER, MIN_HOLDING,
///      STABLE_TIER1, STABLE_TIER2, ETH_TIER1, ETH_TIER2, DEPLOY_SALT
/// Run: forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
contract Deploy is Script {
    function run() external returns (BuyBurnVault vault, OtcEscrow escrow) {
        address stable = vm.envAddress("STABLE");
        address burnToken = vm.envAddress("BURN_TOKEN");
        address governor = vm.envAddress("GOVERNOR");
        address keeper = vm.envAddress("KEEPER");
        uint256 minHolding = vm.envUint("MIN_HOLDING");
        uint256[2] memory stableTiers = [vm.envUint("STABLE_TIER1"), vm.envUint("STABLE_TIER2")];
        uint256[2] memory ethTiers = [vm.envUint("ETH_TIER1"), vm.envUint("ETH_TIER2")];
        bytes32 salt = vm.envBytes32("DEPLOY_SALT");

        vm.startBroadcast();
        vault = new BuyBurnVault{salt: salt}(burnToken, governor, keeper);
        escrow = new OtcEscrow{salt: salt}(stable, stableTiers, ethTiers, address(vault), burnToken, minHolding);
        vm.stopBroadcast();

        console2.log("BuyBurnVault", address(vault));
        console2.log("OtcEscrow   ", address(escrow));

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "BuyBurnVault", address(vault));
        string memory out = vm.serializeAddress(json, "OtcEscrow", address(escrow));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
