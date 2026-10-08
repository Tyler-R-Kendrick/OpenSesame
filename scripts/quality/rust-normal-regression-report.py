"""Require the six actual normal libtest regression results; not fuzz admission."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

REQUIRED = (
    'captured_long_equality_filter_keeps_exact_bind_and_neutral_sql',
    'captured_claim_and_fresh_expired_claimed_controls_replay_real_verifier',
    'captured_missing_sensitive_value_and_present_value_stay_omitted',
    'captured_grant_replays_the_actual_attenuation_helper',
    'unrestricted_audience_narrows_but_restricted_parent_cannot_be_widened',
    'metadata_clamps_characters_without_like_escaping',
)


def report(log, exit_file, output):
    raw = log.read_bytes()
    text = raw.decode('utf-8', errors='strict').replace('\r\n', '\n')
    lines = [line for line in text.splitlines() if line.startswith('test ')]
    cases = []
    unsupported = []
    summaries = []
    for line in lines:
        if line.startswith('test result: '):
            summaries.append(line)
            continue
        parsed = re.fullmatch(r'test (\S+) \.\.\. (ok|FAILED|ignored(?: .*)?)', line)
        if parsed is None:
            unsupported.append(line)
        else:
            cases.append(parsed.groups())
    normal = re.compile(r'test result: ok\. 6 passed; 0 failed; 0 ignored; '
                        r'0 measured; 0 filtered out; finished in [0-9.]+s')
    status_text = exit_file.read_text().strip()
    accepted = (status_text == '0' and not unsupported and len(summaries) == 1
                and normal.fullmatch(summaries[0]) is not None
                and Counter(name for name, _ in cases) == Counter(REQUIRED)
                and all(status == 'ok' for _, status in cases))
    result = {'schema': 1, 'scope': 'stable deterministic regression tests',
              'accepted': accepted, 'required': list(REQUIRED), 'actual': cases,
              'summaries': summaries, 'unsupportedCaseLines': unsupported,
              'cargoExit': status_text, 'logSha256': hashlib.sha256(raw).hexdigest()}
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    if not accepted:
        raise SystemExit('normal Rust regressions did not prove all six exact cases')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('log', type=Path)
    parser.add_argument('exit_file', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    report(args.log, args.exit_file, args.output)
