// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ExpenseEscrow} from "../src/ExpenseEscrow.sol";

contract ExpenseEscrowTest is Test {
    MockUSDC internal usdc;
    ExpenseEscrow internal escrow;

    address internal owner = makeAddr("owner");
    address internal client = makeAddr("client");
    address internal agent = makeAddr("agent");
    address internal payee = makeAddr("payee");

    bytes32 internal projectId = keccak256("website-development");
    bytes32 internal policyHash = keccak256("policy-v1");
    uint256 internal budget = 1_000e6;

    uint8 internal constant APPROVE = 1;
    uint8 internal constant HOLD = 2;
    uint8 internal constant BLOCK_DECISION = 3;

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new ExpenseEscrow(address(usdc), agent);
    }

    function test_happyPathRelease() public {
        _openAndFund();
        bytes32 evidence = keccak256("aws-invoice");
        uint256 amount = 200e6;

        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, amount, APPROVE));

        (ExpenseEscrow.PaymentDecision memory stored,,,) = escrow.getRecord(projectId, evidence);
        assertEq(stored.timestamp, block.timestamp);
        assertEq(stored.decision, APPROVE);

        vm.prank(agent);
        escrow.release(projectId, evidence, payee, amount);

        assertEq(usdc.balanceOf(payee), amount);
        assertEq(usdc.balanceOf(address(escrow)), budget - amount);
        (,,, uint256 deposited, uint256 spent, bool stopped,) = escrow.projects(projectId);
        assertEq(deposited, budget);
        assertEq(spent, amount);
        assertFalse(stopped);
    }

    function test_releaseWithoutRecordedApproveReverts() public {
        _openAndFund();
        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.DecisionNotFound.selector);
        escrow.release(projectId, keccak256("missing"), payee, 200e6);
    }

    function test_releaseHoldWithoutClientApprovalReverts() public {
        _openAndFund();
        bytes32 evidence = keccak256("held");
        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, 200e6, HOLD));

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.NotReleasable.selector);
        escrow.release(projectId, evidence, payee, 200e6);
    }

    function test_releaseBlockReverts() public {
        _openAndFund();
        bytes32 evidence = keccak256("console");
        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, 300e6, BLOCK_DECISION));

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.NotReleasable.selector);
        escrow.release(projectId, evidence, payee, 300e6);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_overBudgetReverts() public {
        _openAndFund();
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");

        vm.startPrank(agent);
        escrow.recordDecision(_decision(first, 600e6, APPROVE));
        escrow.recordDecision(_decision(second, 500e6, APPROVE));
        escrow.release(projectId, first, payee, 600e6);

        vm.expectRevert(ExpenseEscrow.OverBudget.selector);
        escrow.release(projectId, second, payee, 500e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(payee), 600e6);
    }

    function test_releaseAboveProjectBudgetReverts() public {
        _openAndFund();
        bytes32 evidence = keccak256("too-big");
        uint256 amount = budget + 1;

        vm.startPrank(agent);
        escrow.recordDecision(_decision(evidence, amount, APPROVE));
        vm.expectRevert(ExpenseEscrow.OverBudget.selector);
        escrow.release(projectId, evidence, payee, amount);
        vm.stopPrank();
    }

    function test_releaseAfterStopReverts() public {
        _openAndFund();
        bytes32 evidence = keccak256("aws");
        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, 200e6, APPROVE));

        vm.prank(client);
        escrow.stopProject(projectId);

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.ProjectIsStopped.selector);
        escrow.release(projectId, evidence, payee, 200e6);
    }

    function test_recordDecisionAfterStopReverts() public {
        _openAndFund();
        vm.prank(client);
        escrow.stopProject(projectId);

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.ProjectIsStopped.selector);
        escrow.recordDecision(_decision(keccak256("late"), 200e6, BLOCK_DECISION));
    }

    function test_duplicateDecisionHashReverts() public {
        _openAndFund();
        bytes32 evidence = keccak256("invoice-1023");

        vm.startPrank(agent);
        escrow.recordDecision(_decision(evidence, 200e6, APPROVE));
        vm.expectRevert(ExpenseEscrow.DuplicateDecision.selector);
        escrow.recordDecision(_decision(evidence, 200e6, BLOCK_DECISION));
        vm.stopPrank();
    }

    function test_clientApprovedHoldReleases() public {
        _openAndFund();
        bytes32 evidence = keccak256("invoice-1023");
        uint256 amount = 200e6;

        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, amount, HOLD));

        vm.prank(client);
        escrow.approveHold(projectId, evidence);

        vm.prank(agent);
        escrow.release(projectId, evidence, payee, amount);
        assertEq(usdc.balanceOf(payee), amount);
    }

    function test_rejectedHoldCannotBeApprovedOrReleased() public {
        _openAndFund();
        bytes32 evidence = keccak256("invoice-1023");

        vm.prank(agent);
        escrow.recordDecision(_decision(evidence, 200e6, HOLD));

        vm.prank(client);
        escrow.rejectHold(projectId, evidence);

        vm.prank(client);
        vm.expectRevert(ExpenseEscrow.HoldNotPending.selector);
        escrow.approveHold(projectId, evidence);

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.NotReleasable.selector);
        escrow.release(projectId, evidence, payee, 200e6);
    }

    function test_strangerCannotRecordOrStop() public {
        _openAndFund();
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(ExpenseEscrow.NotAgent.selector);
        escrow.recordDecision(_decision(keccak256("x"), 200e6, APPROVE));

        vm.prank(stranger);
        vm.expectRevert(ExpenseEscrow.NotClient.selector);
        escrow.stopProject(projectId);

        vm.prank(client);
        vm.expectRevert(ExpenseEscrow.NotAgent.selector);
        escrow.release(projectId, keccak256("x"), payee, 200e6);
    }

    function test_policyMismatchReverts() public {
        _openAndFund();
        ExpenseEscrow.PaymentDecision memory decision = _decision(keccak256("x"), 200e6, APPROVE);
        decision.policyHash = keccak256("other-policy");

        vm.prank(agent);
        vm.expectRevert(ExpenseEscrow.PolicyMismatch.selector);
        escrow.recordDecision(decision);
    }

    function _openAndFund() internal {
        usdc.mint(client, budget);
        vm.startPrank(client);
        usdc.approve(address(escrow), budget);
        escrow.createProject(projectId, policyHash, budget);
        escrow.deposit(projectId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), budget);
        assertEq(usdc.balanceOf(client), 0);
    }

    function _decision(bytes32 evidence, uint256 amount, uint8 code)
        internal
        view
        returns (ExpenseEscrow.PaymentDecision memory decision)
    {
        decision = ExpenseEscrow.PaymentDecision({
            projectId: projectId,
            evidenceHash: evidence,
            policyHash: policyHash,
            amount: amount,
            decision: code,
            timestamp: 1
        });
    }
}
