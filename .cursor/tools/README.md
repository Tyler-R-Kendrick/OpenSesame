# Cloud tooling pins

The Cursor image uses the official Node 22 Bookworm image pinned by its OCI
manifest digest. The native compose and OSS-Fuzz images are pinned the same way.
Each digest was checked against the SHA-256 of the registry's manifest payload.

`downloads.json` pins the exact upstream Grok and Cursor Agent payloads, rather
than their mutable installers. `scripts/dev/install-cloud-cli.mjs` verifies the
whole SHA-256 before executing or extracting anything. Grok supports Linux x64
and arm64, matching the cloud image; Cursor Agent retains Linux and macOS x64
and arm64 support. Update a version and every supported platform digest together
using the upstream versioned URLs, then exercise the native entry point.

`package-lock.json` locks Kimi Code 2.1.1 and every npm dependency with integrity
metadata. The image uses `npm ci`, preserves its optional native dependencies,
and exposes the existing `kimi` command from that isolated installation. Scan
this lock with the other tracked dependency inputs when updating it.
`node-pty` is a direct requirement so a native-build failure cannot silently
remove terminal support. The image supplies Python and its own Node headers.

The OSS Verify enrollment pack is different: its external `tools/check` builds
`BASE_BUILDER` locally from its locked toolchain and passes that local image to
the project's Dockerfile. There is no published builder digest to pin here.
Preserve that upstream contract; validate it with OSS Verify's `--lock` and
`--twice` flow before enrollment rather than inventing a registry image.
