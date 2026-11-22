// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OtcEscrow} from "../src/OtcEscrow.sol";

/// @notice Pins the values computed by packages/crypto (viem) so the TS and Solidity
///         implementations of the deal id and the Deliver digest can never drift apart.
///         The same constants are asserted in packages/crypto/test/crypto.test.ts.
contract CrossLanguageTest is Test {
    address constant ESCROW_AT = 0x00000000000000000000000000000000000E5C0e;
    bytes32 constant DEAL_ID = 0xc0adde520df2bb94353dc453df96e31349b928bd5b33388ab92686a93621a113;
    bytes32 constant DELIVER_DIGEST = 0x77790f54f63344fe40dedb716f58c8a6f38f7270a40b188079db33d74cf7b1f4;

    function test_dealIdAndDeliverDigestMatchTypeScript() public {
        vm.chainId(4663);
        deployCodeTo(
            "OtcEscrow.sol:OtcEscrow",
            abi.encode(
                address(0x5),
                [uint256(10_000e6), uint256(100_000e6)],
                [uint256(4 ether), uint256(40 ether)],
                address(0xFEE),
                address(0),
                uint256(0)
            ),
            ESCROW_AT
        );
        OtcEscrow escrow = OtcEscrow(ESCROW_AT);

        OtcEscrow.Terms memory t = OtcEscrow.Terms({
            buyer: address(0xb0b),
            seller: address(0x5e11),
            token: address(0x7e51a),
            amount: 2500e18,
            payToken: address(0x5),
            price: 950_275_000_000,
            sellerPayout: address(0x5e12),
            referrer: address(0),
            relayerFee: 3_000_000,
            deadline: 1_800_000_000,
            salt: 0xabababababababababababababababababababababababababababababababab
        });
        assertEq(escrow.dealIdOf(t), DEAL_ID, "deal id");
        assertEq(escrow.deliverDigest(DEAL_ID, address(0xe1a), 1_800_000_600), DELIVER_DIGEST, "deliver digest");
    }
}
