# ADR 0102: Vault-local identity directory

Status: Accepted for directory management; not an authentication protocol.

Without an Identity endpoint, People, Agents, Applications and Organization
manage records in the active encrypted tomb, including the isolated guest tomb.
The existing remote administration panels remain authoritative when an endpoint
is configured. An expired remote session must never fall back to local writes.

Records have random local IDs, kind, name and enabled state. Creating or enabling
a record grants no access, creates no credential and makes no assertion about
identity verification. No local ID is converted into a server principal. This
directory alone does not meet the broader requirement for browser-native IAM:
authentication, membership policy, grants and relying-party integration are not
implemented by these records. The interface states this boundary explicitly.

The directory uses the existing AES-GCM VFS at `config/identity-directory`.
Only an unlocked tomb can read or write it. Mutations await the VFS write;
Web Locks serialize directory writers and revision checks reject stale edits.
Invalid or unknown schemas fail closed rather than being replaced with an empty
directory. Names and entry count are bounded. OPFS-unavailable browsers retain
the existing session-only behavior with a visible warning.

This is local directory storage, not a distributed authorization database:
it inherits the VFS transport and its backup, cross-tab cache and multi-file
index-write limitations. No security decision may depend on its enabled bit.
Human administration is excluded from agent mutation surfaces under ADR 0065;
existing Identity navigation remains available to WebMCP.
