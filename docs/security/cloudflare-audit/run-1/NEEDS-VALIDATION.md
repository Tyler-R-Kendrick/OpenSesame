# Needs validation, run 1

Unresolved leads. No severity. Do not treat these as confirmed vulnerabilities, and do not send audit traffic to a deployment. Each local plan is a bounded fixture. Each deployment plan is an owner observation of configuration or runtime state.

Sandbox limits that kept these unresolved: no Android emulator, no Multipaz sources, no wasmtime prebuilt target and the file-size ulimit cannot compile it, no compiled gateway under the same limits, no `cmd.exe` or Wine, Docker is not installed, and compose must not be started. Disk cgroup quota is unavailable; the substitutes are `ulimit -f` and a 32 MiB `/tmp` tmpfs.

## Exported custom-scheme handlers skip invocation policy before wallet operations

Fingerprint: `apps/android/invocation/custom-scheme-skips-validate-platform-invocation`.

MainActivity is exported, declares no android:permission, and is BROWSABLE for openid-credential-offer and haip-vci with host *. Its https VIEW branch calls validatePlatformInvocation and forwards only the returned protocolUri into launchOpenID4VCIProvisioning or into OpenId4VpActivity. That policy admits only an associated https link with one of request_id, user_code, or a public https request_uri, and it rejects credential_offer, token, code, password, secret, any other parameter, and private, loopback, or link-local request hosts. The custom-scheme branch never calls it: both issuance schemes pass intent.data.toString() straight to launchOpenID4VCIProvisioning. The function cannot be applied to that raw string, because it requires the https authenticator origin and fails closed as UnverifiedInvocationOrigin before any host check; the missing control is an equivalent check of the offer before the handoff. Exported OpenId4VpActivity is a second permissionless BROWSABLE entry for openid4vp, haip-vp, and mdoc, subclasses UriSchemePresentmentActivity, and never calls validatePlatformInvocation. The https OID4VP branch shows that activity's VIEW data is the presentment protocol URI. usesCleartextTraffic false and the provisioning client's followRedirects false do not inspect the initial host or an inline credential_offer, and requireFreshUserVerification is not called on these paths. The iOS WalletView adapter uses the same https-versus-custom-scheme split; that calibrates the pattern and does not show Multipaz refusing a private or inline offer. ADR 0058 documents both associated https links and these schemes as handoff channels. Whether Multipaz then fetches a private credential_offer_uri or request_uri, or accepts an inline credential_offer, is not in the repository.

Claimed root cause: Custom-scheme VIEW handlers on exported activities pass attacker-controlled intent data into OID4VCI provisioning or OID4VP presentment without the private-URI and forbidden-parameter checks that the https branch applies through validatePlatformInvocation.

Trace:

- entrypoint: `apps/android/android/app/src/main/AndroidManifest.xml:26` `MainActivity intent-filter` — MainActivity is exported with no android:permission and this BROWSABLE VIEW filter registers openid-credential-offer with host *; haip-vci is the next data element in the same filter.
- propagation: `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:93` `MainActivity.handleIntent` — openid-credential-offer and haip-vci take uri.toString() with no call to validatePlatformInvocation and no private-host or forbidden-parameter check.
- sink: `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:96` `MainActivity.handleIntent` — That raw offer string is passed to launchOpenID4VCIProvisioning. The https branch reaches the same call only with invocation.protocolUri after validatePlatformInvocation.

Evidence:

- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:71`: The https branch calls validatePlatformInvocation with the configured origin and later forwards only invocation.protocolUri.
- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:92`: The openid-credential-offer and haip-vci branch does not call validatePlatformInvocation before the provisioning handoff.
- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/OpenId4VpActivity.kt:6`: OpenId4VpActivity subclasses UriSchemePresentmentActivity, returns WalletRuntime.presentmentSource, and has no invocation-policy call.
- `apps/android/android/app/src/main/AndroidManifest.xml:33`: OpenId4VpActivity is exported and declares no android:permission.
- `apps/android/android/app/src/main/AndroidManifest.xml:40`: The OpenId4VpActivity VIEW filter is BROWSABLE and registers openid4vp with host *; haip-vp and mdoc follow on the next lines.
- `crates/authenticator-core/src/lib.rs:203`: validate_link accepts only an https URL whose origin is the authenticator origin, so a custom-scheme string never reaches the later parameter or host checks.
- `crates/authenticator-core/src/lib.rs:222`: On an https invocation the policy rejects credential_offer, token, code, password, and secret, then rejects any parameter other than request_id, user_code, or request_uri.
- `crates/authenticator-core/src/lib.rs:270`: When allow_private_request_uris is false, which new() hardcodes, a private or loopback request URI is rejected before a protocol URI is built.
- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/WalletRuntime.kt:61`: The provisioning HTTP client disables redirect following. That does not validate the initial offer host or refuse an inline credential_offer.

Blockers:

- This environment has no Android emulator or device, so an explicit or browsable VIEW intent was not delivered to MainActivity or OpenId4VpActivity and no dummy listener was contacted.
- org.multipaz:multipaz:0.100.0 and org.multipaz:multipaz-compose:0.100.0 are not in the repository or a local Gradle cache, so it is not source-visible whether launchOpenID4VCIProvisioning or UriSchemePresentmentActivity fetches a private credential_offer_uri or request_uri, accepts an inline credential_offer, or returns before any network or credential operation. That library behavior is the decisive effect.

Local plan:

On an emulator, install a debug build with opensesameWalletBackendUrl set to a dummy https origin and opensesameInvocationHost set to a non-production hostname. Use no production backend, store signing key, or real credential. If WalletRuntime.initialize throws before handleIntent, record that and stop; the run is inconclusive. From a second app, send explicit ACTION_VIEW intents and stop at the boundary: MainActivity with data openid-credential-offer://?credential_offer_uri=https%3A%2F%2F127.0.0.1%3A9%2Foffer against a 127.0.0.1:9 TLS listener that only logs the ClientHello; MainActivity with a separate openid-credential-offer://?credential_offer= value that is a short dummy JSON offer containing no secret, token, or real credential; and OpenId4VpActivity with openid4vp://?request_uri=https%3A%2F%2F127.0.0.1%3A9%2Frequest against the same listener. Record whether a TCP connection or TLS ClientHello reaches 127.0.0.1:9 and whether provisioning leaves Idle. Do not complete issuance, approve a presentation, or install a local trust anchor. A failed handshake still counts as contact if the ClientHello is sent.

Owner-observed plan:

No production host or store signature is required. If the emulator result is inconclusive, read only the pinned Multipaz 0.100.0 sources for ProvisioningModel.launchOpenID4VCIProvisioning and UriSchemePresentmentActivity, and record whether each requests the supplied URI before consent and whether it rejects a private host or an inline credential_offer. Do not run those entry points against a real issuer, verifier, or credential.

## Sandbox broker calls ignore grant expiry after the profile is minted

Fingerprint: `crates/sandbox/spawn/grant-expiry-not-rechecked`.

SandboxProfile::from_grant_chain stores the chain's earliest expires_at and clamps ResourceBudget.deadline to the remainder at that instant, and never above the 5 second platform ceiling. Sandbox::spawn then accepts untrusted guest bytes after only RevocationFence::check, once before compile and again before the guest entry. fresh_store arms Store::set_epoch_deadline with deadline_ticks of that stored Duration. Wasmtime 36.0.17 (Cargo.lock) implements set_epoch_deadline as current engine epoch plus the delta (store.rs StoreInner::set_epoch_deadline), so the interval is rebased to fresh_store rather than cut off at expires_at. still_authorized, used by emit, http-fetch, sign, and token-acquire, returns fence.check and does not read profile.expires_at or the clock. The expires_at getter has no caller in this crate, and binds_chain does not compare the window. Source therefore links whatever broker imports the profile granted and reaches Broker after only a live fence, including when Utc::now() is already past expires_at, and a spawn that starts with time left can still run until mint-time deadline after expires_at by the delay before fresh_store (compile happens first) or by any later spawn on the same Sandbox. Each spawn gets a fresh interval of at most that mint-time deadline, not an unbounded single run. No workspace crate calls Sandbox::spawn. Gateway finish_dispatch does re-check grant.assert_active(Utc::now()) immediately before its broker side effect; connector-host rebases an epoch deadline the same way but does not carry this grant window. The post-expiry broker invocation itself was not executed.

Claimed root cause: Authority lifetime is enforced only as a Duration clamp inside from_grant_chain. Spawn, fresh_store, and still_authorized treat a live RevocationFence as sufficient authorization and re-base the epoch deadline on the engine epoch at fresh_store instead of the absolute expires_at.

Trace:

- entrypoint: `crates/sandbox/src/runtime/mod.rs:139` `Sandbox::spawn` — Untrusted guest bytes enter spawn. The only authorization check here, and the only one repeated at line 163 before the guest runs, is fence.check. Nothing compares Utc::now() with profile.expires_at, so a profile minted inside the window still passes after the window has closed while the generation fence is live.
- propagation: `crates/sandbox/src/runtime/mod.rs:224` `Sandbox::fresh_store` — set_epoch_deadline is given deadline_ticks of the mint-time Duration. That value is not recomputed from profile.expires_at, and wasmtime adds it to the engine's current epoch, so the wall-clock budget starts at fresh_store.
- propagation: `crates/sandbox/src/runtime/imports.rs:61` `still_authorized` — The call-time gate returns fence.check and does not read the cloned profile's expires_at or the clock. GuestState carries the profile, but the shims use it for byte caps only.
- sink: `crates/sandbox/src/runtime/imports.rs:154` `http_fetch_impl` — After still_authorized, the guest destination is passed to Broker::http_fetch. sign_impl (Broker::sign), token_impl (Broker::token_acquire), and emit_impl (Broker::emit) use the same fence-only check. RunContext carries organization and grant ids, not expires_at.

Evidence:

- `crates/sandbox/src/profile.rs:107`: from_grant_chain takes the earliest grant expires_at, converts expires_at minus now into a Duration, clamps the budget with that remainder, and stores the timestamp. The DateTime is not read again except by its getter.
- `crates/sandbox/src/profile.rs:176`: expires_at() is the only read of the stored timestamp. No other file in the repository calls SandboxProfile::expires_at.
- `crates/sandbox/src/profile.rs:186`: binds_chain compares leaf id, root id, organization id, and invalidation generation only. It does not test the validity window.
- `crates/sandbox/src/budget.rs:64`: ResourceBudget::CEILING.deadline is Duration::from_secs(5), so the mint-time clamp is at most five seconds.
- `crates/sandbox/src/budget.rs:149`: clamped_to_remaining documents that a run may not outlive the grant, but the body only mins deadline with the Duration the caller already computed at profile construction.
- `crates/sandbox/src/runtime/limits.rs:137`: deadline_ticks converts a Duration to epoch ticks rounded up, with a floor of one tick. It has no absolute timestamp.
- `crates/sandbox/src/revoke.rs:128`: RevocationFence::is_live is the kill flag and ledger generation equality. Time passing does not move the ledger, so an unrevoked fence stays live after expires_at. check() only calls is_live.
- `crates/sandbox/tests/revocation.rs:66`: a_stale_profile_cannot_start_a_run_at_all expects spawn to return Revoked after a generation bump. No sandbox test sleeps past expires_at and expects spawn or a broker call to fail.
- `crates/sandbox/tests/guests.rs:89`: The same Sandbox value is spawned twice. The public API is built for reuse, so a retained engine is the normal shape, not a one-shot that ends at mint.
- `crates/gateway/src/routes/intents_queue.rs:124`: Calibration only: finish_dispatch reauthorize calls grant.assert_active(Utc::now()) immediately before the broker side effect. The sandbox path has no equivalent call. This does not dismiss the sandbox gap.

Blockers:

- Spawn after expires_at was not executed. sandbox-run.sh with RUSTUP_HOME=/usr/local/rustup and CARGO_HOME=/usr/local/cargo can run rustc 1.88.0, but cargo test -p opensesame-sandbox --offline --locked --manifest-path /workspace/Cargo.toml --features wasm-runtime,fixtures --no-run is killed with signal 25 (SIGXFSZ) while compiling syn, before opensesame-sandbox or wasmtime is built. ulimit -f is 10240 (about 5 MiB), ulimit -v is 1048576 KiB, ulimit -t is 25, and the wrapper timeout is 25s. /workspace/target does not exist and no libwasmtime or libopensesame_sandbox rlib is on disk. Source control flow is unambiguous that the broker call is not gated on expires_at; the missing fact is the observed spawn result against a recording broker.

Local plan:

On a normal toolchain, offline and locked, with a writable target directory outside the audit sandbox: cargo test -p opensesame-sandbox --offline --locked --features wasm-runtime,fixtures. Use a chain whose ttl is a few seconds and whose actions include sandbox.http, mint the profile, keep the revocation fence live, and sleep until Utc::now() is past profile.expires_at(). Spawn a one-call http-fetch module on the in-crate RecordingBroker (no network, no live credential) and record whether spawn returns Ok and whether fetched() contains the guest destination. Separately, spawn while less than the mint-time deadline remains and record whether that broker call is entered after expires_at. Do not revoke the fence and do not point the broker at a real host.

Owner-observed plan:

No deployed service is required. No workspace crate calls Sandbox::spawn. The owner check is the same local cargo test. If an integrator already holds a Sandbox across a grant window, observe only whether their Broker::http_fetch is entered after expires_at with the fence still live, using a recording double rather than a production credential or network fetch.

## Path-scoped egress allowlist accepts encoded traversals that decode outside the prefix

Fingerprint: `domain.EgressBinding.allows_url/encoded-path-escape`.

EgressBinding::allows_url is the destination fence on the connection-owner level-2 invoke path before the sealed bearer is attached. New connections default to max_invoke_level 2. Delegates are refused above level 1. The owner grant minted from the catalog lists the provider's operations, and invoke_network_json checks only that the operation name is in that list. The later OpenFGA check, when configured, also sees subject, operation, and resource, not the URL. After url 2.5.8 WHATWG parsing, a non-empty path_prefixes entry matches when Url::path() equals the prefix or starts with that prefix plus a slash. A whole segment that is exactly .. or %2e%2e is collapsed, so https://api.doppler.com/v3/projects/%2e%2e/%2e%2e/configs/config/secrets becomes /configs/config/secrets and fails the prefix test, and the literal values path /v3/configs/config/secrets fails it too. A traversal glued to %2f, a semicolon, or %5c is not a whole dot segment. Applied to Doppler prefixes [/v3/projects, /v3/configs/config/secrets/names], Cloudflare Origin CA [/client/v4/certificates], a custom base path such as /api/v2, and OpenRouter [/api/v1/], those forms stay under the prefix and pass. url.as_str() keeps the encoded target, and reqwest 0.12.28 builds the HTTP URI from that string on http_bytes, which uses redirect Policy::none. One percent-decode of the accepted Doppler target /v3/projects/%2e%2e%2fconfigs/config/secrets is /v3/projects/../configs/config/secrets, which resolves to the values path the catalog test says must stay unreachable. The in-repo surrogate check_scope refuses dot segments, backslash, and semicolon on both the raw path and one percent-decode because upstream resolution is not predictable. allows_url does not. Whether Doppler, Cloudflare, OpenRouter, or a custom origin performs that decode is not in this repository.

Claimed root cause: allows_url decides path scope from Url::path() with a segment-boundary prefix test and never percent-decodes the path or rejects .., backslash, or semicolon segments. authorized_json treats that Ok as sufficient and http_authorized attaches the sealed credential to the original URL.

Trace:

- entrypoint: `crates/gateway/src/routes/intents.rs:471` `create_checked` — When invoke_level is 2 and the resolved connection is broker-backed, the caller JSON parameters.url is copied into ConstrainedHttpInput with no path normalization.
- propagation: `crates/authz/src/authority_use.rs:86` `authorize_authority_use` — Level-2 authorization accepts the URL when this same allows_url returns Ok. It does not decode the path or bind the operation to a path.
- propagation: `crates/gateway/src/routes/intents.rs:394` `execute_invocation` — The copied URL is passed to invoke_network_json together with the caller operation name.
- propagation: `crates/connection-broker/src/egress.rs:94` `ConnectionBroker::invoke_network_json` — The operation is accepted when its name is in the provider list. The URL is not compared to that operation.
- propagation: `crates/connection-broker/src/egress.rs:207` `ConnectionBroker::authorized_json` — After the row is in-org and Active, the only destination check is row.egress.allows_url(url). Ok continues into credential opening.
- propagation: `crates/domain/src/authority.rs:235` `EgressBinding::allows_url` — A non-empty path_prefixes list allows the WHATWG path when it equals a prefix or starts with that prefix plus a slash, including segments such as %2e%2e%2fconfigs, ..%2f..%2f, ..;, and %5c..%5c.
- sink: `crates/connection-broker/src/egress.rs:346` `ConnectionBroker::http_authorized` — credential_header's sealed access token is set on the request for the caller URL. The http_bytes client does not follow redirects.

Evidence:

- `crates/domain/src/authority.rs:229`: The compared path is Url::path(), which leaves %2f, %5c, and semicolon inside a segment.
- `crates/domain/src/authority.rs:235`: Path scope is path == prefix or path.starts_with(prefix + '/'), using the WHATWG path only. There is no second decode.
- `crates/connection-broker/src/egress.rs:207`: authorized_json returns before opening the credential only when allows_url fails. An Ok continues into credential injection.
- `crates/connection-broker/src/egress.rs:340`: http_authorized sends the caller URL on self.http_bytes, the client built with redirect Policy::none.
- `crates/connection-broker/src/egress.rs:346`: credential_header's value is set on the outbound request for the caller URL.
- `crates/connection-broker/src/lib.rs:287`: http_bytes is built with reqwest redirect Policy::none, so a 3xx is not followed with the bearer.
- `crates/connection-broker/src/lib.rs:97`: DEFAULT_MAX_INVOKE_LEVEL is 2, so a new connection's ceiling includes constrained HTTP unless an owner lowers it.
- `crates/gateway/src/routes/intents.rs:306`: A delegate is refused when invoke level is greater than 1, so this URL path is the connection owner's, not a delegated agent's.
- `crates/connection-broker/src/delegation.rs:343`: The owner grant minted from the catalog copies provider.operations into actions, which invoke then checks only by name.
- `spec/connectors/catalog.json:2284`: Doppler's fence is the prefixes /v3/projects and /v3/configs/config/secrets/names.
- `crates/connection-broker/src/catalog_tests.rs:123`: doppler_promotion_is_value_blind requires allows_url to reject the literal secret-values path /v3/configs/config/secrets.
- `spec/connectors/catalog.json:1128`: cloudflare-origin-ca is limited to /client/v4/certificates. The encoded ..%2f and %2e%2e%2f forms still match that prefix.
- `spec/connectors/catalog.json:2882`: OpenRouter's path prefix is /api/v1/, so /api/v1/..%2fkeys still matches the segment-boundary test.
- `crates/connection-broker/src/custom_provider.rs:211`: A custom connector's path prefix is the base URL path, so a base of https://host/api/v2 is supposed to confine the credential to that subtree.
- `crates/invoke-through/src/surrogate/scan.rs:166`: The sibling path fence refuses dot segments, backslash, and semicolon in both the raw and percent-decoded path because the upstream's resolution is not the host's to predict.

Blockers:

- The broker and reqwest 0.12.28 agree on the encoded request-target: try_uri parses url.as_str(), and a sandboxed url 2.5.8 parse kept paths such as /v3/projects/%2e%2e%2fconfigs/config/secrets, /client/v4/certificates/%2e%2e%2fuser/tokens/verify, and /api/v2/..%2fadmin. Reaching /v3/configs/config/secrets, /client/v4/user/tokens/verify, /keys, or a custom /admin path requires the upstream to percent-decode that target and then resolve .., backslash, or semicolon parameters. That behavior is not in the repository, and this sandbox has no external network, so api.doppler.com, api.cloudflare.com, and openrouter.ai were not called.

Local plan:

Call the crate EgressBinding::allows_url, not a transcribed copy. With Doppler's binding, https://api.doppler.com/v3/configs/config/secrets?project=a&config=b and https://api.doppler.com/v3/projects/%2e%2e/%2e%2e/configs/config/secrets must be Err, and https://api.doppler.com/v3/projects/%2e%2e%2fconfigs/config/secrets?project=a&config=b, https://api.doppler.com/v3/configs/config/secrets/names/..%2f..%2f?project=a&config=b, https://api.doppler.com/v3/projects/..;/configs/config/secrets, and https://api.doppler.com/v3/projects/%5c..%5cconfigs/config/secrets must be Ok. Repeat for Cloudflare Origin CA with https://api.cloudflare.com/client/v4/certificates/%2e%2e%2fuser/tokens/verify and for authority internal.example:8443 prefix /api/v2 with https://internal.example:8443/api/v2/..%2fadmin. Then, only on loopback, insert one Active in-org connection whose scheme is http, authority is 127.0.0.1, path_prefixes is [/api/v2], and bearer is a dummy value. Serve a fixture that records the raw request-target and whether that dummy bearer arrived, and returns 204. Invoke authorized_json GET http://127.0.0.1:<port>/api/v2/..%2fadmin. The host side holds if the recorded target is still /api/v2/..%2fadmin and the dummy bearer is present. Do not treat that as proof a decoder maps it to /admin.

Owner-observed plan:

Do not use a production token and do not store response bodies. With a non-production Cloudflare Origin CA token, compare only the HTTP status and top-level JSON keys of GET https://api.cloudflare.com/client/v4/certificates/%2e%2e%2fuser/tokens/verify to a direct GET of /client/v4/user/tokens/verify. If both are the token-verify success shape, the prefix did not hold. With a Doppler service token for a dummy project, compare only the status codes of GET https://api.doppler.com/v3/projects/%2e%2e%2fconfigs/config/secrets?project=<p>&config=<c> and GET /v3/configs/config/secrets with the same query. Matching non-404 statuses means the values path was reached. Stop after that comparison.

## Role evidence fence does not bind observation control or one-shot log reads

Fingerprint: `gateway/observation-control/role-evidence-fence-skipped`.

Browser observe tails re-read config_authorization_roles before releasing a sealed event: a missing row, a null role, or an auth_time that is not strictly after evidence_after ends the stream. That row is the Host membership ceiling provisioned for a sync pairing or device approval. set_role updates the ceiling and moves evidence_after forward, and on a null role deletes only project access; it does not revoke the browser client, stored authentication_json, in-memory session, or an authorized elevation. narrow_identity_role enforces the fence only when browser.authenticate is consumed, so a later step-up at or before the floor fails, but step_up keeps treating already stored phishing-resistant webauthn as fresh for 300 seconds. Control challenge, verify, commit, and control_with_host_authorization never read the row, so the same browser can mint or consume a handoff, take, or release elevation after the ceiling is cleared or the floor moves. GET /api/v1/agent/runs/{id}/log returns that run's sealed payloads after load(Attachment::View) and never calls StreamAuthority::active. NativeSession active reloads only the in-memory session. No gateway request of this sequence was executed.

Claimed root cause: StreamAuthority::active enforces a non-null config_authorization_roles role and auth_time greater than evidence_after only for CredentialKind::BrowserGrant. step_up, agent.browser.control challenge and verify, control_with_host_authorization, NativeSession active, and read_log do not read that row. set_role_ceiling does not revoke browser clients, grants, stored authentication_json, sessions, or host elevations. narrow_identity_role applies the fence only to browser.authenticate.

Trace:

- entrypoint: `crates/gateway/src/routes/agent_runs/lease.rs:177` `take_control` — POST /api/v1/agent/runs/{id}/control loads the run as Attachment::Control, which calls step_up, then commits a take elevation. Handoff and release use the same commit path.
- propagation: `crates/gateway/src/routes/agent_runs.rs:128` `step_up` — step_up is fresh only for a BrowserGrant with phishing-resistant webauthn, amr webauthn, and auth_time inside 300 seconds. Those claims come from stored authentication_json. The role ceiling and evidence_after floor are not read.
- propagation: `crates/gateway/src/routes/agent_runs/lease.rs:65` `commit` — commit requires a BrowserGrant and a 64-hex elevation, hashes that elevation, and calls control_with_host_authorization. It does not read config_authorization_roles.
- sink: `crates/storage/src/host_authorizations.rs:193` `control_with_host_authorization` — After the consume update matches, this statement writes control_state, quiescence, handoff_queued, lease holder, and lease expiry on the open run. Neither statement joins config_authorization_roles.

Evidence:

- `crates/gateway/src/routes/agent_run_stream_authority.rs:55`: Browser active returns false when role_policy has a null role or when the reloaded grant auth_time is less than or equal to evidence_after. A missing policy row also returns false.
- `crates/gateway/src/routes/agent_run_stream_authority.rs:60`: The NativeSession branch reloads only the in-memory session map and does not call role_policy.
- `crates/gateway/src/routes/agent_runs.rs:132`: step_up's freshness predicate is assurance, amr webauthn, and a 300-second auth_time window, with no role or evidence_after comparison.
- `crates/gateway/src/routes/host_authorizations.rs:75`: The agent.browser.control challenge requires phishing-resistant assurance, an open run, and owner equality. It does not read config_authorization_roles.
- `crates/storage/src/host_authorizations.rs:140`: narrow_identity_role runs only in the browser.authenticate branch. The agent.browser.control branch does not call it.
- `crates/storage/src/host_authorizations.rs:178`: The consume UPDATE matches client, elevation digest, operation, target, transition, version, state, expiry, an unrevoked client, an unexpired grant, organization, and run owner. It does not join config_authorization_roles.
- `crates/gateway/src/routes/agent_runs/stream.rs:106`: read_log authorizes with load(Attachment::View) and then reads observation events. It never calls StreamAuthority::active.
- `crates/gateway/src/routes/secret_config_policy.rs:111`: set_role calls set_role_ceiling with evidence_after set to the current timestamp. The handler does not revoke browser clients, grants, sessions, or host elevations.
- `crates/connection-broker/src/config_access.rs:163`: A null role deletes that principal's config_project_access rows and appends a role_changed outbox event. It does not revoke browser grants or elevations.
- `crates/gateway/src/routes/browser_pairings.rs:328`: session_claims copies assurance, auth_time, and the verified capability ceiling from stored authentication_json and does not read config_authorization_roles.

Blockers:

- No prebuilt opensesame-gateway test binary or cargo target directory is present. The approved sandbox allows 25s CPU, 1 GiB virtual memory, a read-only /workspace and /usr, and scratch-only writes, which cannot compile this commit or execute POST /api/v1/agent/runs/{id}/control or GET /api/v1/agent/runs/{id}/log.
- Source shows no role predicate on those handlers, but the decisive fact is unobserved: the HTTP status and whether a dummy observation_runs row changes version and control_state, and whether GET /log still returns the sealed payload, after role is null or evidence_after equals the stored auth_time.

Local plan:

Use the in-crate agent_runs Browser fixture, a temporary sqlite file, and dummy principals only. Provision config_authorization_roles, seed an awaiting_human run owned by the paired principal, and append one observation event. Call verified_webauthn_at with the current timestamp before changing policy, so browser.authenticate passes narrow_identity_role and stores authentication_json. Then set role to NULL and evidence_after to now without revoking the browser client. Only after that update, mint a take elevation through Browser::elevation, which calls authorize_host_challenge, and POST /api/v1/agent/runs/{id}/control with that 64-hex elevation. Do not treat HTTP 409 as success or failure: commit maps every zero-row consume to stale_version. The fence holds only if observation_runs.version and control_state stay unchanged. Repeat with the role left non-null and evidence_after set equal to the stored auth_time, minting the elevation only after the floor moves. GET /api/v1/agent/runs/{id}/log with the same browser DPoP headers; the fence holds only if the stored event's sealed payload is absent. GET /observe on that browser is the existing positive control. Separately record whether a native opaque session for the same owner still receives GET /observe events after role is NULL. Do not contact a deployed host or use production principals.

Owner-observed plan:

No deployed IdP, browser, certificate, or live host is required. The grant, authentication_json, and authorized elevation are local rows, and set_role performs the same policy write as the test update. Replay the dummy sequence only to compare a running binary that is not commit a8843c3e33ae1049aaf174be8ae539c421642940, and only against a disposable organization and principal.

## Windows open_url passes a Host authorization_url to cmd.exe /C start

Fingerprint: `opensesame.cli.connect.open_url.authorization-url-cmd-start`.

connect create calls authorize_oauth for a configured oauth2_authorization_code connection that is not yet active. authorize_oauth takes the Host field authorization_url as a raw string and, unless --no-browser, passes it to open_url. open_url does not parse a scheme or reject command metacharacters. Its Windows branch is Command::new("cmd").arg("/C").arg("start").arg(url). start is a cmd.exe builtin, so the Host string is placed on a cmd command line rather than passed to a URL-only API. The broker's assert_transport_allowed allows only https, plus non-production loopback http, and only for URLs that crate builds; build_authorize_url then joins query pairs with raw &. Custom-provider https_url forbids a query and a fragment but not & in the path. The CLI never applies those checks: api() accepts any JSON object. The Host base URL is not loopback-only (default http://127.0.0.1:8787, overridable with --server or OPENSESAME_HOST_API). The architecture treats loopback as same-machine authority, which calibrates a purely local Host and does not cover a remote Host response used as a command line. This Linux host compiles the xdg-open arm, and cmd.exe was not executed. connect open reaches the same opener with a pages URL and is omitted so the trace has one entrypoint.

Claimed root cause: The Windows arm of open_url is Command::new("cmd").arg("/C").arg("start").arg(url) with the Host authorization_url left unmodified. This crate adds no scheme allowlist, no empty start window title, and no cmd metacharacter escaping before Command::arg. The client treats the authorize JSON string as trusted and does not enforce the broker's https-or-nonproduction-loopback-http rule.

Trace:

- entrypoint: `apps/cli/src/connect.rs:603` `authorize_oauth` — The Host POST /api/v1/connections/{id}/authorize JSON field authorization_url is taken with as_str and is not parsed as a URL.
- propagation: `apps/cli/src/connect.rs:609` `authorize_oauth` — Unless --no-browser, which is a clap flag that defaults off, the raw authorization_url is passed to open_url.
- propagation: `apps/cli/src/connect.rs:1358` `open_url` — When target_os is windows, the opener prefix is cmd, /C, start. macOS uses open and every other target uses xdg-open. The windows arm is not the branch compiled on this Linux host.
- sink: `apps/cli/src/connect.rs:1370` `open_url` — The Host string is appended with arg and the process is spawned. On Windows that command line is cmd.exe /C start followed by authorization_url.

Evidence:

- `apps/cli/src/connect.rs:603`: authorization_url is required only to be a JSON string. No scheme, host, or metacharacter check follows before it is opened.
- `apps/cli/src/connect.rs:56`: no_browser is a clap bool flag with no default_value, so the browser-open path is the default for connect create.
- `apps/cli/src/connect.rs:1358`: The Windows arm sets the argv prefix to cmd, /C, start and does not quote or filter the caller string in this function.
- `apps/cli/src/connect.rs:1370`: spawn uses Command::arg(url) and discards the result. This crate does not insert an empty start title or escape the string.
- `apps/cli/src/connect.rs:1303`: A non-empty Host body is serde_json::from_str into a Value, or a raw wrapper. AuthorizeResponseSchema is not applied.
- `crates/connection-broker/src/flow.rs:70`: The scheme match accepts https, and non-production loopback http, and rejects every other scheme. It does not inspect &.
- `crates/connection-broker/src/flow.rs:131`: append_pair starts the authorize query at response_type=code. The following pairs are client_id, redirect_uri, state, code_challenge, and code_challenge_method, so the serialized URL contains raw & separators.
- `crates/connection-broker/src/custom_provider.rs:103`: This check rejects a custom authorize URL that already has a query or a fragment. It does not reject & in the path.
- `spec/config/endpoints.json:8`: The Host API default address is http://127.0.0.1:8787.
- `spec/config/endpoints.json:17`: The Host endpoint sets loopbackOnly to false, so the CLI is not pinned to a same-machine peer.

Blockers:

- This host is Linux. cmd.exe and Wine are not installed, rust-src for the 1.88 toolchain is not installed, and cfg!(target_os = "windows") is false, so the compiled open_url branch is xdg-open. Windows CreateProcess quoting and cmd.exe parsing were not executed.
- The decisive fact is whether cmd.exe /C start, given the single argument Rust Command::arg produces, treats a normal authorization_url that contains &, a path containing & around a command, or a non-URL command string, as more than one command. A Linux xdg-open result does not answer that.

Local plan:

On a Windows machine, in an empty temp directory, spawn only the same argv as open_url: Command::new("cmd").arg("/C").arg("start").arg(value), with no Host, no token, and no production server. Use a marker whose only effect is creating an empty file in that temp directory, then delete it. Test three values: (1) https://example.invalid/authorize?response_type=code&client_id=dummy ; (2) the marker command alone; (3) https://example.invalid/x&MARKER&y where MARKER is that create-file command and contains no further metacharacters. Record whether the marker file is created and whether cmd reports a second command. Do not change system settings or contact a real provider.

Owner-observed plan:

No production deployment, signing check, installer ACL, or device policy is required. A local Windows build of this CLI, or a throwaway copy of open_url, plus a stub authorization_url string, is enough.

## Compose publishes the NATS client port with no host IP and no server auth config

Fingerprint: `ops/compose/docker-compose.yml/nats/plaintext-host-port`.

ops/compose/docker-compose.yml is the file ops/README.md tells operators to start for local or HA-shaped runs. Its default-profile nats service uses image nats:2.11.4 and command ["-js", "-m", "8222"] with no volume, listen address, or authorization argument, then publishes container port 4222 as "4222:4222", which names no host IP. Monitoring port 8222 is not published. That service does not load ops/nats/local-dev.conf, whose comment says the plaintext profile authenticates nobody and must not be exposed beyond loopback, and whose listen directive is 127.0.0.1:4222. The same compose file sets gateway OPENSESAME_TASKBUS=nats and NATS_URL=nats://nats:4222 and sets no OPENSESAME_NATS_* variables. When those variables are unset, NatsTransportSpec::from_env returns None, create_nats uses NatsTransportSpec::plaintext, and it provisions because the profile is not secure. normalized() accepts a plaintext nats:// URL without requiring the dialed host to be loopback; on that branch it does refuse client identity, credentials, and tls_first. Stock gateway startup does not reach a connect: AppState::build calls StartupSecurity::load first, and from_env rejects this file because OPENSESAME_ENV and NODE_ENV are unset. The file also sets OPENSESAME_LISTEN=0.0.0.0:8787 and http://keycloak and http://gateway endpoints, which classify as networked, so a mode override would still hit the HTTPS safeguard, and assert_tcp_listen_allowed would still reject that listen without OPENSESAME_ALLOW_NONLOCAL=1. The worker service is behind the workload profile and does not set NATS_URL. Operator docs describe the compose client port as 4222 and show a host URL of nats://127.0.0.1:4222, which does not pin the published host IP. The file header calls the stack local/HA-capable and says to replace tags with digests in production; it does not label this publish as an accepted non-loopback exception. ops/README.md says to adapt the reference rather than adopt it wholesale, which also does not set the bind. Whether the unpinned Docker publish binds beyond loopback, and whether the nats:2.11.4 image accepts an unauthenticated client for this command, is not in the repository. Docker is not installed here and compose was not started.

Claimed root cause: ops/compose/docker-compose.yml runs nats:2.11.4 with command ["-js", "-m", "8222"], no mounted authorization or listen config, and ports ["4222:4222"] with no host IP, instead of the 127.0.0.1 listener in ops/nats/local-dev.conf, and points the gateway task bus at nats://nats:4222 with no OPENSESAME_NATS_* settings.

Trace:

- entrypoint: `ops/compose/docker-compose.yml:54` `service nats` — Default-profile service nats in the compose file operators start from ops/README.md. A non-compose peer is the lower-trust caller; this service is the in-repo entry that offers that caller a client port.
- propagation: `ops/compose/docker-compose.yml:56` `nats command` — The compose command is only ["-js", "-m", "8222"]. No config is mounted and no listen or authorization argument is set, so ops/nats/local-dev.conf is not applied. The image entrypoint that receives those arguments is not in this repository.
- sink: `ops/compose/docker-compose.yml:57` `nats ports` — Container port 4222 is published as short syntax 4222:4222, which sets no host IP. That is the source-visible boundary. The file does not show whether the orchestrator binds the publish beyond loopback.

Evidence:

- `ops/compose/docker-compose.yml:1`: The file header calls this a local/HA-capable compose profile and says to replace tags with digests in production. It does not say the NATS publish may bind beyond loopback.
- `ops/compose/docker-compose.yml:55`: The nats service image is nats:2.11.4. The service has no volumes key and does not mount ops/nats/local-dev.conf or any other server config.
- `ops/compose/docker-compose.yml:56`: The command is ["-js", "-m", "8222"] with no -a, -c, user, or authorization flag.
- `ops/compose/docker-compose.yml:57`: The only published NATS port is "4222:4222". Monitoring port 8222 is not in ports.
- `ops/compose/docker-compose.yml:68`: Gateway OPENSESAME_LISTEN is 0.0.0.0:8787, and the next lines set OPENSESAME_ISSUER and OPENSESAME_RESOURCE to http://keycloak:8080/realms/opensesame and http://gateway:8787. OPENSESAME_ENV, OPENSESAME_ALLOW_NONLOCAL, and OPENSESAME_NATS_* are not set.
- `ops/compose/docker-compose.yml:72`: OPENSESAME_TASKBUS=nats and the next line NATS_URL=nats://nats:4222 are set with no OPENSESAME_NATS TLS or credential variables.
- `ops/compose/docker-compose.yml:88`: The worker service is behind profiles ["workload"] and its environment does not set NATS_URL or OPENSESAME_TASKBUS.
- `ops/README.md:5`: ops is a reference operators are expected to adapt rather than adopt wholesale. That sentence does not set a host IP on the NATS publish.
- `ops/README.md:9`: The documented invocation is docker compose -f ops/compose/docker-compose.yml up for local or HA-shaped runs, and it names this NATS service.
- `ops/nats/local-dev.conf:14`: The plaintext profile comment says never to expose the listener beyond loopback because it authenticates nobody.
- `ops/nats/local-dev.conf:16`: The same file binds listen to 127.0.0.1:4222. The compose nats service does not load this file.
- `docs/operators/local.md:199`: Operator docs describe compose NATS as client port 4222 with monitoring 8222 inside the container network.
- `docs/operators/local.md:207`: The same section shows a host URL of nats://127.0.0.1:4222, or nats://nats:4222 inside Compose. It does not show a non-loopback host bind.
- `crates/task-bus/src/nats_transport_env.rs:112`: from_env returns None when no OPENSESAME_NATS_* transport variable is set, so the caller falls back to the default profile.
- `crates/task-bus/src/lib.rs:234`: create_nats uses NatsTransportSpec::from_env and otherwise NatsTransportSpec::plaintext, and the next line provisions because the profile is not secure.
- `crates/task-bus/src/nats_transport.rs:174`: When require_tls is false, normalized() returns Ok for a plaintext URL without checking that the dialed host is loopback. The same branch refuses a client identity, non-none auth, or tls_first.
- `crates/task-bus/src/nats_delivery.rs:107`: Provisioning keeps an existing stream's subjects and any limit already set, and only fills limits an older release left unbounded. That path runs only if a client connects and provisions.
- `crates/gateway/src/app_state.rs:160`: AppState::build calls StartupSecurity::load before later setup, so a startup rejection happens before a task-bus connect.
- `crates/host-core/src/deployment_mode.rs:68`: from_env fails when OPENSESAME_ENV and NODE_ENV are unset and OPENSESAME_ALLOW_DEV_DEFAULTS is not the local-only development opt-in. The compose gateway sets none of those.
- `crates/host-core/src/deployment_mode.rs:119`: classify marks a non-loopback listen address, or an HTTP(S) endpoint whose host is not loopback or localhost, as networked.
- `crates/gateway/src/config.rs:236`: When production safeguards apply, StartupSecurity::load rejects a networked endpoint that does not start with https://.
- `crates/host-core/src/daemon.rs:34`: assert_tcp_listen_allowed rejects a non-loopback listen string unless OPENSESAME_ALLOW_NONLOCAL=1. Compose does not set that override.

Blockers:

- Docker is not installed and this audit must not start compose. The short syntax "4222:4222" does not name a host IP, and the repository does not pin a Docker Engine or Compose version. Whether that publish binds 0.0.0.0, localhost, or a daemon ip setting, and whether a firewall, rootless mode, or userland proxy restricts it, is not source-visible.
- The nats:2.11.4 image and its entrypoint are not in this repository, and nats-server is not installed. The compose command supplies no config file and no authorization or listen flag. Whether that image accepts a client with no credentials, and where monitoring port 8222 binds inside the container, was not observed. ops/nats/local-dev.conf documents a different profile that this service does not load.

Local plan:

On an isolated host with Docker, no extra firewall, and no route to a shared or production network, render `docker compose -f ops/compose/docker-compose.yml config` and record the nats service's published host IP and port. Start only that service with `docker compose -f ops/compose/docker-compose.yml up -d nats`. Record `docker compose -f ops/compose/docker-compose.yml port nats 4222`. From a second network namespace, open TCP to the host's non-loopback address on the published port and read only the NATS INFO line. If and only if that line shows authentication is not required, on this fresh server only, publish and subscribe once with no credentials on the dummy subject opensesame.events.test, then remove the container. Do not start the other compose services and do not use an operator token or any real credential.

Owner-observed plan:

On the host that actually runs this file, read only `docker compose -f ops/compose/docker-compose.yml port nats 4222` and the host socket's bind address. Record any firewall, rootless Docker, or published-port IP override that is not in the repository. If the broker might already hold operator data, do not publish, subscribe, or create streams; a non-compose peer may only read the NATS INFO banner to see whether authentication is required. Do not send credentials.
