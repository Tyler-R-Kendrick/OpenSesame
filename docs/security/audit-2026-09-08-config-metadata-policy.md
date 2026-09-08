# Config metadata authorization boundary

The prior Host routes admitted any organization session to project config/key
metadata; the operator could also omit organization selection. Cached session
roles did not reflect subsequent authorization changes. Version, comparison
and changelog routes exposed the same metadata through independent paths.

The new boundary uses a durable, explicit Host role ceiling plus separate
project metadata/key permissions. Reads never provision policy. Native updates
are revision-fenced; verified Identity evidence can only narrow existing policy
and cannot reuse pre-revocation authentication evidence. Every config alias and
both comparison operands use one resource check. Changelog requires key-name
permission. Unauthorized resources use the same response as nonexistent ones.

The Pages panel queries effective server capabilities and does not request keys,
show write controls or expose comparison/changelog actions without permission.
These controls do not replace server enforcement. Guest and offline vault entry
remain independent of the optional Host policy.

Focused regression coverage includes metadata-only membership, independent key
permission, cross-project/cross-organization refusal, immediate role revocation,
stale admin sessions, stale Identity evidence and same-shaped not-found results.
Final integration must record the exact Gateway/CLI and complete repository gate
results; standalone policy tests are not proof that issuance hooks or route
registration were wired successfully.

Focused implementation-worktree results: broker policy integration tests 2/2;
`cargo +1.88.0 clippy -p opensesame-connection-broker --test config_access -- -D warnings`
passed; Pages panel tests 14/14 and Pages TypeScript typecheck passed. Gateway
route tests require the integrated migration/module/issuance wiring.
