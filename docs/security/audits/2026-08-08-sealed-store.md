# Audit 2026-08-08 — the sealed store's "ciphertext only" guarantee

Tick 73 read `packages/client-core`, the façade the Pages app, the PWA and the
browser extension all use to keep their sync store on disk. Its stated invariant is
that OPFS holds ciphertext only.

## The guard checked for its own test fixture

`persistSealedStore` refused a payload only if the JSON contained the literal
string `plaintext-should` — a string from its own test — or a `"plaintext":` key.
`assertNoPlaintextInSealedJson` looked for `secret-payload` the same way. So the
one thing the invariant was supposed to stop, a real vault document written to
disk, passed: actual credentials contain neither marker. The old unit test even
asserted that `{"blobs":[{"ciphertext":"abc"}]}` — not the store's shape at all —
was acceptable.

Both now validate the document structurally against the shape the store actually
has: a cursor naming a device and an epoch, plus blobs whose payload is base64,
with no other keys anywhere. Unknown keys are exactly where a plaintext document
would hide, so there are none. `parseSealedStore` is exported for callers that
want the parsed value rather than an exception.

## A stored file was adopted as identity without being checked

`loadSealedStore` returned whatever text OPFS held, and the PWA read
`cursor.device_id` out of it and adopted it — then used it as the file name for the
next write. A planted or half-written file therefore chose this client's device
identity, its epoch, and a path fragment. Device and blob ids are now bounded to a
safe character set and length, epochs must be non-negative safe integers, and the
blob list is capped.

A file that does not validate is treated as absent rather than as truth, so a
truncated write is replaced with a fresh envelope instead of shadowing a good copy
forever. The file name is also sanitized on the way out, so a device id can never
address anything but its own file.

## Not fixed here

- The store is still sealed by whatever the caller sealed it with; `sealDevOnly`
  remains an XOR fenced to dev/test, and the real AEAD lives in the Rust
  `client-core` wasm build. This tick checked the container, not the cipher.
- ~~Nothing binds a sealed store to the device that wrote it.~~ — closed: a store's
  cursor must name the device it is stored under, so a well-formed file copied from
  another profile is refused on write and read as absent.
