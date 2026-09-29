// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ExpenseEscrow} from "../src/ExpenseEscrow.sol";

/// @notice Deploys MockUSDC and ExpenseEscrow on Base Sepolia.
///         Agent address comes from ESCROW_AGENT. The broadcast key is the contract owner.
contract Deploy is Script {
    function run() external {
        address agent = vm.envAddress("ESCROW_AGENT");
        if (block.chainid != 84532) revert("Base Sepolia only");

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        ExpenseEscrow escrow = new ExpenseEscrow(address(usdc), agent);
        vm.stopBroadcast();

        console.log("MockUSDC", address(usdc));
        console.log("ExpenseEscrow", address(escrow));
        console.log("agent", agent);
    }
}
