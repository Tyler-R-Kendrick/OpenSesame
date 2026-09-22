# Runtime boundary

What executes where, and how each "does not participate" claim below was
checked rather than asserted.

## What runs SOPS

| Component | Where it runs | Ships? |
| --- | --- | --- |
| `apps/pages/src/lib/sops/**` | The page and a module Web Worker, in the browser | yes |
| `age-encryption`, `@noble/ciphers`, `yaml` | Bundled into the worker chunk | yes |
| WebCrypto (`SHA-512`, `SHA-256`, `getRandomValues`) | Browser platform | n/a |
| `apps/pages/scripts/sops-oracle/**` | A developer's machine, at build time | **no** |
| `sops` v3.13.3 binary | A developer's machine, at build time | **no** |

The worker chunk is code-split: it is fetched when a SOPS document is
opened, not on boot.

## What does not participate

None of the following is started, contacted, required, or named by the
shipped application:

- the Host API (`apps/gateway`, `:8787`)
- the local daemon (`apps/daemon`, `:18790`)
- the Identity API (`apps/control-plane`, `:8788`)
- the host CLI (`opensesame`), including `pass protect`
- a `sops` binary, and the `OPENSESAME_SOPS_BIN` environment variable
- a browser extension, a Node service, a serverless function, a conversion
  or transcoding service, a separately installed runtime

### How that was checked

1. **Bundle scan** (`scanBundle`, SB-071). Every `.js`/`.mjs`/`.css`/`.html`
   file in the production `dist/` is searched for `OPENSESAME_SOPS_BIN`,
   `child_process`, `node:fs`, `/dev/stdin`, and
   `opensesame pass protect`. The gate fails on any hit. Current result: no
   offenders, at both `/OpenSesame/` and `/`.
2. **Origin watch** (SB-072). The Playwright context records every request
   the page makes during the whole workflow — open, decrypt, edit, encrypt,
   save, and a new document. Requests to any origin other than the static
   file server fail the gate. Current result: **0**.
3. **Offline run** (SB-074). The service worker is installed, the browser
   context is put offline with `context.setOffline(true)`, the app is
   reloaded, and the entire workflow runs again with no network at all.
   Current result: pass, with byte-identical behaviour.
4. **Import graph** (`agent-boundary.test.ts`). The shipped sources are read
   and checked: no WebMCP, support-agent, tutorial or analytics module
   imports the engine, the worker, or the age key module.
5. **Dependency allowlist** (`boundaries.test.ts`, SB-020). The engine's
   third-party imports are asserted to be exactly `age-encryption`,
   `@noble/ciphers/aes` and `yaml`. The list cannot grow without someone
   editing that assertion deliberately.

## Development infrastructure is not a backend

The gates use a static file server (to serve `dist/` over HTTP, which a
`file://` origin cannot do for a service worker), Playwright, and Vitest.
These run on a developer's machine, produce no request the app depends on,
and are absent from the deployed artifact. A static file server that serves
bytes is what GitHub Pages is.

The conformance oracle is the same kind of thing one level further out: the
upstream `sops` binary runs at build time to *produce and check fixtures*.
The browser never invokes it, and `verify:sops-browser` would fail if the
bundle so much as named it.

## Deployment shapes proven

| Base | Origin in the gate | Result |
| --- | --- | --- |
| `/OpenSesame/` (GitHub Pages subpath) | `http://127.0.0.1:<port>` | pass |
| `/` (domain root) | `http://127.0.0.1:<port>` | pass |

Both are built from the same source with `VITE_BASE`, and both run the full
online and offline workflow. A subpath deployment is the shape the project
actually publishes; the domain-root run exists because a base-path bug
typically only appears in one of the two.

## The service-worker fix this work required

The engine runs in a module Web Worker, and on the installed app **no**
dedicated worker could start. The cause was not SOPS: `apps/pages/src/sw.ts`
was adding `Cross-Origin-Embedder-Policy: require-corp` to navigation
responses while serving worker scripts without it, so every worker script
was blocked as a non-CORP subresource of a COEP document. Blob workers
worked, which is what made it look like a SOPS problem.

`sw.ts` now sets `Cross-Origin-Embedder-Policy: require-corp` and
`Cross-Origin-Resource-Policy: same-origin` on responses whose request
destination is `worker` or `sharedworker`. This also repairs the
pre-existing `website-pattern.worker`, which had the same failure for the
same reason. `vite.config.ts` sets `worker.format: "es"` so the worker is
emitted as a module rather than an IIFE.
