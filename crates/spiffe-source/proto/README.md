# Workload API protos

* `workload.proto` — the SPIFFE standard file, vendored verbatim from
  `spiffe` 0.16.1 (`src/proto/workload.proto`), which mirrors
  https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_API.md.
  Kept for provenance; the production client is the `spiffe` crate's own.
* `workload_x509.proto` — the X.509-profile subset (`FetchX509SVID`,
  `FetchX509Bundles`, the `X509*` messages) from which the test fake's server
  stubs in `src/fake/pb.rs` are generated. The subset exists so the generated
  module stays under the repository's 400-line file budget; wire names and
  routes are unchanged, so the real client talks to the fake unmodified.

Regenerate `src/fake/pb.rs` (no `protoc` required; `protox` compiles the
proto in Rust):

```toml
# scratch Cargo.toml
[dependencies]
protox = "0.9.1"
tonic-prost-build = "0.14.6"   # prost-build 0.14.4, tonic-build 0.14.6
```

```rust
let fds = protox::compile(["proto/workload_x509.proto"], ["proto"])?;
tonic_prost_build::configure()
    .build_client(false)
    .build_server(true)
    .out_dir("out")
    .compile_fds(fds)?;
// copy out/_.rs to src/fake/pb.rs and restore the header comment + allow block
```
