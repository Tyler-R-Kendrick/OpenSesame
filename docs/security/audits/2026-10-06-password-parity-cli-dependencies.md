# CLI dependency remediation — 2026-10-06

The password-parity dependency review found three additional npm advisories.
The installed graph now uses published fixes for two and removes the only
consumer of the third. No advisory was ignored or suppressed.

| Advisory | Previous dependency | Result |
| --- | --- | --- |
| GHSA-pqg4-j6r4-53mv | shell-quote 1.10.0 | Published shell-quote 1.11.0 |
| GHSA-68fv-2mgg-jv7q | source-map-js 1.2.1 | Published source-map-js 1.2.2 |
| GHSA-hp3w-g68c-fv3c | sprintf-js 1.0.3 | Removed from the resolved lockfile |

Official sources: [shell-quote advisory](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv),
[source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
and [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
The sprintf-js maintainers disputed the proposed exception-handling fix in
[issue 237](https://github.com/alexei/sprintf.js/issues/237); no patched npm
release was available. This remediation does not claim a sprintf-js patch.

The only resolved sprintf-js consumer was argparse 1.0.10, reached through
js-yaml 3.15.2. The scoped override `js-yaml@3.15.2>argparse: 2.0.1` removes
that chain while preserving the js-yaml library API. Both `sprintf-js` and
`argparse@1` are absent from the final `pnpm-lock.yaml`.

Argparse 2 retains the legacy methods used by the js-yaml CLI, but its deprecated
constructor-version compatibility path silently prints nothing for `--version`.
This was reproduced before the patch: the original argparse 1 CLI printed
`3.15.2`, while unchanged js-yaml with argparse 2 exited successfully with empty
output. `patches/js-yaml@3.15.2.patch` changes only the CLI to register an explicit
`-v`/`--version` action. It is a CLI compatibility patch, not a vulnerability
backport. Its SHA-256 is
`6bd57118854e9a442332c471e928b0a218508e5353e8498956ae691097a9a582`.

Verification against the actual installed packages passed five tests:

```sh
node --test scripts/security/js-yaml-argparse-upgrade.test.mjs \
  scripts/security/shell-source-map-upgrade.test.mjs
```

The CLI tests cover help, version, YAML loading, JSON dumping, the legacy `-j`
flag, compact and trace errors, unknown options, and missing files. The
shell-quote test rejects the advisory's comment-escape payload for all four
line terminators and preserves ordinary quoting. The source-map test rejects
the extreme indexed-section offset before SourceNode can iterate over it and
preserves normal indexed-map conversion.

These dependencies belong to development/tooling chains. The tests establish
compatibility and the specific fixed behavior; the aggregate dependency scanner
and repository verification remain separate gates for the complete graph.
