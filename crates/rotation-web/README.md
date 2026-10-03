# opensesame-rotation-web

Web-login rotation for the Host / authority plane: the step IR, the tool
boundary a browser sandbox exposes, and the ordering of a password change that
must not be rearranged. The boundary's shape is the security property: no
method on `BrowserTransport` returns a credential value, so an agent driving a
run can say which credential goes where but has no signature that carries one
back. The same boundary read backwards (`CeremonyTransport`) holds the capture
verbs a registration ceremony needs; they seal what a page produced and answer
with a digest.

## Where it fits

- **Used by:** [`crates/gateway`](../gateway) — the Host's web-login runner
  (`src/web_login`) drives `run_change_password_hooked` over an
  `ExtensionTransport` whose `StepChannel` is the storage step queue
  ([`0025_runner_steps.sql`](../storage/migrations/0025_runner_steps.sql)), and
  its settle route decodes every driver outcome into `StepOutcome` and stores the
  canonical re-encoding; [`apps/cli`](../../apps/cli) — recipe parsing and
  signing (`recipe_doc`) for `rotate recipe` and `rotate signer`. The browser
  extension's runner (`apps/browser-extension/runner`) is the driver on the far
  side of the queue and does not link this crate; its outcome constructors mirror
  `StepOutcome` and are tested against the Host's settle route. The crate is also
  exercised by its own integration tests in [`tests/`](tests) (`ordering`,
  `ceremony_capture`, `ceremony_envelope`, `extension_transport`, the `hooked_*`
  suites, the CTK suites and the `login_surrogate_*` suites and `default_build`).
  It is not a fuzz target and is not in the authority-fabric gate.
- **Agent Hooks host:** `src/hooks/` emits agent-hooks/0.1 around its runs
  through the canonical core `agent-hooks-sdk` (pinned `=0.1.0-alpha.5`).
  `tests/agent_hooks_ctk.rs` (claim A, the run as a tool router: 4 of the 47
  vectors apply, 4 pass) and `tests/agent_hooks_ctk_mock_loop.rs` (claim B, the
  emission engine under a mock model and tools: 46 pass, 1 skipped for the
  undeclared `bigint_json`) run the vendored CTK corpus
  ([`spec/agent-hooks/conformance`](../../spec/agent-hooks/conformance)); the
  claims are [`docs/validation/agent-hooks-conformance.md`](../../docs/validation/agent-hooks-conformance.md).
- **Builds on:** [`opensesame-ceremony`](../ceremony) (capture slots and
  refusals) and [`opensesame-session-observe`](../session-observe) (frame
  admission, mask manifests, `UntrustedText`).
- No browser driver and no model client is a dependency. A remote CDP sandbox
  and a local browser extension are alternative transports, not forks.

## Surface

`run_change_password` is the ordering, in one function:

```text
generate candidate -> seal to vault -> WAIT for backup acknowledgement -> fill
  -> [critical] assert candidate present [FAIL-CLOSED] -> submit
  -> verify by fresh login -> promote
```

| Module | Items |
|---|---|
| `tools` | `BrowserTransport`, `CredentialRef`, `CandidateHandle`, `Filled`, `Presence`, `Verified`, `RedactedDom`, `AdmittedFrame`, `StepError` |
| `executor` | `run_change_password`, `ChangePasswordRecipe`, `CandidateVault`, `ActionStep`, `RunReport`, `RunOutcome`, `BlockedReason`, `ExecutorError` |
| `ceremony` | `CeremonyTransport`, `run_capture_steps`, `CaptureStep`, `CaptureVault`, `SealedCapture`, `CaptureReport`, `CaptureError` |
| `capture` | `classify`, `solve_mask`, `strip_targets`, `FieldSnapshot`, `Classification`, `ActionRecord`, `FrameRecord`, `ThoughtRecord` |
| `extension` | `ExtensionTransport`, `StepChannel`, `StepRequest`, `StepOutcome` — a fill carries a reference and a selector, never a value |
| `hooks` | `HookedTransport`, `HookSession`, `host_run`, `run_change_password_hooked`, `run_capture_steps_hooked`, `RunRequest`, `Refusal`, `BROWSER_VERBS`, `CEREMONY_VERBS` — each run as an agent-hooks/0.1 session ([ADR 0159](../../docs/adr/0159-agent-hooks-interceptor.md)): every verb bracketed by `pre_tool_call`/`post_tool_call`, plus startup, input, output and shutdown; a transform applies to content and never to authority (the credential reference, the capture slot and a navigation's origin are pinned, else `host_error:transform_invalid`); no lock is held across an interceptor or an approval; §5.4 labels resurfaced on later emissions; `HostedRunError::Refused` when nothing ran and `Withheld` when the run acted but its report was refused. The three custody steps are not hooked. A tool router in production: no model calls (the untyped `dynamic` surface exists for the mock-loop claim only) |
| `recipe_doc` | The signed web-login recipe document (ADR 0076 §4): strict closed JSON (a repeated member is refused), Ed25519 `verify_strict` over the domain tag `opensesame/web-login-recipe/v1\n` plus the RFC 8785 canonical JSON of the document without its signature, hex keys and signatures (no base64 in a default build), `rsk_` key ids derived from the public key, a document digest independent of the signature |
| `login_surrogate` (feature `login-surrogate`, off by default) | `LoginRoad`, `ArmedSubstitution`, `CdpOnly`, `SUBSTITUTION_PLUGIN`, `run_login`, `run_surrogate_login`, `SurrogateLoginTransport`, `LoginSubstitution`, `ResponseScrub`, `Refusal` and the rest of ADR 0150 §6.3 |

## Login-form substitution: an optional plugin feature

ADR 0150 §6.3 lets the agent browser log in with an `osr_` surrogate in the
page instead of the password: the runner's egress hook recognizes the
surrogate as the whole value of the one declared field of the one declared
POST, strips it and re-places the credential with the body format's own
encoder, and scrubs the credential from every response and DOM read. It is an
**optional runtime plugin** (ADR 0150 §7), so:

- **Not in a default build.** The whole `login_surrogate` module lives behind the
  `login-surrogate` cargo feature, which is off by default and pulls in the
  only dependencies substitution uses (`opensesame-plugin-settings`,
  `base64`, `secrecy`, `zeroize`). `serde_json` stays a normal dependency
  because the agent-hooks host uses it in every build. No workspace crate enables it
  in a normal build; only the `opensesame-surrogate-proxy` plugin binary may.
  `tests/default_build.rs` asks `cargo metadata` and `cargo tree` to prove
  it, and fails if the feature joins `default`, a dependency stops being
  optional, or a crate enables it.
- **One switch, shared with the proxy.** Login substitution has no switch of
  its own. It runs only while the `surrogate-proxy` plugin is installed,
  recorded on and not forced off, so Settings › Capabilities, `opensesame
  plugins enable|disable surrogate-proxy` and
  `OPENSESAME_PLUGIN_SURROGATE_PROXY=off` govern the proxy and the login form
  together. `LoginRoad::choose(declared, &plugin_state)` is that check, pure:
  the runner passes the `PluginState` it read with
  `opensesame_plugin_settings::PluginSettings::state("surrogate-proxy", env)`,
  and this crate reads no file. Only the `ArmedSubstitution` it returns can
  substitute, and `run_login` takes its answer, so a runner cannot reach
  substitution without the switch. A declaration the switch did not arm logs
  in by CDP fill, as before ADR 0150.
- **Its transport is the surrogate-proxy plugin.** The plugin arms each login
  a run declares with `LoginRoad::choose` over its own `PluginState`, and
  puts every request the child's browser sends through the proxy that
  carries a login surrogate to `ArmedSubstitution::egress`; login-origin
  responses go through `ResponseScrub` (`crates/surrogate-proxy/src/login*.rs`,
  ADR 0150 §6.3). The password comes from the person's sealed store, read by
  `opensesame dev run --agent` and sent to the plugin over its stdin.
- **Tested with the feature on.** The crate's dev-dependency on itself turns
  the feature on for every test build, so the Rust CI job's
  `cargo test --workspace --all-targets` and the workspace Clippy gate
  (`--all-features`) both cover it.

## Develop

```bash
cargo +1.88.0 test -p opensesame-rotation-web
cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk -- --nocapture            # claim A report
cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk_mock_loop -- --nocapture  # claim B report
```

`tests/ordering.rs` pins the sequence; the wait for backup acknowledgement and
the presence assertion are what separate a rotation from a lockout. Keep new
tool methods value-free.

## Related

- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — autonomous web-login rotation
- [ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) — agent-run registration ceremonies
- [ADR 0159](../../docs/adr/0159-agent-hooks-interceptor.md) — OpenSesame as an agent-hooks/0.1 interceptor and host (the hooked runs, the runner, recipes and signers); [conformance claims](../../docs/validation/agent-hooks-conformance.md)
- [ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) — surrogate credentials at the last hop (§6.3 login, §7 optional plugins)
- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — live session observation
- [`docs/architecture/web-login-rotation.md`](../../docs/architecture/web-login-rotation.md), [`docs/security/web-login-rotation-threat-model.md`](../../docs/security/web-login-rotation-threat-model.md)
