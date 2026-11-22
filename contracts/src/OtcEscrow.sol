// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title OtcEscrow
/// @notice Non-custodial atomic settlement for sealed-bid OTC block trades.
///         - No owner, no admin key, no pause, no upgrade.
///         - A deal is identified by the hash of its full terms; terms can never change.
///         - Payment locks first. The seller's deposit IS the settlement (one transaction swap).
///         - If the seller does not deliver before the deadline, anyone can refund the buyer.
/// @dev    Supported pay tokens: native ETH (address(0)), one stablecoin, and the platform token
///         (DISCOUNT_TOKEN), all fixed at deployment. Deals paid in the platform token pay a flat
///         TOKEN_PAY_FEE_BPS, and the protocol's share of that fee is burned (sent to DEAD) in the
///         settlement transaction instead of going to the fee vault. The referrer share is unchanged.
contract OtcEscrow is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------

    /// @notice Full, immutable terms of one deal. dealId = keccak256(abi.encode(terms)).
    struct Terms {
        address buyer; // receives `amount` of `token`; refunded on expiry
        address seller; // wallet the tokens are pulled from (may be a one-time wallet)
        address token; // asset being sold
        uint256 amount; // base units of `token`
        address payToken; // address(0) = native ETH, STABLE, or the platform token (DISCOUNT_TOKEN)
        uint256 price; // total payment in base units of `payToken`
        address sellerPayout; // receives the seller's net proceeds
        address referrer; // optional; earns half the protocol fee
        uint256 relayerFee; // paid from the seller's proceeds to the relayer (Ghost mode)
        uint64 deadline; // unix seconds; settle while now <= deadline, refund once now > deadline
        bytes32 salt; // uniqueness (partial fills = many deals per posting)
    }

    /// @notice EIP-2612 permit parameters. `deadline == 0` means "no permit, use existing allowance".
    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    enum Status {
        None,
        PaymentLocked,
        Settled,
        Refunded
    }

    // ------------------------------------------------------------------------------------------
    // Constants & immutables
    // ------------------------------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 250;
    uint256 public constant TIER0_FEE_BPS = 250;
    uint256 public constant TIER1_FEE_BPS = 200;
    uint256 public constant TIER2_FEE_BPS = 150;
    uint256 public constant HOLDER_DISCOUNT_BPS = 50;
    /// @notice Flat fee for deals paid in the platform token (no tiers, no holder discount).
    uint256 public constant TOKEN_PAY_FEE_BPS = 150;
    /// @notice Where the protocol's share of a platform-token fee goes: burned.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_DEAL_DURATION = 30 days;

    bytes32 public constant DELIVER_TYPEHASH =
        keccak256("Deliver(bytes32 dealId,address relayer,uint256 deadline)");

    address public immutable STABLE;
    uint256 public immutable STABLE_TIER1;
    uint256 public immutable STABLE_TIER2;
    uint256 public immutable ETH_TIER1;
    uint256 public immutable ETH_TIER2;
    address public immutable FEE_VAULT;
    address public immutable DISCOUNT_TOKEN;
    uint256 public immutable MIN_HOLDING;

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    mapping(bytes32 dealId => Status) public status;

    /// @notice Pull-payment balances for payouts that could not be pushed (reverting receiver,
    ///         blacklisted address, ...). Never blocks settlement or refunds.
    mapping(address payToken => mapping(address account => uint256)) public owed;

    /// @notice Accounting used by invariants: escrow balance == totalLocked + totalOwed.
    mapping(address payToken => uint256) public totalLocked;
    mapping(address payToken => uint256) public totalOwed;

    // ------------------------------------------------------------------------------------------
    // Events & errors
    // ------------------------------------------------------------------------------------------

    event PaymentLocked(
        bytes32 indexed dealId, address indexed buyer, address indexed seller, address payToken, uint256 price, address payer
    );
    event Settled(
        bytes32 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount,
        address payToken,
        uint256 price,
        uint256 fee,
        uint256 referrerFee,
        uint256 relayerFee,
        address relayer
    );
    event Refunded(bytes32 indexed dealId, address indexed buyer, address payToken, uint256 price);
    /// @notice The protocol's share of a fee paid in the platform token, sent to DEAD at settlement.
    event FeeBurned(bytes32 indexed dealId, address indexed token, uint256 amount);
    event PayoutDeferred(address indexed payToken, address indexed account, uint256 amount);
    event Claimed(address indexed payToken, address indexed account, address to, uint256 amount);

    error ZeroAddress();
    error SameParty();
    error InvalidToken();
    error UnsupportedPayToken();
    error ZeroAmount();
    error InvalidReferrer();
    error FeesExceedPrice();
    error DeadlinePassed();
    error DeadlineTooFar();
    error DeadlineNotPassed();
    error BadStatus(Status current);
    error WrongMsgValue();
    error NotSeller();
    error TransferAmountMismatch();
    error AuthorizationExpired();
    error InvalidSignature();
    error NothingToClaim();
    error ClaimFailed();

    // ------------------------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------------------------

    /// @param stable        The single supported ERC-20 pay token (e.g. a USD stablecoin).
    /// @param stableTiers   [tier1, tier2] notional thresholds in stable base units.
    /// @param ethTiers      [tier1, tier2] notional thresholds in wei.
    /// @param feeVault      Receives the protocol fee (minus referrer share).
    /// @param discountToken Platform token; holding MIN_HOLDING gives -0.5%. address(0) disables.
    /// @param minHolding    Minimum balance of discountToken for the holder discount.
    constructor(
        address stable,
        uint256[2] memory stableTiers,
        uint256[2] memory ethTiers,
        address feeVault,
        address discountToken,
        uint256 minHolding
    ) EIP712("OtcEscrow", "1") {
        if (stable == address(0) || feeVault == address(0)) revert ZeroAddress();
        if (stableTiers[0] == 0 || stableTiers[0] >= stableTiers[1]) revert ZeroAmount();
        if (ethTiers[0] == 0 || ethTiers[0] >= ethTiers[1]) revert ZeroAmount();
        STABLE = stable;
        STABLE_TIER1 = stableTiers[0];
        STABLE_TIER2 = stableTiers[1];
        ETH_TIER1 = ethTiers[0];
        ETH_TIER2 = ethTiers[1];
        FEE_VAULT = feeVault;
        DISCOUNT_TOKEN = discountToken;
        MIN_HOLDING = minHolding;
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    function dealIdOf(Terms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    /// @notice EIP-712 digest a seller signs to let `relayer` deliver on its behalf.
    function deliverDigest(bytes32 dealId, address relayer, uint256 authDeadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DELIVER_TYPEHASH, dealId, relayer, authDeadline)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function isHolder(address account) public view returns (bool) {
        if (DISCOUNT_TOKEN == address(0) || account == address(0)) return false;
        try IERC20(DISCOUNT_TOKEN).balanceOf(account) returns (uint256 bal) {
            return bal >= MIN_HOLDING;
        } catch {
            return false;
        }
    }

    /// @notice Fee in bps for a notional, before/after holder discount. Always <= MAX_FEE_BPS.
    function feeBps(address payToken, uint256 price, bool discounted) public view returns (uint256 bps) {
        if (_isTokenPay(payToken)) return TOKEN_PAY_FEE_BPS; // flat; the discount doesn't stack
        (uint256 t1, uint256 t2) = payToken == address(0) ? (ETH_TIER1, ETH_TIER2) : (STABLE_TIER1, STABLE_TIER2);
        if (price >= t2) bps = TIER2_FEE_BPS;
        else if (price >= t1) bps = TIER1_FEE_BPS;
        else bps = TIER0_FEE_BPS;
        if (discounted) bps -= HOLDER_DISCOUNT_BPS;
        if (bps > MAX_FEE_BPS) bps = MAX_FEE_BPS; // defensive; unreachable with the constants above
    }

    /// @notice Exact split the deal would settle with right now.
    function quote(Terms calldata t)
        public
        view
        returns (uint256 fee, uint256 referrerFee, uint256 vaultFee, uint256 sellerNet)
    {
        bool discounted = isHolder(t.buyer) || isHolder(t.seller);
        fee = (t.price * feeBps(t.payToken, t.price, discounted)) / BPS;
        referrerFee = t.referrer == address(0) ? 0 : fee / 2;
        vaultFee = fee - referrerFee;
        sellerNet = t.price - fee - t.relayerFee;
    }

    // ------------------------------------------------------------------------------------------
    // Buyer: lock payment
    // ------------------------------------------------------------------------------------------

    /// @notice Lock the payment leg. Anyone may fund; refunds always go to `t.buyer`.
    function depositPayment(Terms calldata t) external payable nonReentrant returns (bytes32 dealId) {
        dealId = _depositPayment(t);
    }

    /// @notice Lock a stablecoin payment using an EIP-2612 permit from msg.sender.
    function depositPaymentWithPermit(Terms calldata t, PermitData calldata p)
        external
        nonReentrant
        returns (bytes32 dealId)
    {
        if (t.payToken != address(0)) _tryPermit(t.payToken, msg.sender, p);
        dealId = _depositPayment(t);
    }

    // ------------------------------------------------------------------------------------------
    // Seller: deliver (= settle)
    // ------------------------------------------------------------------------------------------

    function deliver(Terms calldata t) external nonReentrant returns (bytes32) {
        if (msg.sender != t.seller) revert NotSeller();
        return _settle(t, address(0));
    }

    function deliverWithPermit(Terms calldata t, PermitData calldata p) external nonReentrant returns (bytes32) {
        if (msg.sender != t.seller) revert NotSeller();
        _tryPermit(t.token, t.seller, p);
        return _settle(t, address(0));
    }

    /// @notice Ghost mode: a relayer (msg.sender) delivers for a seller that signed a Deliver
    ///         authorization naming that relayer. Tokens come from `t.seller` via allowance or
    ///         permit; `t.relayerFee` is paid to the relayer from the seller's proceeds.
    function deliverFor(Terms calldata t, PermitData calldata p, uint256 authDeadline, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32)
    {
        if (block.timestamp > authDeadline) revert AuthorizationExpired();
        bytes32 dealId = dealIdOf(t);
        bytes32 digest = deliverDigest(dealId, msg.sender, authDeadline);
        if (!SignatureChecker.isValidSignatureNow(t.seller, digest, signature)) revert InvalidSignature();
        _tryPermit(t.token, t.seller, p);
        return _settle(t, msg.sender);
    }

    // ------------------------------------------------------------------------------------------
    // Refund & claims
    // ------------------------------------------------------------------------------------------

    /// @notice After the deadline, return a locked payment to the buyer. Callable by anyone.
    function refund(Terms calldata t) external nonReentrant returns (bytes32 dealId) {
        dealId = dealIdOf(t);
        Status s = status[dealId];
        if (s != Status.PaymentLocked) revert BadStatus(s);
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed();

        status[dealId] = Status.Refunded;
        totalLocked[t.payToken] -= t.price;
        _payout(t.payToken, t.buyer, t.price);
        emit Refunded(dealId, t.buyer, t.payToken, t.price);
    }

    /// @notice Withdraw a deferred payout to any address of the owner's choosing.
    function claim(address payToken, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[payToken][msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[payToken][msg.sender] = 0;
        totalOwed[payToken] -= amount;
        if (!_push(payToken, to, amount)) revert ClaimFailed();
        emit Claimed(payToken, msg.sender, to, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _validate(Terms calldata t) internal view {
        if (t.buyer == address(0) || t.seller == address(0) || t.sellerPayout == address(0)) revert ZeroAddress();
        if (t.buyer == t.seller) revert SameParty();
        if (t.token == address(0) || t.token == t.payToken || t.token.code.length == 0) revert InvalidToken();
        if (t.payToken != address(0) && t.payToken != STABLE && !_isTokenPay(t.payToken)) revert UnsupportedPayToken();
        if (t.amount == 0 || t.price == 0) revert ZeroAmount();
        if (t.referrer != address(0)) {
            if (t.referrer == t.buyer || t.referrer == t.seller || t.referrer == t.sellerPayout) {
                revert InvalidReferrer();
            }
        }
        // Worst-case fee must leave the seller something.
        if ((t.price * MAX_FEE_BPS) / BPS + t.relayerFee >= t.price) revert FeesExceedPrice();
    }

    function _depositPayment(Terms calldata t) internal returns (bytes32 dealId) {
        _validate(t);
        if (block.timestamp > t.deadline) revert DeadlinePassed();
        if (t.deadline > block.timestamp + MAX_DEAL_DURATION) revert DeadlineTooFar();

        dealId = dealIdOf(t);
        Status s = status[dealId];
        if (s != Status.None) revert BadStatus(s);

        // Effects
        status[dealId] = Status.PaymentLocked;
        totalLocked[t.payToken] += t.price;

        // Interactions
        if (t.payToken == address(0)) {
            if (msg.value != t.price) revert WrongMsgValue();
        } else {
            if (msg.value != 0) revert WrongMsgValue();
            _pullExact(t.payToken, msg.sender, t.price);
        }
        emit PaymentLocked(dealId, t.buyer, t.seller, t.payToken, t.price, msg.sender);
    }

    function _settle(Terms calldata t, address relayer) internal returns (bytes32 dealId) {
        dealId = dealIdOf(t);
        Status s = status[dealId];
        if (s != Status.PaymentLocked) revert BadStatus(s);
        if (block.timestamp > t.deadline) revert DeadlinePassed();

        (uint256 fee, uint256 referrerFee, uint256 vaultFee, uint256 sellerNet) = quote(t);

        // Effects
        status[dealId] = Status.Settled;
        totalLocked[t.payToken] -= t.price;

        // Token leg: seller -> escrow -> buyer, exact amounts enforced both ways.
        _pullExact(t.token, t.seller, t.amount);
        uint256 buyerBefore = IERC20(t.token).balanceOf(t.buyer);
        IERC20(t.token).safeTransfer(t.buyer, t.amount);
        if (IERC20(t.token).balanceOf(t.buyer) - buyerBefore != t.amount) revert TransferAmountMismatch();

        // Payment leg
        uint256 relayerFee = t.relayerFee;
        if (relayer == address(0)) {
            sellerNet += relayerFee; // no relayer used: the fee stays with the seller
            relayerFee = 0;
        } else {
            _payout(t.payToken, relayer, relayerFee);
        }
        _payout(t.payToken, t.sellerPayout, sellerNet);
        if (_isTokenPay(t.payToken)) {
            // Paid in the platform token: the protocol's share is burned right here.
            _payout(t.payToken, DEAD, vaultFee);
            if (vaultFee != 0) emit FeeBurned(dealId, t.payToken, vaultFee);
        } else {
            _payout(t.payToken, FEE_VAULT, vaultFee);
        }
        if (referrerFee != 0) _payout(t.payToken, t.referrer, referrerFee);

        emit Settled(
            dealId, t.buyer, t.seller, t.token, t.amount, t.payToken, t.price, fee, referrerFee, relayerFee, relayer
        );
    }

    /// @dev The platform token is a pay token only when one was set at deploy.
    function _isTokenPay(address payToken) internal view returns (bool) {
        return DISCOUNT_TOKEN != address(0) && payToken == DISCOUNT_TOKEN;
    }

    /// @dev Pull exactly `amount` into the escrow or revert (rejects fee-on-transfer tokens).
    function _pullExact(address token, address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert TransferAmountMismatch();
    }

    /// @dev Permit may be front-run by anyone who saw it in the mempool; that is harmless as long
    ///      as the allowance exists, so failures are ignored and transferFrom decides.
    function _tryPermit(address token, address owner, PermitData calldata p) internal {
        if (p.deadline == 0) return;
        try IERC20Permit(token).permit(owner, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
    }

    /// @dev Push a payout; if the receiver cannot take it, credit a pull balance instead so that
    ///      a hostile receiver can never block settlement or refund for the other party.
    function _payout(address payToken, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_push(payToken, to, amount)) {
            owed[payToken][to] += amount;
            totalOwed[payToken] += amount;
            emit PayoutDeferred(payToken, to, amount);
        }
    }

    function _push(address payToken, address to, uint256 amount) internal returns (bool ok) {
        if (payToken == address(0)) {
            // No returndata copy: immune to return-bombs.
            assembly ("memory-safe") {
                ok := call(gas(), to, amount, 0, 0, 0, 0)
            }
        } else {
            bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
            uint256 retSize;
            uint256 retVal;
            assembly ("memory-safe") {
                ok := call(gas(), payToken, 0, add(data, 0x20), mload(data), 0, 0x20)
                retSize := returndatasize()
                retVal := mload(0)
            }
            if (ok) ok = retSize == 0 ? payToken.code.length > 0 : retVal == 1;
        }
    }
}
