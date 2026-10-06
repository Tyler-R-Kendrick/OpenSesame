#!/usr/bin/env python3
"""Verify an actual signed app and embedded provider against operator release inputs."""
import argparse
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from pathlib import Path
import plistlib
import re
import subprocess
import sys
from urllib.parse import urlsplit


def plist_output(command):
    result = subprocess.run(command, check=True, capture_output=True)
    output = result.stdout + result.stderr
    start = output.index(b"<?xml")
    end = output.index(b"</plist>", start) + len(b"</plist>")
    return plistlib.loads(output[start:end])


def signed_entitlements(bundle, args):
    subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(bundle)], check=True)
    entitlements = plist_output(["codesign", "--display", "--entitlements", ":-", str(bundle)])
    if entitlements.get("com.apple.developer.team-identifier") != args.team:
        raise ValueError("Unexpected signing team")
    if entitlements.get("get-task-allow", False):
        raise ValueError("Development debugging entitlement is forbidden for distribution")
    expected_keychain = f"{args.team}.{args.keychain_group}"
    if expected_keychain not in entitlements.get("keychain-access-groups", []):
        raise ValueError("Missing shared production Keychain group")
    if args.app_group not in entitlements.get("com.apple.security.application-groups", []):
        raise ValueError("Missing shared production App Group")
    profile = plist_output(["security", "cms", "-D", "-i", str(bundle / "embedded.mobileprovision")])
    expires = profile["ExpirationDate"].replace(tzinfo=timezone.utc)
    if args.team not in profile.get("TeamIdentifier", []) or expires <= datetime.now(timezone.utc):
        raise ValueError("Provisioning profile is expired or belongs to another team")
    granted = profile.get("Entitlements", {})
    if granted.get("get-task-allow", False):
        raise ValueError("Development provisioning profile is forbidden for distribution")
    for key in ("keychain-access-groups", "com.apple.security.application-groups"):
        if not all(any(fnmatchcase(value, pattern) for pattern in granted.get(key, []))
                   for value in entitlements.get(key, [])):
            raise ValueError(f"Signed {key} is not granted by the provisioning profile")
    return entitlements


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    for option in ("team", "app-group", "keychain-group", "backend", "invocation-host"):
        parser.add_argument(f"--{option}", required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Actual Apple signing validation requires macOS")
    backend = urlsplit(args.backend)
    if (not re.fullmatch(r"[A-Z0-9]{10}", args.team) or backend.scheme != "https"
            or not backend.hostname or backend.hostname.endswith(".invalid")
            or backend.username or backend.password or backend.query or backend.fragment):
        parser.error("Registered production team and HTTPS backend are required")
    providers = list((args.app / "Extensions").glob("*.appex"))
    if len(providers) != 1:
        raise ValueError("Exactly one embedded ExtensionKit document provider is required")
    app_entitlements = signed_entitlements(args.app, args)
    signed_entitlements(providers[0], args)
    for bundle in (args.app, providers[0]):
        info = plistlib.loads((bundle / "Info.plist").read_bytes())
        if info.get("OpenSesameAppGroup") != args.app_group:
            raise ValueError("Runtime App Group differs from signed shared storage")
        if bundle == args.app:
            if info.get("OpenSesameWalletBackendURL") != args.backend:
                raise ValueError("Embedded wallet backend differs from production configuration")
            if info.get("OpenSesameInvocationHost") != args.invocation_host:
                raise ValueError("Embedded invocation host differs from production configuration")
        elif info.get("EXAppExtensionAttributes", {}).get("EXExtensionPointIdentifier") != \
                "com.apple.identity-document-services.document-provider-ui":
            raise ValueError("Unexpected document-provider extension registration")
    if f"applinks:{args.invocation_host}" not in app_entitlements.get("com.apple.developer.associated-domains", []):
        raise ValueError("Production associated domain is not signed into the app")
    print("Signed Apple app/provider, profiles, shared storage and backend configuration verified")


if __name__ == "__main__":
    main()
