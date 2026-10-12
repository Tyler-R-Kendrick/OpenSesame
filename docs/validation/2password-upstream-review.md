# 2password PR and issue oracle

The expanded oracle includes every upstream pull request and issue visible on
2026-10-05: nine PRs and two issues. The all-state 100-item issue collection
returned 11 entries, and page two was empty. Full patches and combined issue,
review and inline comments were inspected. Exact branch SHAs and changed files
are pinned in `spec/conformance/2password-upstream-review.json`.

| Source | State | Behavior incorporated into the oracle |
| --- | --- | --- |
| [PR 2](https://github.com/kitlangton/2password/pull/2) | Merged | `run` is injection into a trusted child; `read` and env resolution deliberately reveal. |
| [PR 3](https://github.com/kitlangton/2password/pull/3) | Closed, unmerged | Duplicate trust-boundary documentation; no separate runtime feature. |
| [PR 4](https://github.com/kitlangton/2password/pull/4) | Closed, superseded | Combined request/lease prototype; use the narrower current PR 6/8/9/10 contracts. |
| [PR 5](https://github.com/kitlangton/2password/pull/5) | Merged | Windows private input, protected saved tokens, token isolation, settings paths and cross-platform storage diagnostics. |
| [PR 6](https://github.com/kitlangton/2password/pull/6) | Open | Private HTTPS GET executor; validates all DNS answers, pins TLS, never follows redirects, caps response/deadline, emits only a receipt. |
| [PR 7](https://github.com/kitlangton/2password/pull/7) | Open | Platform-neutral saved-token and device wording. |
| [PR 8](https://github.com/kitlangton/2password/pull/8) | Open, stacked | Stable local principal, exact request binding, persistent authority metadata, atomic counters, expiry and revocation. |
| [PR 9](https://github.com/kitlangton/2password/pull/9) | Open, stacked | Metadata-only credential versions, claim before plaintext, post-read version check and consumed failed uses. |
| [PR 10](https://github.com/kitlangton/2password/pull/10) | Open, stacked | Deliberate human approval; lease-required requests; approval/status/revoke commands; defaults 10 minutes/one use, maximum one hour/ten uses. |

[Issue 1](https://github.com/kitlangton/2password/issues/1) distinguishes
`secret.use` from `secret.reveal`. Its two comments refine the proposed request
primitive to receipt-only: unrelated response PII and newly minted tokens must
also stay private. Exact-secret echo accounting is useful diagnostics, rather
than authorization or permission to release the rest of a response. A lease
binds principal, reference/resource field, action, full destination fingerprint,
resource version, expiry and an atomic use budget. The current PR stack is
same-user local authority state; it does not establish per-agent OS isolation
or a resident broker. A stored service-account token alone must not authorize
a leased request.

[Issue 11](https://github.com/kitlangton/2password/issues/11) identifies three
failures in the pinned default branch. The expanded oracle requires corrections,
rather than copying these failures:

- Credential executables must resolve through absolute PATH directories.
  Empty/relative PATH entries and implicit working-directory lookup cannot
  supply `op`, clipboard or storage helpers that receive credentials.
- Internal runtime helpers must not execute repository-controlled preload
  code. Startup environment and working directory must be controlled before
  launch; removing an authentication token inside a script occurs too late
  when a runtime preload already ran.
- Metadata URLs must contain only valid HTTP(S) origins. Paths, malformed URLs
  and unsupported protocols can carry credentials. Audit identifies transient
  raw URLs privately, then returns an origin and fixed `transient-url` reason.

The request receipt also uses origin-only display while retaining a SHA-256
fingerprint of the exact URL. This strengthens the PR's origin-plus-path receipt
against the path-token failure described in issue 11 without changing exact
request authorization.

The original 32-scenario/174-binding default-branch gate passed. The expanded
matrix initially adds 16 scenarios and 50 bindings. These additional contracts
remain fail-closed until exact runtime assertions exist for every stated
surface; the earlier default-branch report does not establish expanded parity.
Browser request preparation/handoffs must identify a native execution boundary
explicitly: ordinary browser fetch cannot attest pinned DNS/TLS behavior.

Two additional integration scenarios require item-detail workflows and
organization-health navigation. The resulting matrix contains 52 scenarios and
197 stated surface bindings, including a travel-withdrawal regression through
the shared adapter and actual WebMCP handlers. Account custody additionally
binds each login method, excludes human-protected passwords from automated
reads and preserves sibling methods. Withdrawal during asynchronous discovery
must remove previous item names and references and reject subsequent reads and
updates. A native request handoff was once a third scenario, bound to an Access
form that prepared shell commands; it was removed with the form, and native
requests remain a CLI-only contract (ADR 0177).

The runtime gauntlet runs on Linux. Windows helper/clipboard command policies
are reviewed and covered by portable contract tests; this report does not
claim execution on a Windows desktop or live DPAPI/provider authentication.

Final verification on 2026-10-05 passed the expanded frozen matrix of that date (53
scenarios, 237 surface checks; since narrowed to 52 and 197, see the 2026-10-07 correction in
[validation](2password-parity.md)), with no failures after fresh native and PWA
builds. All seven runtime suites passed. The default-branch result above is
historical; the expanded report now establishes the stated PR/issue contracts
and contextual surface bindings. See [validation](2password-parity.md) for
exact suite counts and repository verification.
