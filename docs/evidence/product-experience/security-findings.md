# Security findings

| ID | Result |
| --- | --- |
| ADV-01 | Registry refuses traversal and ledger paths. |
| ADV-02 | `prefsRevision`, duplicates, `__proto__` rejected by YAML profile + prefs schema. |
| ADV-03 | Documents over 256 KiB fail bounded; aliases/custom tags refused; no network fetch. |
| ADV-04 | Comment-only YAML change is presentation; local application configure is skipped. |
| ADV-05 | `autoLockMinutes: 7` is a valid number, not coerced. |
| ADV-12 | Source textarea uses `data-config-source`; keymap `typing()` ignores those keys. |
| ADV-13 | `authorizationForDestination` drops headers when the origin changes. |
| ADV-14 | Simulation evaluator is pure; no mail/token/approval. |
| ADV-16 | Reserved `sub`/`aud` cannot be mapped; untrusted email is not marked verified. |
| ADV-18 | Public clients cannot use `client_credentials`. Durable jti claim refuses replay on a second replica map. |
| ADV-20 | Selector-only `members[value eq id]` remove drops membership. |
| ADV-21 | A group named `owners` grants nothing without an explicit mapping. |
| ADV-22 | Rename then deactivate still offboards via remembered subjects. |
| ADV-26 | Recipe export rebuilds allowlisted fields; secrets/owners omitted. |
| ADV-30 | Operator-minted single-use tickets; two racing bootstraps yield one 201 and one 401; restart replay is 401; missing ticket cannot first-user-win. |
| ADV-23 | App admin cannot PATCH another client (404), cannot set `ownerPrincipalId` (400), cannot read another client's claim mapping (404), cannot list another org's members (404), public `client_credentials` is 400. |
| ADV-06 | Stale semantic revision conflicts; comment-only tab cannot overwrite a security edit. |
| ADV-07 | Drafts refuse to commit after tomb/actor switch. |
| ADV-08 | Semantic failure after source write leaves an orphan, never shown as applied. |
| ADV-09 | Recipe import refuses leftover secrets, grants, owners, and recovery codes. |
| ADV-10 | Untrusted proposal text matching approve/reveal/grant/enroll is refused. |
| ADV-11 | Palette and saved views drop unauthorized scopes; no cross-org cache reuse. |
| ADV-15 | Missing evaluator coverage returns `indeterminate`, not allow. |
| ADV-19 | Documented offline JWT bound is 3600 seconds; central revocation is not instant at an independent RP. |
| ADV-24 | Stale, expired, self-approved, and WebMCP/agent approvals are refused. |
| ADV-25 | Repeat recipe import keeps the same logical id; no duplicate on inspect. |
| ADV-27 | Empty, corrupt, and newer-schema prefs stay original bytes; they do not reset to defaults. |
| ADV-28 | Stale base revision reports conflict, not success for the wrong generation. |
| ADV-29 | Clipboard denial returns a failure; missing clipboard is not a silent copy. |
| ADV-31 | Resetting keybindings does not rewrite `autoLockMinutes`. |
| ADV-32 | Hosted drafts bound to one issuer cannot auto-apply to another. |
| ADV-33 | Non-loopback origins and missing openers cannot complete broker sign-in. |
| ADV-34 | LDAP setup refuses metadata, private, loopback, and cloud directory URLs; plain `ldap://` needs operator defaults. |
| ADV-35 | Uninstalling a type keeps item values; concealed fields stay out of search. |
| ADV-36 | yaml parser is a lazy chunk (`yaml-patch-*.js`); source editor is a native textarea. |

Same-origin XSS and a compromised custodian remain outside the enforceable hosted threat model. Encrypted storage is not a same-origin XSS boundary.

