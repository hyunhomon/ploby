// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestKRW} from "../src/TestKRW.sol";
import {PlobyEscrow} from "../src/PlobyEscrow.sol";

contract PlobyEscrowTest is Test {
    TestKRW internal krw;
    PlobyEscrow internal escrow;

    address internal client = makeAddr("client");
    address internal contractor = makeAddr("contractor");
    address internal operator = makeAddr("operator");
    address internal thief = makeAddr("thief");

    bytes32 internal id = bytes32("p0123456789ab");
    bytes32 internal v1 = keccak256("policy-v1");
    bytes32 internal v2 = keccak256("policy-v2");
    uint256 internal budget = 1_000_000;
    uint8 internal constant APPROVE = 1;
    uint8 internal constant HOLD = 2;
    uint8 internal constant BLOCK = 3;
    uint8 internal line; // a fresh log head per call

    function setUp() public {
        krw = new TestKRW();
        escrow = new PlobyEscrow(address(krw), operator);
        krw.mint(client, 10_000_000);
        vm.prank(client);
        krw.approve(address(escrow), type(uint256).max);
    }

    function head() internal returns (bytes32) {
        line++;
        return keccak256(abi.encode("line", line));
    }

    function openAndFund(uint256 amount) internal {
        vm.startPrank(client);
        escrow.open(id, contractor, v1, budget, head());
        escrow.fund(id, amount, head(), 0);
        vm.stopPrank();
    }

    function decide(bytes32 ref, uint8 decision, uint256 amount) internal {
        vm.prank(operator);
        escrow.decide(id, ref, decision, bytes32("rule"), amount, v1, head(), 0);
    }

    function test_approveReservesAndSettlePaysTheFixedContractor() public {
        openAndFund(budget);
        decide("E1", APPROVE, 24_200);
        assertEq(escrow.reservedFor(id, "E1"), 24_200);
        assertEq(escrow.available(id), budget - 24_200);

        vm.prank(operator);
        escrow.settle(id, "E1", 24_000, 200, head(), 0);
        assertEq(krw.balanceOf(contractor), 24_000);
        assertEq(escrow.reservedFor(id, "E1"), 0);
        assertEq(escrow.available(id), budget - 24_000);
    }

    function test_holdAndBlockAreRecordedWithoutMovingMoney() public {
        openAndFund(budget);
        bytes32 h = keccak256("block-line");
        vm.expectEmit(true, true, false, true);
        emit PlobyEscrow.Decided(id, "E2", BLOCK, bytes32("per_purchase"), 26_400, v1, h);
        vm.prank(operator);
        escrow.decide(id, "E2", BLOCK, bytes32("per_purchase"), 26_400, v1, h, 0);
        decide("E3", HOLD, 3_000_000);
        assertEq(escrow.available(id), budget);
        assertEq(escrow.reservedFor(id, "E2"), 0);
    }

    function test_cannotPayMoreThanReserved() public {
        openAndFund(budget);
        decide("E1", APPROVE, 24_200);
        vm.prank(operator);
        vm.expectRevert(PlobyEscrow.OverReserved.selector);
        escrow.settle(id, "E1", 24_201, 0, head(), 0);
    }

    function test_cannotReserveMoreThanFunded() public {
        openAndFund(100_000);
        vm.prank(operator);
        vm.expectRevert(PlobyEscrow.InsufficientFunds.selector);
        escrow.decide(id, "M1", APPROVE, bytes32("milestone"), 100_001, v1, head(), 0);
    }

    function test_pauseStopsNewReservationsButNotSettlements() public {
        openAndFund(budget);
        decide("E1", APPROVE, 50_000);
        vm.prank(client);
        escrow.setPaused(id, true, head(), 0);

        vm.prank(operator);
        vm.expectRevert(PlobyEscrow.ProjectPaused.selector);
        escrow.decide(id, "E2", APPROVE, bytes32("ok"), 10_000, v1, head(), 0);

        decide("E2", BLOCK, 10_000); // the stop itself is still recorded
        vm.prank(operator);
        escrow.settle(id, "E1", 50_000, 0, head(), 0); // an existing commitment still settles
        assertEq(krw.balanceOf(contractor), 50_000);
    }

    function test_onlyTheClientPausesFundsAndAcceptsPolicies() public {
        openAndFund(100_000);
        vm.startPrank(operator);
        vm.expectRevert(PlobyEscrow.NotClient.selector);
        escrow.setPaused(id, true, head(), 0);
        vm.expectRevert(PlobyEscrow.NotClient.selector);
        escrow.acceptPolicy(id, v2, budget, head(), 0);
        vm.stopPrank();
    }

    function test_onlyTheOperatorDecidesSettlesAndRefunds() public {
        openAndFund(budget);
        vm.startPrank(thief);
        vm.expectRevert(PlobyEscrow.NotOperator.selector);
        escrow.decide(id, "E1", APPROVE, bytes32("ok"), 1, v1, head(), 0);
        vm.expectRevert(PlobyEscrow.NotOperator.selector);
        escrow.refund(id, 1, head(), 0);
        vm.stopPrank();
    }

    function test_refundGoesOnlyToTheClientAndNeverTouchesReservations() public {
        openAndFund(budget);
        decide("M1", APPROVE, 600_000);
        vm.prank(operator);
        vm.expectRevert(PlobyEscrow.InsufficientFunds.selector);
        escrow.refund(id, 400_001, head(), 0);
        uint256 before = krw.balanceOf(client);
        vm.prank(operator);
        escrow.refund(id, 400_000, head(), 0);
        assertEq(krw.balanceOf(client), before + 400_000);
        assertEq(escrow.available(id), 0);
    }

    function test_decisionsMustNameTheAcceptedPolicy() public {
        openAndFund(budget);
        vm.prank(operator);
        vm.expectRevert(PlobyEscrow.PolicyMismatch.selector);
        escrow.decide(id, "E1", APPROVE, bytes32("ok"), 1_000, v2, head(), 0);

        vm.prank(client);
        escrow.acceptPolicy(id, v2, budget + 500_000, head(), 0);
        vm.prank(operator);
        escrow.decide(id, "M3", APPROVE, bytes32("milestone"), 1_000, v2, head(), 0);
    }

    function test_fundingNeverExceedsTheAcceptedBudget() public {
        openAndFund(budget);
        vm.prank(client);
        vm.expectRevert(PlobyEscrow.OverBudget.selector);
        escrow.fund(id, 1, head(), 0);
    }

    function test_aCallIsAppliedOnce() public {
        openAndFund(budget);
        bytes32 h = head();
        vm.startPrank(operator);
        escrow.decide(id, "E1", APPROVE, bytes32("ok"), 1_000, v1, h, 0);
        vm.expectRevert(PlobyEscrow.AlreadyApplied.selector);
        escrow.decide(id, "E1", APPROVE, bytes32("ok"), 1_000, v1, h, 0);
        escrow.settle(id, "E1", 1_000, 0, h, 1); // the same line's next call is another call
        vm.stopPrank();
        assertEq(krw.balanceOf(contractor), 1_000);
    }

    function test_openTwiceReverts() public {
        openAndFund(budget);
        vm.prank(thief);
        vm.expectRevert(PlobyEscrow.ProjectExists.selector);
        escrow.open(id, thief, v1, budget, head());
    }
}
