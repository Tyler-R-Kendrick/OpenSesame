# Validation

How OpenSesame is tested, how well, and the evidence each feature shipped
with. The test suites themselves are described in [`tests/`](../../tests/README.md).

## Strategy and gates

| Page | Covers |
|---|---|
| [Test strategy](test-strategy.md) | Which kinds of tests run, where each lives, and why the absent kinds are absent. |
| [Test coverage](test-coverage.md) | Coverage floors for both languages and the test-type matrix. |
| [PACT](pact.md) | The shared failure-scenario pattern: property, adversarial, chaos, contract. |
| [Structural quality gates](code-quality-gates.md) | File size, complexity and component-coupling ratchets — the working guide to `pnpm quality`. |
| [Fuzzing, proofs and concurrency](fuzzing.md) | cargo-fuzz, Jazzer.js, Kani, Miri and Shuttle: how to run each and what it covers. |
| [Keyboard navigation](keyboard-navigation.md) | The keyboard-access regression contract `verify:keyboard` enforces. |
| [Visual baseline review, 2026-10-05](2026-10-05-visual-baseline-review.md) | Why four Pages pixel baselines were replaced, the old and new hashes, and what stayed unchanged. |

## Feature evidence

What was run for each feature, and what the results do and do not show.

| Page | Feature |
|---|---|
| [AgentAuth conformance](agent-auth-conformance.md) | `auth.md` and agent registration against the RFCs. |
| [Agent Hooks conformance](agent-hooks-conformance.md) | OpenSesame's own runs as an Agent Hooks 0.1 host, against the upstream CTK ([ADR 0159](../adr/0159-agent-hooks-interceptor.md)). |
| [AI contextual support](ai-contextual-support.md) | The in-product assistant and GuideLang ([ADR 0088](../adr/0088-ai-native-contextual-support.md)). |
| [Ambient SSO](ambient-sso.md) | Opt-in automatic sign-in. |
| [Authentication service parity](authentication-service-parity.md) | The self-hosted authentication service against Passwordless.dev's concepts. |
| [Automatic certificate issuance](automatic-certificate-issuance.md) | Certificate-authority selection and issuance. |
| [Certificate manager](certificate-manager.md) | The certificate manager (ADRs 0066–0072): what exists in this checkout (the PKI engine, storage, authority, policy and profile routes, EST) and what is design only. |
| [Capability composition](capability-composition.md) | How each claim of [ADR 0130](../adr/0130-operator-controlled-capability-composition.md) is checked. |
| [Collaboration adapter](collab-adapter.md) | Projecting authority onto Discord roles. |
| [Customer envelope surfaces](customer-envelope-surfaces.md) | Per-surface status of customer-bound envelope encryption, and the validation still outstanding. |
| [DNS enforcement](dns-enforcement-coverage.md) | What DNS-layer enforcement measured, and what may be claimed from it. |
| [mTLS implementation](mtls-implementation.md) | Optional mTLS and workload identity ([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). |
| [Notification approvals](notification-approval-evidence.md) | External authorization notifications and approval ceremonies. |
| [Trust broker](trust-broker-implementation-evidence.md) | Assurance evaluation for approvals. |
| [2password parity gauntlet](2password-parity.md) | The parity gate against the 2password oracle, run over the native CLI, `opensesame-id` and the built PWA; a recorded run is [`2password-parity-result.json`](2password-parity-result.json). |
| [2password upstream review](2password-upstream-review.md) | The upstream pull requests and issues folded into that oracle. |
| [Wallet interaction traceability](wallet-interaction-traceability.md) | Requirement-to-test traceability for the wallet-native interaction layer, with machine-readable companions in [`evidence/wallet/`](../evidence/wallet). |
| [WebMCP](webmcp.md) | Native Chrome WebMCP support and how to verify it. |

Screenshots for user-visible changes are in [`docs/evidence/`](../evidence/README.md).
The first baseline runs of both planes (2026-08-07) are archived in
[`archive/2026-08-07-baseline/`](../archive/2026-08-07-baseline).
