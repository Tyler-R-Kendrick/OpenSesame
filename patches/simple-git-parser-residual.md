# Local defense for Git executable option abbreviations

OSV marks `simple-git@4.0.1` fixed for GHSA-858h-whjf-mvg5. Actual
installed `@simple-git/argv-parser@2.0.1` still accepts `push --receive-p`
and `push --exe`; its literal guards do not recognize Git's long-option
prefixes. The advisory-linked upstream commit
`98864c678444d9336357c844efa4fd5a7984c0d7` repairs configuration includes,
but does not change those pack-option guards. This patch is a locally
source-validated residual fix, **not an official upstream backport**.

The parser's vulnerability generator now checks strict nonempty prefixes
before its existing guards. Checks apply where Git accepts these executable
options: `push` (`--receive-pack`, `--exec`), and `clone`, `fetch`, `pull`,
`ls-remote` (`--upload-pack`). Ordinary `diff --unified`, `status --untracked`,
and `push --repo` remain allowed. Parsed operands after `--` remain operands.
Full option names retain their existing guards and explicit `allowUnsafePack`
opt-in behavior. Both distributed CJS and ESM runtime entries are patched.

Exact patch SHA-256:
`1abefd30fc0cc2a8ae348f7d7e084640178fa82adffba4418e93cdb267dbca55`.

| Entry | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/index.cjs` | `8e313da26ac724c90f1b7f89020c5637462b1b452f41118b07c9916d95729926` | `78b248e413867f36c1c467dfc569166de9cc4fe3add22b0b06448389c2ace1ed` |
| `dist/index.mjs` | `963a4c217f8cbcf1727c4e380d4f495a82e6761d31b4f4e9d88720e5df89defe` | `38581b163815d6d9b3751195db621d876b866abba3ea4baff4a87247daf634b7` |

`node --test scripts/security/simple-git-upgrade.test.mjs` exercises all
prefixes with inline and separate values in both runtime bundles, default
simple-git rejection, include/conditional-include/trailer guards, VISUAL,
and ordinary local Git init/status/config. It resolves the actual installed
tests/redteam → promptfoo → simple-git → parser consumer graph. No attacker command is run
and Git operations use disposable directories without remotes. Before this
patch, three of five tests fail; VISUAL and ordinary Git behavior pass.

After the locked patch installation, all five tests pass. Both actual consumer
runtime entry files match the patched SHA-256 values above. The full repository
`quality:test` command runs `scripts/security/*.test.mjs` with Node's test runner.
No scanner finding is ignored or treated as remediated through a version-only
exception for this residual fix.
