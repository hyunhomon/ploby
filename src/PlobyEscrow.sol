// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PlobyEscrow
/// @notice Ploby's on-chain rail (current implementation; testnet only, not audited). One registry holds every
/// project's funds. Ploby's off-chain engine decides each request under the policy both parties signed; this
/// contract holds the money and enforces what the engine's operator key can never do, even if it is stolen:
///  - pay anyone but the contractor the client fixed at opening, or refund anyone but the client;
///  - reserve, pay or refund more than the client funded, or pay an expense or milestone more than was
///    reserved for it;
///  - make a new reservation while the client has paused the project (the client's stop);
///  - record a decision under a policy hash the client has not accepted.
/// Every call carries the Ploby log head right after the log line that caused it (and the call's number within
/// that line): the chain anchors the hash-chained log, each event names its exact line, and a call can never
/// be applied twice.
/// @dev The token is TestKRW (no hooks); state is written before every transfer.
contract PlobyEscrow {
    uint8 public constant APPROVE = 1;
    uint8 public constant HOLD = 2;
    uint8 public constant BLOCK = 3;

    struct Project {
        address client;
        address contractor;
        bytes32 policyHash; // the policy version the client accepted last (both parties signed it off chain)
        uint256 budget; // that policy's project budget: the most the client can fund
        uint256 funded;
        uint256 reserved; // held for the contractor: approved expense commitments and funded milestones
        uint256 paid; // released to the contractor
        uint256 refunded; // returned to the client
        bool paused; // the client's stop: no new reservation
        bytes32 logHead; // the Ploby log head of the latest call
    }

    IERC20Min public immutable token;
    address public immutable operator;
    mapping(bytes32 => Project) public projects;
    mapping(bytes32 => mapping(bytes32 => uint256)) public reservedFor; // project => ref (E1, M2) => amount
    mapping(bytes32 => bool) public applied; // keccak256(project, logHead, n) of every call made

    event Opened(bytes32 indexed projectId, address indexed client, address indexed contractor, bytes32 policyHash,
        uint256 budget, bytes32 logHead);
    event Funded(bytes32 indexed projectId, uint256 amount, uint256 funded, bytes32 logHead);
    event PolicyAccepted(bytes32 indexed projectId, bytes32 policyHash, uint256 budget, bytes32 logHead);
    event PauseSet(bytes32 indexed projectId, bool paused, bytes32 logHead);
    event Decided(bytes32 indexed projectId, bytes32 indexed ref, uint8 decision, bytes32 rule, uint256 amount,
        bytes32 policyHash, bytes32 logHead);
    event Settled(bytes32 indexed projectId, bytes32 indexed ref, address indexed payee, uint256 paid,
        uint256 returned, bytes32 logHead);
    event Refunded(bytes32 indexed projectId, address indexed client, uint256 amount, bytes32 logHead);

    error ZeroAddress();
    error ZeroHash();
    error ZeroAmount();
    error NotClient();
    error NotOperator();
    error NoProject();
    error ProjectExists();
    error AlreadyApplied();
    error OverBudget();
    error InsufficientFunds();
    error OverReserved();
    error ProjectPaused();
    error PolicyMismatch();
    error BadDecision();
    error TransferFailed();

    constructor(address token_, address operator_) {
        if (token_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        token = IERC20Min(token_);
        operator = operator_;
    }

    // -- the client

    function open(bytes32 id, address contractor, bytes32 policyHash, uint256 budget, bytes32 logHead) external {
        if (id == bytes32(0) || policyHash == bytes32(0)) revert ZeroHash();
        if (contractor == address(0)) revert ZeroAddress();
        if (budget == 0) revert ZeroAmount();
        Project storage p = projects[id];
        if (p.client != address(0)) revert ProjectExists();
        p.client = msg.sender;
        p.contractor = contractor;
        p.policyHash = policyHash;
        p.budget = budget;
        p.logHead = logHead;
        emit Opened(id, msg.sender, contractor, policyHash, budget, logHead);
    }

    function fund(bytes32 id, uint256 amount, bytes32 logHead, uint8 n) external {
        Project storage p = _byClient(id);
        _once(id, logHead, n);
        if (amount == 0) revert ZeroAmount();
        if (p.funded + amount > p.budget) revert OverBudget();
        p.funded += amount;
        p.logHead = logHead;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(id, amount, p.funded, logHead);
    }

    /// @notice A new policy version both parties signed (a change order): later decisions must name it.
    function acceptPolicy(bytes32 id, bytes32 policyHash, uint256 budget, bytes32 logHead, uint8 n) external {
        Project storage p = _byClient(id);
        _once(id, logHead, n);
        if (policyHash == bytes32(0)) revert ZeroHash();
        if (budget < p.funded) revert OverBudget();
        p.policyHash = policyHash;
        p.budget = budget;
        p.logHead = logHead;
        emit PolicyAccepted(id, policyHash, budget, logHead);
    }

    /// @notice The client's stop: while paused nothing new can be reserved. Existing commitments still settle.
    function setPaused(bytes32 id, bool paused, bytes32 logHead, uint8 n) external {
        Project storage p = _byClient(id);
        _once(id, logHead, n);
        p.paused = paused;
        p.logHead = logHead;
        emit PauseSet(id, paused, logHead);
    }

    // -- the operator (Ploby's engine)

    /// @notice Records a decision. APPROVE reserves `amount` for `ref` (an expense commitment or a milestone);
    /// HOLD and BLOCK move no money and are recorded so that a stop is never silent.
    function decide(bytes32 id, bytes32 ref, uint8 decision, bytes32 rule, uint256 amount, bytes32 policyHash,
        bytes32 logHead, uint8 n) external {
        Project storage p = _byOperator(id);
        _once(id, logHead, n);
        if (decision < APPROVE || decision > BLOCK) revert BadDecision();
        if (policyHash != p.policyHash) revert PolicyMismatch();
        if (decision == APPROVE) {
            if (p.paused) revert ProjectPaused();
            if (amount == 0) revert ZeroAmount();
            if (amount > available(id)) revert InsufficientFunds();
            p.reserved += amount;
            reservedFor[id][ref] += amount;
        }
        p.logHead = logHead;
        emit Decided(id, ref, decision, rule, amount, policyHash, logHead);
    }

    /// @notice Pays `pay` of what is reserved for `ref` to the contractor and returns `returned` of it to the
    /// available balance.
    function settle(bytes32 id, bytes32 ref, uint256 pay, uint256 returned, bytes32 logHead, uint8 n) external {
        Project storage p = _byOperator(id);
        _once(id, logHead, n);
        uint256 held = reservedFor[id][ref];
        if (pay + returned == 0) revert ZeroAmount();
        if (pay + returned > held) revert OverReserved();
        reservedFor[id][ref] = held - pay - returned;
        p.reserved -= pay + returned;
        p.paid += pay;
        p.logHead = logHead;
        if (pay > 0 && !token.transfer(p.contractor, pay)) revert TransferFailed();
        emit Settled(id, ref, p.contractor, pay, returned, logHead);
    }

    /// @notice Returns unreserved money to the client (never to anyone else).
    function refund(bytes32 id, uint256 amount, bytes32 logHead, uint8 n) external {
        Project storage p = _byOperator(id);
        _once(id, logHead, n);
        if (amount == 0) revert ZeroAmount();
        if (amount > available(id)) revert InsufficientFunds();
        p.refunded += amount;
        p.logHead = logHead;
        if (!token.transfer(p.client, amount)) revert TransferFailed();
        emit Refunded(id, p.client, amount, logHead);
    }

    // -- reads

    function available(bytes32 id) public view returns (uint256) {
        Project storage p = projects[id];
        return p.funded - p.reserved - p.paid - p.refunded;
    }

    function key(bytes32 id, bytes32 logHead, uint8 n) public pure returns (bytes32) {
        return keccak256(abi.encode(id, logHead, n));
    }

    // -- internal

    function _project(bytes32 id) internal view returns (Project storage p) {
        p = projects[id];
        if (p.client == address(0)) revert NoProject();
    }

    function _byClient(bytes32 id) internal view returns (Project storage p) {
        p = _project(id);
        if (msg.sender != p.client) revert NotClient();
    }

    function _byOperator(bytes32 id) internal view returns (Project storage p) {
        if (msg.sender != operator) revert NotOperator();
        p = _project(id);
    }

    function _once(bytes32 id, bytes32 logHead, uint8 n) internal {
        bytes32 k = key(id, logHead, n);
        if (applied[k]) revert AlreadyApplied();
        applied[k] = true;
    }
}
