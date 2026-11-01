# Local sign-off

GitHub Actions CI on `OpenSesame-Labs/OpenSesame` is the authoritative merge
gate. The ruleset requires the Actions checks TypeScript, Bundle budgets, and
Rust. A local status does not replace those checks.

Agents may run an optional preflight with
[basecamp/gh-signoff](https://github.com/basecamp/gh-signoff) before asking for
review:

```bash
gh extension install basecamp/gh-signoff
# Run the focused checks you changed, then:
gh signoff
```

`gh signoff` posts a commit status named `signoff` for the current HEAD. It
does not run the test suite and it does not satisfy the ruleset. Use it as a
local attestation that the agent already ran the relevant commands on a
machine. Leave `gh signoff install` unused: that command would add another
required status, and this repository does not use sign-off as a merge rule.

The pre-push hook remains the local static gate (`pnpm setup:hooks`). Full
verification is `OPENSESAME_PREPUSH=full` or `pnpm verify`. After the pull
request is open, wait for the GitHub CI checks named above.
