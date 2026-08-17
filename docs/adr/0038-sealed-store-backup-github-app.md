# ADR 0038: Sealed-store git backup and GitHub App leases

## Status

Accepted

## Context

ADR 0037 shipped the git-native sealed store, but the tomb was local-only:
`auto_commit` recorded history in the store repository and nothing ever
configured a remote or pushed, so "backup" meant running `git push` by hand
with hand-managed credentials. The Pages half of the bridge was equally
unfinished — Settings exported a plaintext path manifest that no CLI verb
consumed, and re-importing a manifest duplicated every vault item.

On the auth side, the `github-app` provider in the connector-host catalog was
a name with no implementation (`http:github-app` resolved to nothing), and the
connection broker's GitHub OAuth provider was unconfigurable in practice
because its `OPENSESAME_PROVIDER_GITHUB_*` variables appeared nowhere in
`.env.schema`.

## Decision

1. **`opensesame pass backup` is the remote story.** It commits outstanding
   changes, optionally sets `origin` (`--remote`), and pushes. Auto-push after
   every store mutation is opt-in via `opensesame pass backup --auto-push true`,
   recorded as `opensesame.autopush` in the store repo's git config. Push
   failures after a successful local mutation warn rather than fail: a lagging
   backup is recoverable, a blocked insert is not.
2. **Only ciphertext travels.** Backup pushes the store repository as-is:
   `.osseal`/`.gpg`/`.age` files, wrapped key, recipients. Plaintext manifests
   never enter the repository.
3. **GitHub App is the first-class backup credential.** For GitHub HTTPS
   remotes the push credential resolves, most explicit first: `GITHUB_TOKEN` /
   `GH_TOKEN`, a configured GitHub App (`GITHUB_APP_ID` +
   `GITHUB_APP_PRIVATE_KEY_PATH`, RS256 app JWT →
   `POST /app/installations/{id}/access_tokens`), then ambient
   `gh auth token`; otherwise git's own credential helpers. Tokens are passed
   to git through the child environment (`OPENSESAME_GIT_TOKEN`) and an inline
   credential helper — never argv — and are never persisted.
4. **The `github-app` provider plans in connector-host, mints in the CLI.**
   `HumanProviderPlan::GitHubApp` carries the app id, installation id, and
   private-key *path* only. `execute_human_plan` refuses the variant, so agent
   and MCP surfaces that reach connector-host cannot obtain a token; the human
   CLI (`opensesame lease acquire --reveal`) owns signing and the GitHub API
   call.
5. **`opensesame pass seal` completes the ADR 0037 bridge.** It reads the Pages
   manifest (`[{path, secret, trailer}]`), encrypts each entry into the store
   under the existing format-selection rules, records one commit, and with
   `--shred` overwrites and deletes the manifest. Pages-side import merges by
   store path and is idempotent.
6. **GitHub OAuth stays in the connection broker** (ADR 0032) and its
   deployment variables are now declared in `.env.schema`. Broker-held tokens
   still never cross the API boundary; the backup credential chain above is
   deliberately client-side material under the human's control.

## Consequences

- `pass`-style `git push`/`git pull` workflows keep working; `backup` is a
  convenience over them, not a new transport.
- A GitHub App installation scoped to one private backup repository is the
  recommended low-blast-radius credential; a classic PAT in `GITHUB_TOKEN`
  works but grants whatever the PAT grants.
- Entry filenames now append the format extension (`github.com.osseal`)
  instead of replacing the final dotted label, restoring classic
  `password-store` interop; stores written by the earlier code that held
  dotted names must be re-inserted once.
