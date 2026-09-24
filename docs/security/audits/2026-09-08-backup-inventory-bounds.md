# Backup inventory and credential transport bounds

Integration review found that bounded sync pages did not bound the adjacent
credential and vault-revision inventory, nor the destination's accumulated file
manifest. The backup actor now uses the existing snapshot iterator for every
inventory phase instead of collecting those ciphertext families first.

Storage queries enforce tenant scope and keyset order with at most 32 records
per page. Length metadata is checked before ciphertext is loaded: a record may
contain at most 2 MiB of sealed bytes and 16 KiB of metadata, and a page has an
8 MiB conservative serialized-size budget. Empty phases and equal-key revision
continuations do not omit records. Legacy oversized records cause an explicit
failure; they are not silently skipped.

Git trees and connector manifests reserve their metadata budget before upload
or accumulation: at most 4,096 files and 2 MiB of conservatively escaped
metadata. Existing outbox retry and terminal-failure handling remain in force;
the final destination reference is not advanced for an incomplete snapshot.
Unreferenced remote objects from an interrupted attempt are not automatically
deleted.

Git API responses are bounded to 1 MiB and ten seconds. Object identifiers must
be supported lowercase hexadecimal digests, not paths. Provider error bodies
are not copied into errors. The broker's shared credential client now refuses
redirects and fails construction rather than falling back to default transport.

The TypeScript sync client's ten-second deadline spans both response headers
and body. Its DPoP mode accepts the actual paired proof key, uses the DPoP
authorization scheme, and refuses redirects. Ordinary native bearer behavior
remains distinct.

Focused evidence: storage inventory tests 4 passed; Gateway backup selection
27 passed; API client 89 passed; credential redirect regression 1 passed.
Storage and Gateway all-target/full-feature Clippy checks passed at the backup
handoff. These checkpoints do not replace final integrated verification, and
they do not claim completed model-backed or coverage-guided scanning.
