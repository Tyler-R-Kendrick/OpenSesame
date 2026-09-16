// SPDX-License-Identifier: MIT AND Apache-2.0
pragma solidity 0.8.23;

/**
 * OpenSesame WAL-E06 / WAL-E09 — method bypass refused; timestamp expiry refuses
 * redemption after the approved window (MetaMask pin bff4b08).
 */

import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

import { Execution } from "../../src/utils/Types.sol";
import { CaveatEnforcerBaseTest } from "../enforcers/CaveatEnforcerBaseTest.t.sol";
import { ERC20PeriodTransferEnforcer } from "../../src/enforcers/ERC20PeriodTransferEnforcer.sol";
import { TimestampEnforcer } from "../../src/enforcers/TimestampEnforcer.sol";
import { BasicERC20, IERC20 } from "../utils/BasicERC20.t.sol";
import { ICaveatEnforcer } from "../../src/interfaces/ICaveatEnforcer.sol";

contract WalE06E09MethodAndExpiryTest is CaveatEnforcerBaseTest {
    ERC20PeriodTransferEnforcer public periodEnforcer;
    TimestampEnforcer public timestampEnforcer;
    BasicERC20 public token;

    address public alice;
    address public bob;
    uint256 public constant PERIOD_AMOUNT = 1000;
    uint256 public constant PERIOD_DURATION = 1 days;
    uint256 public startDate;

    function setUp() public override {
        super.setUp();
        periodEnforcer = new ERC20PeriodTransferEnforcer();
        timestampEnforcer = new TimestampEnforcer();
        alice = address(users.alice.deleGator);
        bob = address(users.bob.deleGator);
        token = new BasicERC20(alice, "TEST", "TEST", 100 ether);
        startDate = block.timestamp;
    }

    /// @notice WAL-E06: approve / transferFrom are not accepted as period transfers.
    function test_wal_e06_approveAndTransferFromRejected() public {
        bytes memory terms_ =
            abi.encodePacked(address(token), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        bytes32 hash_ = keccak256("wal-e06");

        // Packed single-execution encoding matches ERC20PeriodTransferEnforcer.decodeSingle.
        bytes memory approveData_ =
            abi.encodeWithSelector(IERC20.approve.selector, bob, uint256(100));
        bytes memory approveExec_ = abi.encodePacked(address(token), uint256(0), approveData_);

        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:invalid-method");
        periodEnforcer.beforeHook(
            terms_, "", singleDefaultMode, approveExec_, hash_, address(0), bob
        );

        // 68-byte callData with transferFrom selector (upstream invalid-method shape).
        bytes memory transferFromData_ =
            abi.encodeWithSelector(IERC20.transferFrom.selector, bob, uint256(100));
        bytes memory transferFromExec_ =
            abi.encodePacked(address(token), uint256(0), transferFromData_);

        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:invalid-method");
        periodEnforcer.beforeHook(
            terms_, "", singleDefaultMode, transferFromExec_, hash_, address(0), bob
        );
    }

    /// @notice WAL-E09: TimestampEnforcer refuses execution after validUntil.
    function test_wal_e09_transferAfterExpiryRejected() public {
        uint128 afterTimestamp_ = uint128(block.timestamp + 1 hours);
        bytes memory terms_ = abi.encodePacked(uint128(0), afterTimestamp_);

        Execution memory exec_ = Execution({
            target: address(token),
            value: 0,
            callData: abi.encodeWithSelector(IERC20.transfer.selector, bob, uint256(1))
        });
        bytes memory execData_ =
            ExecutionLib.encodeSingle(exec_.target, exec_.value, exec_.callData);

        vm.prank(address(delegationManager));
        timestampEnforcer.beforeHook(
            terms_, "", singleDefaultMode, execData_, bytes32(0), address(0), address(0)
        );

        vm.warp(uint256(afterTimestamp_) + 1);
        vm.prank(address(delegationManager));
        vm.expectRevert("TimestampEnforcer:expired-delegation");
        timestampEnforcer.beforeHook(
            terms_, "", singleDefaultMode, execData_, bytes32(0), address(0), address(0)
        );
    }

    function _getEnforcer() internal view override returns (ICaveatEnforcer) {
        return ICaveatEnforcer(address(periodEnforcer));
    }
}
