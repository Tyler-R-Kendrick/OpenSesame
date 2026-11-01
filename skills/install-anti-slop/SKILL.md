---
name: install-anti-slop
description: Install and configure the generic and optional Effect anti-slop Oxlint plugins in a local TypeScript or JavaScript repository. Use whenever a user asks to add anti-slop lint rules, copy the anti-slop plugin, configure opinionated Oxlint rules, or migrate an existing local anti-slop setup.
---

# Install anti-slop

Install the bundled Oxlint plugin into the current repository and integrate it with the repository's existing lint setup. Preserve unrelated work and adapt to the project's package manager and configuration style.

## Procedure

1. Inspect the repository before changing it:
   - Read its agent instructions.
   - Check `git status` and preserve unrelated changes.
   - Identify the package manager from `packageManager` and lockfiles.
   - Find Oxlint configuration (`oxlint.config.*`, `.oxlintrc*`, or a Vite+ config).
   - Check whether anti-slop files or rules already exist. Do not overwrite them without reviewing the diff.

2. Copy the bundled plugin from this skill. Run from the target repository:

   ```bash
   node <skill-directory>/scripts/install.mjs
   ```

   This creates `tools/oxlint/anti-slop/`. Pass another relative destination as the first argument when the repository has an established tooling layout. The script refuses to replace an existing destination; only use `--force` after backing up and reviewing existing files.

   Add `--no-tests` when the repository uses the plugin as a lint dependency and does not re-run its RuleTester suites. It leaves out every test-only file (`*.test.*`, `*.spec.*`, and anything under `fixtures`, `__fixtures__`, `__snapshots__` or `__tests__`), prints how many, and prints the matching verify command. The installer takes `--force`, `--no-tests` and at most one destination; anything else exits 2 with a sentence naming it, before any file is written. The copy includes the plugin's MIT `LICENSE`; keep it with the files.

   The copy ships `MANIFEST.sha256` (one `<sha256>  <path>` line per file, readable by `sha256sum -c`) and `verify.mjs`. Check the copy offline, in CI or after an update, with:

   ```bash
   node <destination>/verify.mjs               # default install, tests included
   node <destination>/verify.mjs --no-tests    # an install made with --no-tests
   ```

   It exits 1 with one sentence per missing, modified or extra file and exits 0 otherwise. There is one manifest for both installs: `--no-tests` tells the verifier not to expect the test-only entries, and a test file that is present is then extra. Without the flag, missing test files fail and the output suggests `--no-tests`. The manifest detects drift, not tampering; pin its own digest where the repository pins other inputs. Decision: [ADR 0200](../../docs/adr/0200-anti-slop-asset-ships-a-manifest-and-a-verifier.md).

3. Install current compatible dependencies rather than trusting versions remembered by the agent:
   - Query `npm view oxlint version`, `npm view @oxlint/plugins version`, `npm view @typescript/typescript6 version`, and `npm view @types/node version`.
   - Install the same current version of both packages with the repository's package manager.
   - Install `oxlint`, `@oxlint/plugins`, `@typescript/typescript6`, and `@types/node` as development dependencies. The imported-dictionary analyzer uses the TypeScript 6 compiler API (`@typescript/typescript6`) and Node path resolution; do not assume they are available transitively. TypeScript 7 does not export that API.
   - Do not replace the package manager or rewrite unrelated dependency ranges.

4. Register the generic plugin, configure ignores, and enable all generic rules. For `oxlint.config.ts` or `.oxlintrc.json`, merge these fields with the existing configuration:

   ```ts
   ignorePatterns: [
     ".agent/**",
     ".agents/**",
     ".claude/**",
     ".codex/**",
     ".continue/**",
     ".cursor/**",
     ".gemini/**",
     ".opencode/**",
     ".pi/**",
     ".roo/**",
     ".windsurf/**",
     "tools/oxlint/anti-slop/**",
   ],
   jsPlugins: [
     { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
   ],
   ```

   Keep every existing ignore. Adjust the final pattern when the plugin was copied elsewhere. Inspect the repository for other project-local agent tooling directories and add them rather than linting installed skills, hooks, or generated agent configuration as application source. Do not broadly ignore all dot-directories, because some repositories keep owned source or checks in them.

   For Vite+, add these fields to `lint.ignorePatterns` and `lint.jsPlugins`. Also merge the same patterns into `fmt.ignorePatterns` so `vp check` does not reformat installed agent assets or the vendored plugin. Merge existing entries instead of replacing them.

   Enable these rules at `"error"`:

   ```json
   {
     "anti-slop/no-chained-type-assertions": "error",
     "anti-slop/no-conditional-empty-object-spread": "error",
     "anti-slop/no-known-value-widening": "error",
     "anti-slop/no-module-mocking": "error",
     "anti-slop/no-object-parameters": "error",
     "anti-slop/no-reflect-apply": "error",
     "anti-slop/no-reflect-get": "error",
     "anti-slop/no-runtime-typeof": "error",
     "anti-slop/no-shape-in-symbol-names": "error",
     "anti-slop/no-unknown-parameters": "error",
     "anti-slop/no-unknown-returns": "error",
     "anti-slop/no-unknown-type-aliases": "error",
     "anti-slop/no-unsafe-dictionary-type": "error",
     "anti-slop/no-widen-then-assert": "error",
     "anti-slop/require-safety-comment-for-type-assertion": "error"
   }
   ```

   If the repository declares `effect` in a package manifest, or the user explicitly requests Effect rules, also register the opt-in Effect plugin:

   ```ts
   jsPlugins: [
     {
       name: "anti-slop-effect",
       specifier: "./tools/oxlint/anti-slop/effect/index.ts",
     },
   ],
   rules: {
     "anti-slop-effect/no-service-constructor-imports": "error",
   },
   ```

   Merge these entries with the generic plugin configuration rather than replacing it. Do not enable the Effect plugin merely because Effect appears transitively in a lockfile; require a direct package-manifest dependency or an explicit user request. Relative imports and common `@/`, `~/`, and `#` aliases are covered by default. Configure additional workspace aliases with `projectImportPrefixes`, for example `["@workspace/"]`; do not leave known project aliases outside the rule's scope.

5. Run the repository's lint command and typecheck. For Vite+, run the repository's full `vp check` command after adding both lint and format ignores. If findings appear in owned project source, report them and fix them only when the user asked for migration/cleanup. Do not suppress rules, weaken rule severity, add unsafe casts, or mechanically launder types to make lint pass.

6. Review the final diff and clearly report:
   - copied path,
   - dependency versions installed,
   - configuration changed,
   - checks run and any remaining findings.

## Migration guidance

When replacing an older local copy, compare its rules and diagnostics before overwriting. Keep project-specific rules in their own plugin. The default anti-slop plugin is intentionally generic; framework-specific policy belongs in an explicit opt-in group such as `anti-slop-effect`. Prefer inference, `as const`, `satisfies`, named owner contracts, and boundary parsing when resolving findings.
