// SPDX-License-Identifier: MIT AND Apache-2.0
pragma solidity 0.8.23;

/**
 * OpenSesame WAL-E04 — mixed-asset period caveats keyed only by delegationHash
 * share PeriodicAllowance state. Composition must be refused at activation;
 * this harness proves the enforcer does not isolate assets by token address.
 */

import { CaveatEnforcerBaseTest } from "../enforcers/CaveatEnforcerBaseTest.t.sol";
import { ERC20PeriodTransferEnforcer } from "../../src/enforcers/ERC20PeriodTransferEnforcer.sol";
import { BasicERC20, IERC20 } from "../utils/BasicERC20.t.sol";
import { ICaveatEnforcer } from "../../src/interfaces/ICaveatEnforcer.sol";

contract WalE04MixedAssetCaveatTest is CaveatEnforcerBaseTest {
    ERC20PeriodTransferEnforcer public periodEnforcer;
    BasicERC20 public tokenA;
    BasicERC20 public tokenB;

    address public alice;
    address public bob;
    uint256 public constant PERIOD_AMOUNT = 1000;
    uint256 public constant PERIOD_DURATION = 1 days;
    uint256 public startDate;

    function setUp() public override {
        super.setUp();
        periodEnforcer = new ERC20PeriodTransferEnforcer();
        alice = address(users.alice.deleGator);
        bob = address(users.bob.deleGator);
        tokenA = new BasicERC20(alice, "AAA", "AAA", 100 ether);
        tokenB = new BasicERC20(alice, "BBB", "BBB", 100 ether);
        startDate = block.timestamp;
    }

    /// @notice Same delegationHash + different token terms share one period counter.
    function test_wal_e04_mixedAssetSharesDelegationKeyedCounter() public {
        bytes32 hash_ = keccak256("wal-e04-shared");
        bytes memory termsA_ =
            abi.encodePacked(address(tokenA), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        bytes memory termsB_ =
            abi.encodePacked(address(tokenB), PERIOD_AMOUNT, PERIOD_DURATION, startDate);

        bytes memory execA_ =
            abi.encodePacked(address(tokenA), uint256(0), _transfer(bob, 700));
        bytes memory execB_ =
            abi.encodePacked(address(tokenB), uint256(0), _transfer(bob, 700));

        vm.prank(address(delegationManager));
        periodEnforcer.beforeHook(termsA_, "", singleDefaultMode, execA_, hash_, address(0), bob);

        // 700 already consumed under hash_; token B terms still see that counter.
        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
        periodEnforcer.beforeHook(termsB_, "", singleDefaultMode, execB_, hash_, address(0), bob);
    }

    /// @notice Duplicate period caveats on one hash are not independent allowances.
    function test_wal_e04_duplicatePeriodCaveatNotIndependent() public {
        bytes32 hash_ = keccak256("wal-e04-dup");
        bytes memory terms_ =
            abi.encodePacked(address(tokenA), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        bytes memory exec1_ =
            abi.encodePacked(address(tokenA), uint256(0), _transfer(bob, 600));
        bytes memory exec2_ =
            abi.encodePacked(address(tokenA), uint256(0), _transfer(bob, 600));

        vm.prank(address(delegationManager));
        periodEnforcer.beforeHook(terms_, "", singleDefaultMode, exec1_, hash_, address(0), bob);

        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
        periodEnforcer.beforeHook(terms_, "", singleDefaultMode, exec2_, hash_, address(0), bob);
    }

    function _transfer(address to_, uint256 amount_) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IERC20.transfer.selector, to_, amount_);
    }

    function _getEnforcer() internal view override returns (ICaveatEnforcer) {
        return ICaveatEnforcer(address(periodEnforcer));
    }
}
