# Contracts — self-review notes (Phase 2)

Status: **internal review only. Not audited by a third party. Do not deploy with real funds yet.**

## Scope
`contracts/src/OtcEscrow.sol`, `BuyBurnVault.sol`, `routes/UniswapV4BurnRoute.sol`, interfaces.

## Properties and where they are enforced / tested

| Property | Enforcement | Tests |
|---|---|---|
| No admin over escrowed funds | No owner/pause/upgrade in `OtcEscrow` | by construction |
| Terms immutable | `dealId = keccak256(abi.encode(terms))`, recomputed on every call | `test_dealIdIsHashOfTerms`, `test_changingAnyTermChangesDealId` |
| Payment locks first | `_settle` requires `PaymentLocked` | `test_revert_deliverBeforePayment` |
| Settle xor refund | status machine + deadline split (`<= deadline` settle, `> deadline` refund) | `test_revert_refundAfterSettle`, `test_revert_deliverAfterDeadline`, invariant `settledNeverRefunded` |
| Fee ≤ 2.5 % | constants + `MAX_FEE_BPS` clamp | `testFuzz_feeBpsNeverAboveCap`, invariant `feeNeverAboveCap` |
| Value conservation | `net + fee + relayerFee == price` | `testFuzz_splitConservesPrice` |
| Escrow solvency | `totalLocked`/`totalOwed` accounting | invariant `balancesMatchAccounting` |
| Hostile receivers can't block | push-or-credit `_payout`, `claim` | `test_rejectingEthPayout_isDeferredAndClaimable`, `test_blockedReferrer_doesNotBlockSettlement` |
| Fee-on-transfer rejected | balance-delta checks both ways | `test_revert_feeOnTransferToken` |
| USDT-style tokens | SafeERC20 | `test_noReturnToken_settles` |
| Permit front-run harmless | `try permit {} catch {}` | `test_permitFrontRun_doesNotBlock` |
| Relayer binding | EIP-712 `Deliver(dealId, relayer, deadline)` with chainId + contract in domain | `test_revert_ghostMode_otherRelayer`, `test_revert_ghostMode_expiredAuth` |
| Vault can't leak fees | no withdraw path; allowance reset; spend ≤ amountIn | `test_burnStable`, `test_revert_burnMoreThanBalance` |
| Min-out checked twice | route check + dead-address delta | `test_revert_lyingRouteCaughtBySecondCheck` |
| 48h route timelock | `queueRoute`/`activateRoute` | `test_queueAndActivate_afterDelay`, `test_cancelRoute` |

## Known limitations / accepted risks
1. **Flash-loaned holder discount.** A party could borrow the platform token within the settlement
   transaction to qualify for −0.5 %. Bounded to 50 bps; mitigations (snapshot balances, time-weighted
   holding) are deferred.
2. **ETH fee tiers are fixed in wei** (no oracle by design). USD drift is accepted; redeploy to retune.
3. **Buyer griefing**: a seller cannot be forced to deliver; a buyer's funds are locked until the
   deadline (max 30 days, UI defaults to hours). Expected behaviour.
4. **Rebasing tokens** may cause `TransferAmountMismatch` and fail to settle (fails closed → refund).
5. **UniswapV4BurnRoute is compiled but not yet exercised**: it needs a mainnet-fork test against the
   real PoolManager (`forge test --fork-url $ROBINHOOD_RPC_URL`). Pools with hooks are rejected.
6. **Permit2 is not implemented** (only EIP-2612 + plain allowance). Planned.
7. **Vault keeper/governor are immutable**; moving to a multisig means deploying a new vault (and a new
   escrow pointing to it). The governor can choose routes but can never withdraw.
8. Static analysis (Slither / Aderyn) and coverage have **not been run yet** in this environment.

## Test run
Foundry 1.9.0, `forge test`: **51 passed, 0 failed** (38 escrow unit/fuzz with 1,000 fuzz runs each,
12 vault, 1 invariant suite with 4 invariants × 256 runs × 64 depth = 16,384 calls, 0 reverts).
Runtime sizes: OtcEscrow 13.3 KB, BuyBurnVault 4.1 KB, UniswapV4BurnRoute 3.9 KB (limit 24 KB).
