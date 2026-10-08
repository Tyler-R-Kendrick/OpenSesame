#!/usr/bin/env python3
"""Exact supported-platform admission; no equivalence/ignore/timeout overrides."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PLATFORMS = {"linux": "linux", "windows": "windows", "macos": "macos"}
CONDITIONS = {"always", "unix", "windows", "supported", "unsupported", "test"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def command(args, output, *, combined=False):
    output = Path(output)
    with output.open("wb") as stream, output.with_suffix(output.suffix + ".stderr").open("wb") as errors:
        completed = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT if combined else errors, check=False)
    output.with_suffix(output.suffix + ".exit").write_text(str(completed.returncode) + "\n")
    if completed.returncode != 0:
        raise ValueError("Real command failed; retained output: " + str(output))
    return output.read_text(encoding="utf-8")


def pins_match(root, configuration):
    for file, digest in configuration["lineagePins"].items():
        if sha(root / file) != digest:
            raise ValueError("Reviewed module/config lineage changed: " + file)
    if (root / ".cargo/mutants.toml").exists():
        raise ValueError("Unreviewed default mutant configuration")
    for file in (".cargo/config", ".cargo/config.toml"):
        if (root / file).exists():
            raise ValueError("Unreviewed Cargo cfg injection: " + file)
    variants = {}
    for file, alternatives in configuration["files"].items():
        matches = [entry for entry in alternatives if entry["sourceSHA256"] == sha(root / file)]
        if len(matches) != 1:
            raise ValueError("Unknown/ambiguous source revision: " + file)
        variants[file] = matches[0]
    return variants


def require_default_package_features(package, bits):
    expected = {
        "opensesame-authenticator-core": {'feature="default"'},
        "opensesame-sealed-store": set(),
    }
    actual = {line for line in bits if line.startswith('feature="')}
    if package not in expected or actual != expected[package]:
        raise ValueError("Unexpected selected-package feature activation")


def compiler_context(root, evidence, platform):
    if platform not in PLATFORMS:
        raise ValueError("Unknown native platform")
    for key in os.environ:
        if key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET"} or (key.startswith("CARGO_TARGET_") and key.endswith("_RUSTFLAGS")):
            if os.environ[key]:
                raise ValueError("Unreviewed compiler authority: " + key)
    version = command(["rustc", "+1.88.0", "-vV"], evidence / "rustc.txt")
    if not version.startswith("rustc 1.88.0 "):
        raise ValueError("Unexpected compiler")
    host = re.findall(r"^host: (\S+)$", version, re.M)
    if len(host) != 1:
        raise ValueError("Missing native compiler host")
    tool = command(["cargo", "+1.88.0", "mutants", "--version"], evidence / "mutants-version.txt")
    if tool.strip() != "cargo-mutants 27.1.0":
        raise ValueError("Unexpected mutation tool")
    contexts = {}
    for package in ("opensesame-authenticator-core", "opensesame-sealed-store"):
        # Cargo supplies the actual package/target/default-feature invocation to rustc.
        raw = command(["cargo", "+1.88.0", "rustc", "--locked", "-p", package, "--lib", "--", "--print", "cfg"], evidence / (package + ".cfg"))
        bits = set(raw.splitlines())
        if 'target_os="' + PLATFORMS[platform] + '"' not in bits:
            raise ValueError("Requested platform is not the native compiler target")
        # Cargo enables the named default feature even when its feature list is empty.
        # The reviewed Cargo.toml hashes bind these exact default feature sets.
        require_default_package_features(package, bits)
        expected = "windows" if platform == "windows" else "unix"
        forbidden = "unix" if expected == "windows" else "windows"
        if expected not in bits or forbidden in bits:
            raise ValueError("Unknown platform cfg combination")
        contexts[package] = sorted(bits)
    save(evidence / "compiler-context.json", {"host": host[0], "platform": platform, "packages": contexts})
    return contexts


def classify(entries, variants, contexts):
    if not isinstance(entries, list) or not entries:
        raise ValueError("Empty or malformed full generated inventory")
    result, names, represented = [], set(), set()
    for mutant in entries:
        if not isinstance(mutant, dict) or not isinstance(mutant.get("name"), str):
            raise ValueError("Malformed mutant")
        name, file, package = mutant["name"], mutant.get("file"), mutant.get("package")
        if name in names or file not in variants or package not in contexts:
            raise ValueError("Duplicate or out-of-scope mutant")
        if variants[file]["package"] != package:
            raise ValueError("Wrong source package")
        start, end = mutant["span"]["start"], mutant["span"]["end"]
        if any(type(point[key]) is not int or point[key] <= 0 for point in (start, end) for key in ("line", "column")):
            raise ValueError("Invalid mutant source span")
        if (start["line"], start["column"]) > (end["line"], end["column"]):
            raise ValueError("Reversed mutant span")
        matches = [region for region in variants[file]["regions"] if region["first"] <= start["line"] <= end["line"] <= region["last"]]
        if len(matches) != 1 or matches[0]["condition"] not in CONDITIONS:
            raise ValueError("Unknown or crossing cfg applicability: " + name)
        condition = matches[0]["condition"]
        if condition == "test":
            raise ValueError("Tool unexpectedly listed test-only code")
        bits = contexts[package]
        active = {"always": True, "unix": "unix" in bits, "windows": "windows" in bits,
                  "supported": "unix" in bits or "windows" in bits,
                  "unsupported": "unix" not in bits and "windows" not in bits}[condition]
        result.append({"mutant": mutant, "condition": condition, "active": active})
        represented.add(file)
        names.add(name)
    if represented != set(variants) or not any(row["active"] for row in result):
        raise ValueError("Missing scope file or vacuous active inventory")
    return result


def exact_regex(name):
    return "^" + re.sub(r"([.\^$*+?()\[\]{}\\|])", r"\\\1", name) + "$"


def write_selector(path, active):
    if not active:
        raise ValueError("Empty selector would activate everything")
    lines = ["# Generated from exact reviewed native cfg inventory. No excludes or timeout changes.", "examine_re = ["]
    lines.extend("  " + json.dumps(exact_regex(row["mutant"]["name"])) + "," for row in active)
    Path(path).write_text("\n".join(lines + ["]", ""]), encoding="utf-8")


def inventory_equal(actual, expected):
    def indexed(rows):
        if not isinstance(rows, list):
            raise ValueError("Malformed selected inventory")
        answer = {row["name"]: row for row in rows}
        if len(answer) != len(rows):
            raise ValueError("Duplicate selected inventory")
        return answer
    if indexed(actual) != indexed(expected):
        raise ValueError("Filtered tool inventory differs from exact active selection")


def outcomes_analyze(document, active):
    expected = {row["mutant"]["name"]: row["mutant"] for row in active}
    actual, baselines, totals = {}, [], {}
    for outcome in document["outcomes"]:
        scenario = outcome["scenario"]
        if scenario == "Baseline":
            baselines.append(outcome)
            continue
        mutant = scenario["Mutant"]
        name = mutant["name"]
        if name in actual or name not in expected:
            raise ValueError("Missing/duplicate/unselected tool outcome")
        # Outcomes omit diff, unlike --list JSON. Every other exact native field must agree.
        if mutant != {key: value for key, value in expected[name].items() if key != "diff"}:
            raise ValueError("Tool outcome provenance differs from listed mutant")
        actual[name] = outcome
        summary = outcome["summary"]
        totals[summary] = totals.get(summary, 0) + 1
    if len(baselines) != 1 or baselines[0]["summary"] != "Success" or set(actual) != set(expected):
        raise ValueError("No genuine successful baseline or incomplete campaign")
    phases = baselines[0]["phase_results"]
    if [phase["phase"] for phase in phases] != ["Build", "Test"] or any(phase["process_status"] != "Success" for phase in phases):
        raise ValueError("Baseline compilation/tests did not genuinely succeed")
    if document.get("cargo_mutants_version") != "27.1.0":
        raise ValueError("Unexpected outcome tool version")
    admitted = bool(totals.get("CaughtMutant")) and not (set(totals) - {"CaughtMutant", "Unviable"})
    return {"totals": totals, "admitted": admitted, "qualification": "Applicable equivalents remain in selection and block success when missed; unviable counts are never caught."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("platform", choices=tuple(PLATFORMS))
    parser.add_argument("evidence")
    parser.add_argument("--inventory", default="tools/mutation/credential-adapter-applicability.json")
    args = parser.parse_args()
    root, evidence = Path.cwd(), Path(args.evidence).resolve()
    evidence.mkdir(exist_ok=False)
    configuration = json.loads(Path(args.inventory).read_text())
    if configuration["v"] != 1 or set(configuration["files"]) != set(json.loads(Path("tools/mutation/credential-rust-depth.json").read_text())["adapters"]["files"]):
        raise ValueError("Original adapter scope changed")
    variants = pins_match(root, configuration)
    save(evidence / "source-variants.json", variants)
    contexts = compiler_context(root, evidence, args.platform)
    packages = json.loads(Path("tools/mutation/credential-rust-depth.json").read_text())["adapters"]["packages"]
    base = ["cargo", "+1.88.0", "mutants", "--gitignore", "true"]
    for package in packages:
        base.extend(["-p", package])
    for file in sorted(variants):
        base.extend(["--file", file])
    full = json.loads(command(base + ["--list", "--json"], evidence / "all-generated.json"))
    rows = classify(full, variants, contexts)
    save(evidence / "applicability.json", {"platform": args.platform, "rows": rows,
         "qualification": "Source-pinned cfg regions corroborated by native Cargo/rustc cfg; unsupported-only IDs retained outside supported-platform claims, not caught/skipped-pass. All active equivalents still selected."})
    active = [row for row in rows if row["active"]]
    selector = evidence / "exact-selection.toml"
    write_selector(selector, active)
    selected = json.loads(command(base + ["--config", str(selector), "--list", "--json"], evidence / "selected.json"))
    inventory_equal(selected, [row["mutant"] for row in active])
    failure = None
    try:
        command(base + ["--config", str(selector), "-j", "2", "-o", str(evidence / "mutants")], evidence / "campaign.log", combined=True)
    except Exception as error:
        failure = error
    try:
        result = outcomes_analyze(json.loads((evidence / "mutants/mutants.out/outcomes.json").read_text()), active)
        result.update({"platform": args.platform, "selectorSHA256": sha(selector), "status": "success" if result["admitted"] and failure is None else "failure"})
        save(evidence / "admission.json", result)
        if not result["admitted"]:
            raise ValueError("Applicable survivors/timeouts/errors remain")
    except Exception as error:
        if not (evidence / "admission.json").exists():
            save(evidence / "admission.json", {"platform": args.platform, "status": "failure", "error": str(error)})
        failure = failure or error
    finally:
        if pins_match(root, configuration) != variants:
            raise ValueError("Source cfg inventory changed during campaign")
    if failure:
        raise failure


if __name__ == "__main__":
    main()
