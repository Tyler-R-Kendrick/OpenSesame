#!/usr/bin/env python3
"""Fail closed on absent, skipped, repeated or failing required Apple simulator cases."""
import json
import re
import sys
from pathlib import Path

FRAMEWORK = {
    "coldStartAndSyntheticDenyRealAuthority", "syntheticCannotUpgradeWithoutFreshAdmission",
    "lockingInvalidatesEveryRetainedPermit", "cancelledOwnerPromptCannotReopenLockedWallet",
    "actualKeychainRecordUsesDeviceOnlyProtectionAndCasRejectsStaleMutation",
    "actualRustAndKeychainAdmitSyntheticWithoutOwnerAuthorityOrProviderGrant",
    "coldProvidersAlwaysDenyAndGrantsAreConsumedOnceThenRevoked",
    "concurrentProvidersCannotBothConsumeOneActualKeychainGrant", "expiredAndMalformedGrantsFailClosed",
    "actualKeychainDetectionStateIsDeviceOnlyAndRejectsStalePublication",
    "coldAndSyntheticAppSessionsCannotManageCanariesOrCreateReceiverState",
    "actualRustCanaryIdentificationCannotBecomeApplicationAdmission",
    "exactRootIdentityAndCurrentPasswordGuardAllCanaryState",
}
COLD = "testColdLaunchAndUnavailableOwnerAuthenticationNeverExposeProductionUi"
PASSWORD = "testVisibleOwnerRetiredPasswordLifecycle"
CANARY = "testVisibleFreshOwnerControlledCanaryLifecycle"


def verify(summary, tree, phase):
    expected = {"cold": FRAMEWORK | {COLD}, "password": {PASSWORD}, "canary": {CANARY}}[phase]
    if any(type(summary.get(key)) is not int for key in ["passedTests", "failedTests", "skippedTests"]):
        raise ValueError("Apple result counts must be exact integers")
    if summary.get("passedTests") != len(expected) or summary.get("failedTests") != 0 or summary.get("skippedTests") != 0:
        raise ValueError("Apple result counts do not match the required executed cases")
    found = []

    def visit(value):
        if isinstance(value, dict):
            if value.get("nodeType") == "Test Case":
                identifier = value.get("nodeIdentifier", value.get("name"))
                if not isinstance(identifier, str) or value.get("result") != "Passed":
                    raise ValueError("Apple case is missing its successful identity")
                matches = [name for name in expected if re.search(r"(?:^|[/ .])" + re.escape(name) + r"(?:\(\))?$", identifier)]
                if len(matches) != 1:
                    raise ValueError("Unexpected or ambiguous Apple test identity")
                found.extend(matches)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(tree)
    if len(found) != len(expected) or set(found) != expected:
        raise ValueError("Required Apple test identities are missing or duplicated")
    return sorted(found)


if __name__ == "__main__":
    passed = verify(json.loads(Path(sys.argv[1]).read_text()), json.loads(Path(sys.argv[2]).read_text()), sys.argv[3])
    print(json.dumps({"phase": sys.argv[3], "passed": len(passed), "failed": 0, "skipped": 0, "cases": passed}))
