# KMIP

KMIP (Key Management Interoperability Protocol) is a binary TTLV protocol over
TLS, normally on TCP port 5696. Storage arrays, databases, backup tools and
appliances use it to create, locate, fetch and manage symmetric keys.

Reference: [Infisical KMIP](https://infisical.com/docs/documentation/platform/kms/kmip).

## The static-PWA constraint

A static PWA cannot be a KMIP server.

- A browser page cannot listen on TCP 5696 or accept inbound connections.
- A service worker handles HTTP(S) fetch events only. It does not create a TCP
  listener and cannot speak raw KMIP/TTLV.
- Browser `fetch` cannot present a chosen client certificate for an arbitrary
  KMIP mTLS endpoint.
- KMIP is not HTTP; it is binary TTLV over a TLS stream with long-lived
  connections. It is not a CORS API.
- A static host cannot keep a process, certificate authority, key store or
  listener alive after the page closes.

A relay or backend would make it possible, but that is explicitly out of scope.
Therefore the honest free, backendless shape is a **native local KMIP server**
plus the static PWA as its control plane, not a KMIP server inside the PWA.

KMIP is also not a universal client for cloud KMS. AWS KMS, GCP KMS and Azure
Key Vault expose their own HTTPS APIs, not a KMIP endpoint. KMIP is the right
protocol when an external KMIP client (a storage array, database or backup
appliance) needs keys from us. It is not a substitute for per-provider KMS
adapters in vault settings.

## Target shape

```text
KMIP client (storage array, database, backup appliance)
        |
        | KMIP 1.0-1.4 over mTLS, TCP 5696
        v
opensesame kmip serve            <- native, free, local/private network
        |
        | sealed local store, no backend, no relay
        v
local keys + client ACLs + audit
        ^
        |
Static PWA (management only)      <- no listener, no key material in page
```

### Native `opensesame kmip serve`

- Free and available without a Host or cloud plan.
- Listens on `127.0.0.1:5696` by default; an explicit `--listen-address` may
  bind a private interface.
- TLS 1.3; client certificate required; server certificate and local CA.
- KMIP versions 1.0 to 1.4.
- Operations: Create, Register, Locate, Get, Activate, Revoke, Destroy, Get
  Attributes, Query.
- Symmetric keys only for the first release.
- No implicit key material in logs, stdout, argv or metrics.
- Per-client operation ACLs; a client can see only its project/namespace.
- Every request gets a redacted audit row: client id, operation, object id,
  result, reason class. Never key bytes.
- Bounded request size, connection count, concurrency and idle time.
- `SIGTERM` stops accepting, drains bounded requests, closes listeners.
- No rotate operation. A key used by a KMIP client must not be rotated; the
  UI warns and the server refuses rotation while a live client references it.

### Client registration

- Client id and optional description.
- Operation allowlist.
- Key namespace/project binding.
- Certificate:
  - Managed: native daemon creates the key and certificate, exports once.
  - CSR: PWA/WebCrypto may create a keypair and CSR; native signs it. The
    private key never leaves the browser.
- TTL, revocation, last-used and connection state.
- Client certificate CN = client id; OU = project id, matching the Infisical
  convention if compatibility matters.

### Static PWA control plane

The PWA can:

- create/edit/disable KMIP server profiles and client records;
- generate a CSR with WebCrypto and download it;
- show the exact DNS name, port, CA chain and client certificate bundle;
- show client permissions, last used, audit and connection health;
- export a sealed configuration bundle for the native daemon;
- warn that a client-visible key must not be rotated;
- show the one-line native command.

The PWA cannot:

- listen on 5696;
- accept a KMIP client connection;
- keep a CA or server key alive;
- proxy KMIP over HTTP;
- claim "KMIP server" while only an offline parser exists.

### Native/PWA storage boundary

The native daemon must own the keys it serves. A browser OPFS vault is not
visible to a native process, and copying a live key between them creates two
sources of truth.

Choose one:

1. **Native-owned KMIP store.** `opensesame kmip serve` reads the CLI sealed
   store. PWA manages enrollment/config and exports a signed profile. This is
   the simplest free/backendless shape.
2. **PWA-owned keys, native KMIP bridge.** Requires a local file/port bridge
   from the PWA to the native process. That is a local relay by another name;
   reject it unless the user explicitly accepts that boundary.

The first is the recommended default.

## KMS settings

KMIP belongs under a **KMIP** section, not under "KMS provider" rows for AWS,
GCP or Azure.

- AWS KMS, GCP KMS and Azure Key Vault are HTTPS client integrations; their
  credentials and API calls are provider-specific.
- A KMIP gateway can front a KMIP-capable appliance, but cloud KMS providers do
  not expose KMIP.
- If an operator has a KMIP-capable HSM or storage array, `opensesame kmip serve`
  is the free path.
- The KMS settings list should say which providers are HTTPS, which are KMIP,
  and which require a native daemon. The PWA must not pretend a static page can
  terminate KMIP.

## What not to build

- A WebAssembly KMIP server in a service worker: no listener, no client cert,
  no persistent key.
- A "KMIP over WebSocket" relay: that is a relay and breaks the constraint.
- A PWA button that says "Start KMIP server" when it only writes a config file.
- KMIP under an enterprise feature flag. The native daemon is free; the static
  control plane is free.
- Key rotation while a KMIP client holds the key.

## Delivery slices

1. **Native KMIP daemon.** TLS/mTLS, TTLV codec, KMIP 1.0-1.4, symmetric
   Create/Register/Locate/Get/Activate/Revoke/Destroy/GetAttributes/Query.
2. **Native sealed store and client ACLs.** Client cert issuance/CSR, project
   namespace, audit, limits.
3. **PWA control plane.** Profiles, clients, CSR generation, certificate
   download, health, audit, warning copy.
4. **Export/import.** Sealed profile bundle for the daemon; no backend.
5. **KMIP client conformance.** PyKMIP and at least one real appliance-style
   client; operation ACL and revocation tests.
6. **KMS settings copy.** Separate HTTPS KMS integrations from KMIP daemon
   rows; no false static-server claim.

## Acceptance

- `opensesame kmip serve` accepts a KMIP 1.0-1.4 client on 5696 over mTLS and
  performs the supported operations.
- A client can only use its allowed operations and project namespace.
- A revoked client certificate is refused on the next connection.
- No key bytes or private keys appear in logs, argv, environment, metrics or the
  PWA.
- The PWA clearly says a native daemon is required and never offers a listener
  it cannot create.
- Key rotation is refused while a KMIP client references the key.
- The daemon runs with no Host, cloud account or relay.
