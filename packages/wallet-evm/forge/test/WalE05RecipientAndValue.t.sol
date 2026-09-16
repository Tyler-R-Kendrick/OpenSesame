// SPDX-License-Identifier: MIT AND Apache-2.0
pragma solidity 0.8.23;

/**
 * OpenSesame WAL-E05 — independent restrictions reject wrong recipient calldata
 * and nonzero native value alongside an ERC-20 transfer (MetaMask pin bff4b08).
 */

import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

import { Execution } from "../../src/utils/Types.sol";
import { CaveatEnforcerBaseTest } from "../enforcers/CaveatEnforcerBaseTest.t.sol";
import { ExactCalldataEnforcer } from "../../src/enforcers/ExactCalldataEnforcer.sol";
import { ValueLteEnforcer } from "../../src/enforcers/ValueLteEnforcer.sol";
import { BasicERC20, IERC20 } from "../utils/BasicERC20.t.sol";
import { ICaveatEnforcer } from "../../src/interfaces/ICaveatEnforcer.sol";

contract WalE05RecipientAndValueTest is CaveatEnforcerBaseTest {
    ExactCalldataEnforcer public exactCalldataEnforcer;
    ValueLteEnforcer public valueLteEnforcer;
    BasicERC20 public token;

    address public alice;
    address public bob;
    address public dave;

    function setUp() public override {
        super.setUp();
        exactCalldataEnforcer = new ExactCalldataEnforcer();
        valueLteEnforcer = new ValueLteEnforcer();
        alice = address(users.alice.deleGator);
        bob = address(users.bob.deleGator);
        dave = address(users.dave.deleGator);
        token = new BasicERC20(alice, "TEST", "TEST", 100 ether);
    }

    /// @notice WAL-E05: ExactCalldata pins transfer recipient; alternate to is refused.
    function test_wal_e05_wrongRecipientCalldataRejected() public {
        bytes memory approvedCalldata_ = abi.encodeWithSelector(IERC20.transfer.selector, bob, uint256(100));
        bytes memory hostileCalldata_ = abi.encodeWithSelector(IERC20.transfer.selector, dave, uint256(100));

        Execution memory approved_ =
            Execution({ target: address(token), value: 0, callData: approvedCalldata_ });
        Execution memory hostile_ =
            Execution({ target: address(token), value: 0, callData: hostileCalldata_ });

        bytes memory approvedExec_ =
            ExecutionLib.encodeSingle(approved_.target, approved_.value, approved_.callData);
        bytes memory hostileExec_ =
            ExecutionLib.encodeSingle(hostile_.target, hostile_.value, hostile_.callData);

        vm.prank(address(delegationManager));
        exactCalldataEnforcer.beforeHook(
            approvedCalldata_, "", singleDefaultMode, approvedExec_, bytes32(0), address(0), address(0)
        );

        vm.prank(address(delegationManager));
        vm.expectRevert("ExactCalldataEnforcer:invalid-calldata");
        exactCalldataEnforcer.beforeHook(
            approvedCalldata_, "", singleDefaultMode, hostileExec_, bytes32(0), address(0), address(0)
        );
    }

    /// @notice WAL-E05: ValueLte(0) refuses native value with token transfer calldata.
    function test_wal_e05_nonzeroNativeValueWithTokenCalldataRejected() public {
        bytes memory transferCalldata_ = abi.encodeWithSelector(IERC20.transfer.selector, bob, uint256(50));
        bytes memory termsZero_ = abi.encodePacked(uint256(0));

        Execution memory withValue_ =
            Execution({ target: address(token), value: 1 wei, callData: transferCalldata_ });
        bytes memory exec_ =
            ExecutionLib.encodeSingle(withValue_.target, withValue_.value, withValue_.callData);

        vm.prank(address(delegationManager));
        vm.expectRevert("ValueLteEnforcer:value-too-high");
        valueLteEnforcer.beforeHook(termsZero_, "", singleDefaultMode, exec_, bytes32(0), address(0), address(0));
    }

    function _getEnforcer() internal view override returns (ICaveatEnforcer) {
        return ICaveatEnforcer(address(exactCalldataEnforcer));
    }
}
