#!/usr/bin/env python3
"""Report scoped actual tool output; never infer execution from minimum test counts."""
import argparse
import json
from pathlib import Path
import re


def configuration(path):
    value = json.loads(Path(path).read_text())
    if value.get("v") != 1 or set(value) != {"v", "description", "core", "adapters"}:
        raise ValueError("Unsupported credential depth configuration")
    for group in ("core", "adapters"):
        scope = value[group]
        if set(scope) != {"packages", "files"} or not scope["files"] or not scope["packages"]:
            raise ValueError("Empty or malformed scope")
        if len(scope["files"]) != len(set(scope["files"])):
            raise ValueError("Duplicate scope file")
        for file in scope["files"]:
            if not isinstance(file, str) or not file.startswith("crates/") or ".." in Path(file).parts:
                raise ValueError("Unconfined scope file")
    return value


def counter(value):
    if not isinstance(value, dict):
        raise ValueError("Missing LLVM counter")
    count, covered = value.get("count"), value.get("covered")
    if type(count) is not int or type(covered) is not int or not 0 <= covered <= count:
        raise ValueError("Invalid LLVM counter")
    return {"count": count, "covered": covered, "percent": 100 * covered / count if count else None}


def coverage(document, expected, root):
    root = Path(root).resolve()
    rows = {}
    for datum in document["data"]:
        for file in datum["files"]:
            absolute = Path(file["filename"])
            absolute = (root / absolute).resolve() if not absolute.is_absolute() else absolute.resolve()
            try:
                name = absolute.relative_to(root).as_posix()
            except ValueError:
                continue
            if name not in expected:
                continue
            if name in rows:
                raise ValueError("Duplicate LLVM feature file")
            summary = file["summary"]
            rows[name] = {field: counter(summary[field]) for field in ("lines", "functions", "branches")}
            if rows[name]["lines"]["count"] == 0 or rows[name]["functions"]["count"] == 0:
                raise ValueError("Selected feature file has no instrumented functions/lines")
            if rows[name]["lines"]["covered"] == 0 or rows[name]["functions"]["covered"] == 0:
                raise ValueError("Selected feature file has no executed functions/lines")
    if set(rows) != set(expected):
        raise ValueError("LLVM report is missing selected feature files")
    return {"v": 1, "kind": "per_file_llvm_counters", "files": [{"path": name, **rows[name]} for name in sorted(rows)],
            "limits": "Actual counters, not an aggregate-floor replacement or proof of Windows/OS behavior. Null branch percentage means no recorded branch counters."}


def mutation_list(text, files):
    listed = [line for line in text.splitlines() if line.strip()]
    if not listed:
        raise ValueError("Empty mutation selection")
    for file in files:
        if not any(re.match(r"^" + re.escape(file) + r":\d+:\d+:", line) for line in listed):
            raise ValueError("Selected feature file has no listed mutants: " + file)
    if any(not any(line.startswith(file + ":") for file in files) for line in listed):
        raise ValueError("Mutation list includes an unexpected file or unsupported diagnostic")
    return {"v": 1, "kind": "mutation_selection", "listedMutants": len(listed), "files": files}


def mutation_run(text):
    summaries = [line for line in text.splitlines() if "mutants tested" in line]
    if len(summaries) != 1:
        raise ValueError("Missing or ambiguous real cargo-mutants completion summary")
    counts = {}
    for label in ("caught", "missed", "timeout", "unviable"):
        found = re.findall(r"\b(\d+) " + label + r"s?\b", summaries[0])
        if len(found) > 1:
            raise ValueError("Ambiguous mutant outcome count")
        counts[label] = int(found[0]) if found else 0
    total = re.search(r"\b(\d+) mutants tested\b", summaries[0])
    if total is None or int(total[1]) != sum(counts.values()):
        raise ValueError("Inconsistent real mutant outcome total")
    if counts["caught"] == 0 or counts["missed"] or counts["timeout"]:
        raise ValueError("Vacuous or unsuccessful mutation campaign")
    return {"v": 1, "kind": "cargo_mutants_summary", **counts,
            "limits": "Unviable mutants are reported, not counted as caught. Raw per-mutant tool reports are retained."}


def fuzz_run(text):
    summaries = re.findall(r"^Done (\d+) runs in (\d+) second\(s\)\s*$", text, re.M)
    if len(summaries) != 1 or int(summaries[0][0]) <= 0:
        raise ValueError("No genuine completed libFuzzer iterations")
    return {"v": 1, "kind": "libfuzzer_summary", "runs": int(summaries[0][0]), "seconds": int(summaries[0][1])}


CONTROL_CASES = [
    "credential_oracles_accept_structured_and_hostile_seed_inputs",
    "bounded_transition_seed_reaches_ack_disable_replace_expiry_and_owner_witness",
    "genuine_golden_ack_rejects_tampering_other_package_and_expiry",
    "genuine_queued_ack_cannot_revalidate_replaced_or_disabled_binding",
]


def rust_controls(text):
    text = text.replace("\r\n", "\n")
    cases = re.findall(r"^test ([\w:]+) \.\.\. (ok|FAILED|ignored)(?:[ \t].*)?$", text, re.M)
    if sorted(name for name, _ in cases) != sorted(CONTROL_CASES) or any(status != "ok" for _, status in cases):
        raise ValueError("Missing, duplicate, unexpected, failed or ignored oracle control")
    summaries = re.findall(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;", text)
    if summaries != [("ok", str(len(CONTROL_CASES)), "0", "0")]:
        raise ValueError("Inconsistent oracle control summary")
    return {"v": 1, "kind": "executed_oracle_controls", "passed": len(cases), "failed": 0, "ignored": 0, "cases": CONTROL_CASES}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("coverage", "mutation-list", "mutation-run", "fuzz-run", "rust-controls"))
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--config", default="tools/mutation/credential-rust-depth.json")
    parser.add_argument("--group", choices=("core", "adapters"), default="core")
    args = parser.parse_args()
    scope = configuration(args.config)
    if Path(args.source).stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Oversized tool report")
    raw = Path(args.source).read_text()
    if args.operation == "coverage":
        files = scope["core"]["files"] + scope["adapters"]["files"]
        result = coverage(json.loads(raw), files, Path.cwd())
    elif args.operation == "mutation-list":
        result = mutation_list(raw, scope[args.group]["files"])
    elif args.operation == "mutation-run":
        result = mutation_run(raw)
    elif args.operation == "rust-controls":
        result = rust_controls(raw)
    else:
        result = fuzz_run(raw)
    Path(args.destination).write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
