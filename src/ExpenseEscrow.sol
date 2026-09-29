// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal token surface. MockUSDC on Base Sepolia; the escrow does not assume mint.
interface IEscrowToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ExpenseEscrow
/// @notice Legacy Phase 1 prototype. Holds a project budget and pays the payee stored with a
///         recorded APPROVE, or a HOLD the client has approved. `release` cannot substitute that
///         payee. This is not the target protocol in docs/adr. The contract does not interpret
///         invoices. See DECISIONS.md.
contract ExpenseEscrow {
    uint8 public constant DECISION_APPROVE = 1;
    uint8 public constant DECISION_HOLD = 2;
    uint8 public constant DECISION_BLOCK = 3;

    /// @dev Spec section 12. `timestamp` in calldata is ignored; the contract stores block.timestamp.
    struct PaymentDecision {
        bytes32 projectId;
        bytes32 evidenceHash;
        bytes32 policyHash;
        uint256 amount;
        uint8 decision;
        uint256 timestamp;
    }

    struct Project {
        address client;
        bytes32 policyHash;
        uint256 budget;
        uint256 deposited;
        uint256 spent;
        bool stopped;
        bool exists;
    }

    struct Record {
        PaymentDecision decision;
        address payee;
        bool exists;
        bool clientApproved;
        bool rejected;
        bool released;
    }

    IEscrowToken public immutable token;
    address public immutable owner;
    address public agent;

    /// @dev 1 = idle, 2 = inside a guarded call.
    uint256 private locked = 1;

    mapping(bytes32 => Project) public projects;
    mapping(bytes32 => Record) private records;

    event ProjectCreated(bytes32 indexed projectId, address indexed client, bytes32 policyHash, uint256 budget);
    event Deposited(bytes32 indexed projectId, address indexed from, uint256 amount);
    event DecisionRecorded(
        bytes32 indexed projectId,
        bytes32 indexed evidenceHash,
        address payee,
        bytes32 policyHash,
        uint256 amount,
        uint8 decision,
        uint256 timestamp
    );
    event HoldApproved(bytes32 indexed projectId, bytes32 indexed evidenceHash);
    event HoldRejected(bytes32 indexed projectId, bytes32 indexed evidenceHash);
    event PaymentReleased(
        bytes32 indexed projectId, bytes32 indexed evidenceHash, address indexed payee, uint256 amount
    );
    event ProjectStopped(bytes32 indexed projectId);
    event AgentUpdated(address indexed agent);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroHash();
    error NotOwner();
    error NotAgent();
    error NotClient();
    error ProjectExists();
    error ProjectNotFound();
    error ProjectIsStopped();
    error BadDecision();
    error PolicyMismatch();
    error DuplicateDecision();
    error DecisionNotFound();
    error NotReleasable();
    error AlreadyReleased();
    error AmountMismatch();
    error PayeeMismatch();
    error OverBudget();
    error InsufficientDeposit();
    error HoldNotPending();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address token_, address agent_) {
        if (token_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        token = IEscrowToken(token_);
        agent = agent_;
        owner = msg.sender;
    }

    /// @notice Deployer can point release authority at a new backend signer.
    function setAgent(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        agent = next;
        emit AgentUpdated(next);
    }

    /// @notice Caller becomes the client. `budget` is the spending cap in token base units (6 decimals).
    function createProject(bytes32 projectId, bytes32 policyHash, uint256 budget) external {
        if (projectId == bytes32(0) || policyHash == bytes32(0)) revert ZeroHash();
        if (budget == 0) revert ZeroAmount();
        if (projects[projectId].exists) revert ProjectExists();

        projects[projectId] = Project({
            client: msg.sender,
            policyHash: policyHash,
            budget: budget,
            deposited: 0,
            spent: 0,
            stopped: false,
            exists: true
        });
        emit ProjectCreated(projectId, msg.sender, policyHash, budget);
    }

    /// @notice Pulls the unfunded remainder of the budget from the client. One call funds the project.
    ///         The spec signature has no amount; partial deposits are not supported.
    function deposit(bytes32 projectId) external nonReentrant {
        Project storage project = projects[projectId];
        if (!project.exists) revert ProjectNotFound();
        if (msg.sender != project.client) revert NotClient();
        if (project.stopped) revert ProjectIsStopped();

        uint256 amount = project.budget - project.deposited;
        if (amount == 0) revert ZeroAmount();
        project.deposited = project.budget;

        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(projectId, msg.sender, amount);
    }

    /// @notice Backend logs APPROVE, HOLD, or BLOCK and binds `payee`. Does not move tokens.
    ///         APPROVE and HOLD require a non-zero payee. That address cannot be changed later.
    function recordDecision(PaymentDecision calldata decision, address payee) external {
        if (msg.sender != agent) revert NotAgent();
        if (decision.projectId == bytes32(0) || decision.evidenceHash == bytes32(0)) revert ZeroHash();
        if (decision.amount == 0) revert ZeroAmount();
        if (
            decision.decision != DECISION_APPROVE && decision.decision != DECISION_HOLD
                && decision.decision != DECISION_BLOCK
        ) revert BadDecision();
        if (decision.decision != DECISION_BLOCK && payee == address(0)) revert ZeroAddress();

        Project storage project = projects[decision.projectId];
        if (!project.exists) revert ProjectNotFound();
        if (project.stopped) revert ProjectIsStopped();
        if (decision.policyHash != project.policyHash) revert PolicyMismatch();

        bytes32 hash = decisionHash(decision.projectId, decision.evidenceHash);
        if (records[hash].exists) revert DuplicateDecision();

        PaymentDecision memory stored = decision;
        stored.timestamp = block.timestamp;
        records[hash] = Record({
            decision: stored, payee: payee, exists: true, clientApproved: false, rejected: false, released: false
        });

        emit DecisionRecorded(
            stored.projectId,
            stored.evidenceHash,
            payee,
            stored.policyHash,
            stored.amount,
            stored.decision,
            stored.timestamp
        );
    }

    /// @notice Client releases a HOLD into the payable set. The backend still calls `release`.
    function approveHold(bytes32 projectId, bytes32 evidenceHash) external {
        _holdAction(projectId, evidenceHash, true);
    }

    /// @notice Client closes a HOLD so it can never be paid. The decision stays on the log.
    function rejectHold(bytes32 projectId, bytes32 evidenceHash) external {
        _holdAction(projectId, evidenceHash, false);
    }

    /// @notice Pays the payee stored on the decision. Agent only. APPROVE, or HOLD after `approveHold`.
    ///         A different `payee` reverts. `evidenceHash` identifies the decision.
    function release(bytes32 projectId, bytes32 evidenceHash, address payee, uint256 amount) external nonReentrant {
        if (msg.sender != agent) revert NotAgent();

        Project storage project = projects[projectId];
        if (!project.exists) revert ProjectNotFound();
        if (project.stopped) revert ProjectIsStopped();

        Record storage record = records[decisionHash(projectId, evidenceHash)];
        if (!record.exists) revert DecisionNotFound();
        if (record.released) revert AlreadyReleased();
        if (payee != record.payee) revert PayeeMismatch();

        uint8 code = record.decision.decision;
        bool payableDecision = code == DECISION_APPROVE || (code == DECISION_HOLD && record.clientApproved);
        if (!payableDecision) revert NotReleasable();
        if (amount != record.decision.amount) revert AmountMismatch();
        if (project.spent + amount > project.budget) revert OverBudget();
        if (project.spent + amount > project.deposited) revert InsufficientDeposit();

        project.spent += amount;
        record.released = true;

        if (!token.transfer(payee, amount)) revert TransferFailed();
        emit PaymentReleased(projectId, evidenceHash, payee, amount);
    }

    /// @notice Client kill switch. Later `recordDecision` and `release` revert.
    function stopProject(bytes32 projectId) external {
        Project storage project = projects[projectId];
        if (!project.exists) revert ProjectNotFound();
        if (msg.sender != project.client) revert NotClient();
        if (project.stopped) revert ProjectIsStopped();
        project.stopped = true;
        emit ProjectStopped(projectId);
    }

    function getRecord(bytes32 projectId, bytes32 evidenceHash)
        external
        view
        returns (PaymentDecision memory decision, address payee, bool clientApproved, bool rejected, bool released)
    {
        Record storage record = records[decisionHash(projectId, evidenceHash)];
        return (record.decision, record.payee, record.clientApproved, record.rejected, record.released);
    }

    /// @dev Same evidence cannot be decided twice on one project. BLOCK and APPROVE share this key.
    function decisionHash(bytes32 projectId, bytes32 evidenceHash) public pure returns (bytes32) {
        return keccak256(abi.encode(projectId, evidenceHash));
    }

    function _holdAction(bytes32 projectId, bytes32 evidenceHash, bool approve) internal {
        Project storage project = projects[projectId];
        if (!project.exists) revert ProjectNotFound();
        if (msg.sender != project.client) revert NotClient();
        if (project.stopped) revert ProjectIsStopped();

        Record storage record = records[decisionHash(projectId, evidenceHash)];
        if (!record.exists) revert DecisionNotFound();
        if (record.decision.decision != DECISION_HOLD || record.rejected || record.clientApproved || record.released) {
            revert HoldNotPending();
        }

        if (approve) {
            record.clientApproved = true;
            emit HoldApproved(projectId, evidenceHash);
        } else {
            record.rejected = true;
            emit HoldRejected(projectId, evidenceHash);
        }
    }
}
