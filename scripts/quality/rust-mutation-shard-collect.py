#!/usr/bin/env python3
"""Full disjoint native union; incomplete/failed artifacts are never green."""
import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("native_shard", Path(__file__).with_name("rust-mutation-shard.py"))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def ordinary(root, relative):
    path = root / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Missing/foreign/nonregular artifact input: " + relative)
    return path


def required_steps(root, platform):
    values = {}
    for line in ordinary(root, "steps.txt").read_text().splitlines():
        key, value = line.split("=", 1)
        if key in values:
            raise ValueError("Duplicate prerequisite state")
        values[key] = value
    required = {"checkout", "source", "python", "rust", "tools", "execute", "freshness"}
    if not required <= set(values) or any(value != "success" for value in values.values()):
        raise ValueError("Missing/skipped/failed prerequisite or actual execution")
    python = json.loads(ordinary(root, "python.json").read_text())
    version = python.get("version")
    expected_os = "nt" if platform == "windows" else "posix"
    if (python.get("os") != expected_os or not isinstance(python.get("executable"), str)
            or not python["executable"] or not isinstance(version, list) or len(version) != 3
            or any(type(part) is not int or part < 0 for part in version) or tuple(version) < (3, 11, 0)):
        raise ValueError("Missing/unsupported/non-native actual Python prerequisite")
    changed = json.loads(ordinary(root, "inputs.changed-paths.json").read_text())
    if changed != []:
        raise ValueError("Job source freshness failed")


def group_union(roots, group, platform):
    seen, assigned_union, first, compiler, results = set(), {}, None, None, []
    for root in roots:
        required_steps(root, platform)
        report_root = root / "mutation-shard"
        receipt = json.loads(ordinary(report_root, "shard-receipt.json").read_text())
        if receipt["v"] != 1 or receipt["group"] != group or receipt["platform"] != platform or receipt["status"] != "success" or receipt["shards"] != 8:
            raise ValueError("Unexpected/failed native shard receipt")
        if ordinary(root, "source.txt").read_text().splitlines() != receipt["source"]:
            raise ValueError("Job source capture differs from native receipt")
        if gate.platform_gate.sha(ordinary(root, "inputs.before.json")) != receipt["wholeSourceBeforeSHA256"]:
            raise ValueError("Whole source opening capture SHA mismatch")
        index = receipt["shard"]
        if type(index) is not int or index not in range(8) or index in seen:
            raise ValueError("Unknown or duplicate shard index")
        seen.add(index)
        identity = {key: receipt[key] for key in ("source", "sourcePins", "canonicalCommand", "fullInventorySHA256", "activeInventorySHA256", "full", "applicability", "active")}
        if first is None:
            first, compiler = identity, receipt["compiler"]
        elif identity != first or receipt["compiler"] != compiler:
            raise ValueError("Mixed source/inventory/compiler context")
        if gate.digest(receipt["full"]) != receipt["fullInventorySHA256"] or gate.digest(receipt["active"]) != receipt["activeInventorySHA256"]:
            raise ValueError("Inventory SHA mismatch")
        expected = gate.fixed_partition(receipt["active"], index)
        gate.platform_gate.inventory_equal(receipt["assigned"], expected)
        actual_list = json.loads(ordinary(report_root, "assigned.json").read_text())
        gate.platform_gate.inventory_equal(actual_list, expected)
        raw = ordinary(report_root, "mutants/mutants.out/outcomes.json")
        if gate.platform_gate.sha(raw) != receipt["outcomesSHA256"]:
            raise ValueError("Raw native outcome SHA mismatch")
        actual = gate.platform_gate.outcomes_analyze(json.loads(raw.read_text()), [{"mutant": value} for value in expected])
        if actual != receipt["admission"] or not actual["admitted"]:
            raise ValueError("Actual native outcome admission failed")
        if ordinary(report_root, "campaign.log.exit").read_text().strip() != "0":
            raise ValueError("Real tool process failed")
        for value in expected:
            if value["name"] in assigned_union:
                raise ValueError("Overlapping shard IDs")
            assigned_union[value["name"]] = value
        results.append({"shard": index, "receiptSHA256": gate.platform_gate.sha(report_root / "shard-receipt.json"), "totals": actual["totals"]})
    if seen != set(range(8)) or assigned_union != {value["name"]: value for value in first["active"]}:
        raise ValueError("Missing shard or incomplete original active inventory")
    return {"group": group, "platform": platform, "identity": first, "compiler": compiler, "shards": sorted(results, key=lambda item: item["shard"]), "status": "success"}


def platform_union(groups):
    if {group["platform"] for group in groups} != {"linux", "windows", "macos"}:
        raise ValueError("Missing required native platform")
    original = groups[0]["identity"]["full"]
    source = groups[0]["identity"]["source"]
    pins = groups[0]["identity"]["sourcePins"]
    rows = {}
    for group in groups:
        identity = group["identity"]
        if identity["full"] != original or identity["source"] != source or identity["sourcePins"] != pins:
            raise ValueError("Cross-platform original/source inventory mismatch")
        for row in identity["applicability"]:
            name = row["mutant"]["name"]
            rows.setdefault(name, []).append((group["platform"], row["condition"], row["active"]))
    if set(rows) != {value["name"] for value in original}:
        raise ValueError("Incomplete cross-platform cfg ledger")
    outside = []
    for name, entries in rows.items():
        if len(entries) != 3 or len({condition for _, condition, _ in entries}) != 1:
            raise ValueError("Ambiguous cross-platform cfg condition")
        condition = entries[0][1]
        expected = {"always": {"linux", "windows", "macos"}, "supported": {"linux", "windows", "macos"}, "unix": {"linux", "macos"}, "windows": {"windows"}, "unsupported": set()}.get(condition)
        if expected is None or {platform for platform, _, active in entries if active} != expected:
            raise ValueError("Unknown or incomplete native applicability")
        if not expected:
            outside.append(name)
    return {"originalGeneratedIDs": len(original), "unsupportedOnlyIDs": outside,
            "qualification": "Unsupported-only IDs are outside supported runtime claims, never caught/green. Historical original MISSED preserved. All native-applicable IDs and active equivalents required."}


def collect(root, mode, requested_result, expected_source):
    root = Path(root).resolve()
    expected = {}
    if mode == "canonical":
        for index in range(8):
            expected[f"test-depth-mutation-rust-{index}of8"] = ("canonical", "linux")
    else:
        for group, platform in [("core", "linux"), ("adapters", "linux"), ("adapters", "windows"), ("adapters", "macos")]:
            for index in range(8):
                label = f"mutation-core-{index}of8" if group == "core" else f"mutation-adapters-{platform}-{index}of8"
                expected["credential-rust-" + label] = (group, platform)
    actual = {entry.name for entry in root.iterdir()}
    if actual != set(expected):
        raise ValueError("Missing or unexpected requested shard artifact")
    grouped = {}
    for label, identity in expected.items():
        grouped.setdefault(identity, []).append(root / label)
    groups = [group_union(paths, *identity) for identity, paths in grouped.items()]
    if any(group["identity"]["source"] != expected_source for group in groups):
        raise ValueError("Artifact source differs from authenticated current collector source")
    result = {"status": "success", "mode": mode, "source": expected_source, "groups": groups}
    if mode == "credential":
        result["supportedPlatformUnion"] = platform_union([group for group in groups if group["group"] == "adapters"])
        if len({tuple(group["identity"]["source"]) for group in groups}) != 1:
            raise ValueError("Core and adapter source identities differ")
    if requested_result != "success":
        raise ValueError("Actual matrix/upload/setup/freshness result not successful")
    return result


def failure_inventory(root):
    rows = []
    if not Path(root).is_dir():
        return rows
    for directory in sorted(Path(root).iterdir()):
        row = {"artifact": directory.name, "available": False}
        try:
            receipt = json.loads(ordinary(directory / "mutation-shard", "shard-receipt.json").read_text())
            row.update({"available": True, "group": receipt.get("group"), "platform": receipt.get("platform"),
                        "shard": receipt.get("shard"), "actualStatus": receipt.get("status"),
                        "reportedAdmission": receipt.get("admission")})
            raw = ordinary(directory / "mutation-shard", "mutants/mutants.out/outcomes.json")
            document = json.loads(raw.read_text())
            row["rawReportSHA256"] = gate.platform_gate.sha(raw)
            row["actualToolSummary"] = {key: document.get(key) for key in ["total_mutants", "caught", "missed", "timeout", "unviable"]}
        except Exception as error:
            row["unavailableReason"] = str(error)
        rows.append(row)
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("credential", "canonical"))
    parser.add_argument("root")
    parser.add_argument("matrix_result")
    parser.add_argument("output")
    args = parser.parse_args()
    try:
        expected_source = subprocess.check_output(["git", "rev-parse", "HEAD", "HEAD^{tree}"], text=True).splitlines()
        if len(expected_source) != 2 or expected_source[0] != os.environ.get("GITHUB_SHA"):
            raise ValueError("Collector source differs from authenticated workflow SHA")
        result = collect(args.root, args.mode, args.matrix_result, expected_source)
    except Exception as error:
        gate.platform_gate.save(args.output, {"status": "failure", "mode": args.mode, "matrixResult": args.matrix_result, "error": str(error), "actualAvailableShardMetrics": failure_inventory(args.root)})
        raise
    gate.platform_gate.save(args.output, result)
