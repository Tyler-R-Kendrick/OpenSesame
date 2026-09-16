// SPDX-License-Identifier: MIT AND Apache-2.0
pragma solidity 0.8.23;

/**
 * OpenSesame WAL-E01 / WAL-E02 - shared ancestor period cap under real
 * MetaMask delegation-framework contracts (pin bff4b08).
 *
 * Two sibling leaves redeem through one parent delegation that carries
 * ERC20PeriodTransferEnforcer. The parent's delegationHash keys the shared
 * counter; UI/broker code is not in the path.
 */

import { Caveat, Delegation, Execution } from "../../src/utils/Types.sol";
import { CaveatEnforcerBaseTest } from "../enforcers/CaveatEnforcerBaseTest.t.sol";
import { ERC20PeriodTransferEnforcer } from "../../src/enforcers/ERC20PeriodTransferEnforcer.sol";
import { BasicERC20, IERC20 } from "../utils/BasicERC20.t.sol";
import { ICaveatEnforcer } from "../../src/interfaces/ICaveatEnforcer.sol";
import { EncoderLib } from "../../src/libraries/EncoderLib.sol";

contract SiblingSharedPeriodCapTest is CaveatEnforcerBaseTest {
    ERC20PeriodTransferEnforcer public periodEnforcer;
    BasicERC20 public token;

    address public alice;
    address public bob;
    address public carol;
    address public dave;

    uint256 public constant PERIOD_AMOUNT = 1000;
    uint256 public constant PERIOD_DURATION = 1 days;
    uint256 public startDate;

    function setUp() public override {
        super.setUp();
        periodEnforcer = new ERC20PeriodTransferEnforcer();
        alice = address(users.alice.deleGator);
        bob = address(users.bob.deleGator);
        carol = address(users.carol.deleGator);
        dave = address(users.dave.deleGator);
        token = new BasicERC20(alice, "TEST", "TEST", 100 ether);
        startDate = block.timestamp;
    }

    /// @notice WAL-E01: direct enforcer path rejects overspend without UI.
    function test_wal_e01_directBypass_overspendRejected() public {
        bytes memory terms_ = abi.encodePacked(address(token), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        Caveat[] memory caveats_ = new Caveat[](1);
        caveats_[0] = Caveat({ args: hex"", enforcer: address(periodEnforcer), terms: terms_ });

        Delegation memory root_ = Delegation({
            delegate: bob,
            delegator: alice,
            authority: ROOT_AUTHORITY,
            caveats: caveats_,
            salt: 0,
            signature: hex""
        });
        root_ = signDelegation(users.alice, root_);
        bytes32 rootHash_ = EncoderLib._getDelegationHash(root_);

        invokeDelegation_UserOp(
            users.bob,
            _one(root_),
            Execution({ target: address(token), value: 0, callData: _transfer(bob, 700) })
        );

        (uint256 available_,,) =
            periodEnforcer.getAvailableAmount(rootHash_, address(delegationManager), terms_);
        assertEq(available_, 300, "shared remainder after first spend");

        bytes memory exec_ = abi.encodePacked(address(token), uint256(0), _transfer(bob, 400));
        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
        periodEnforcer.beforeHook(terms_, "", singleDefaultMode, exec_, rootHash_, address(0), bob);
    }

    /// @notice WAL-E02: sibling leaf redemptions share the parent period counter.
    function test_wal_e02_siblingLeaves_shareParentPeriodCap() public {
        bytes memory terms_ = abi.encodePacked(address(token), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        Caveat[] memory rootCaveats_ = new Caveat[](1);
        rootCaveats_[0] = Caveat({ args: hex"", enforcer: address(periodEnforcer), terms: terms_ });

        Delegation memory aliceToBob_ = Delegation({
            delegate: bob,
            delegator: alice,
            authority: ROOT_AUTHORITY,
            caveats: rootCaveats_,
            salt: 0,
            signature: hex""
        });
        aliceToBob_ = signDelegation(users.alice, aliceToBob_);
        bytes32 aliceToBobHash_ = EncoderLib._getDelegationHash(aliceToBob_);

        Caveat[] memory empty_ = new Caveat[](0);
        Delegation memory bobToCarol_ = Delegation({
            delegate: carol,
            delegator: bob,
            authority: aliceToBobHash_,
            caveats: empty_,
            salt: 0,
            signature: hex""
        });
        bobToCarol_ = signDelegation(users.bob, bobToCarol_);

        Delegation memory bobToDave_ = Delegation({
            delegate: dave,
            delegator: bob,
            authority: aliceToBobHash_,
            caveats: empty_,
            salt: 1,
            signature: hex""
        });
        bobToDave_ = signDelegation(users.bob, bobToDave_);

        Delegation[] memory carolChain_ = new Delegation[](2);
        carolChain_[0] = bobToCarol_;
        carolChain_[1] = aliceToBob_;

        // Carol spends 700 through the full chain (parent caveat runs).
        invokeDelegation_UserOp(
            users.carol,
            carolChain_,
            Execution({ target: address(token), value: 0, callData: _transfer(carol, 700) })
        );

        (uint256 availableAfterCarol_,,) =
            periodEnforcer.getAvailableAmount(aliceToBobHash_, address(delegationManager), terms_);
        assertEq(availableAfterCarol_, 300, "parent remainder after Carol");

        // Independent sibling Dave would need another 400 against the SAME parent
        // hash. Direct manager bypass of the UI still hits the shared counter.
        bytes memory daveExec_ = abi.encodePacked(address(token), uint256(0), _transfer(dave, 400));
        vm.prank(address(delegationManager));
        vm.expectRevert("ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
        periodEnforcer.beforeHook(
            terms_, "", singleDefaultMode, daveExec_, aliceToBobHash_, alice, dave
        );

        (uint256 availableAfterDave_,,) =
            periodEnforcer.getAvailableAmount(aliceToBobHash_, address(delegationManager), terms_);
        assertEq(availableAfterDave_, 300, "Dave must not consume shared remainder");
    }

    /// @notice WAL-E03: a substituted root (new salt/hash) keeps an independent counter — not the approved shared authority.
    function test_wal_e02_independentRoots_doNotShareCounter() public {
        bytes memory terms_ = abi.encodePacked(address(token), PERIOD_AMOUNT, PERIOD_DURATION, startDate);
        Caveat[] memory caveats_ = new Caveat[](1);
        caveats_[0] = Caveat({ args: hex"", enforcer: address(periodEnforcer), terms: terms_ });

        Delegation memory d1_ = Delegation({
            delegate: bob,
            delegator: alice,
            authority: ROOT_AUTHORITY,
            caveats: caveats_,
            salt: 0,
            signature: hex""
        });
        d1_ = signDelegation(users.alice, d1_);
        bytes32 h1_ = EncoderLib._getDelegationHash(d1_);

        Delegation memory d2_ = Delegation({
            delegate: dave,
            delegator: alice,
            authority: ROOT_AUTHORITY,
            caveats: caveats_,
            salt: 99,
            signature: hex""
        });
        d2_ = signDelegation(users.alice, d2_);
        bytes32 h2_ = EncoderLib._getDelegationHash(d2_);

        invokeDelegation_UserOp(
            users.bob,
            _one(d1_),
            Execution({ target: address(token), value: 0, callData: _transfer(bob, 700) })
        );
        invokeDelegation_UserOp(
            users.dave,
            _one(d2_),
            Execution({ target: address(token), value: 0, callData: _transfer(dave, 400) })
        );

        (uint256 a1_,,) = periodEnforcer.getAvailableAmount(h1_, address(delegationManager), terms_);
        (uint256 a2_,,) = periodEnforcer.getAvailableAmount(h2_, address(delegationManager), terms_);
        assertEq(a1_, 300, "root1 independent");
        assertEq(a2_, 600, "root2 independent - matching terms alone do not share");
    }

    function _transfer(address _to, uint256 _amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IERC20.transfer.selector, _to, _amount);
    }

    function _one(Delegation memory _delegation) internal pure returns (Delegation[] memory) {
        Delegation[] memory arr = new Delegation[](1);
        arr[0] = _delegation;
        return arr;
    }

    function _getEnforcer() internal view override returns (ICaveatEnforcer) {
        return ICaveatEnforcer(address(periodEnforcer));
    }
}
