# Local kernel with SAE steering — implementation plan

The work behind [ADR 0139](../../adr/0139-local-kernel-sae-behavior-graphs.md):
one small Rust inference kernel for Gemma 3 that runs unchanged on phones,
Raspberry Pis, desktops and the PWA; sparse-autoencoder features as its
sensors and actuators; behavior state graphs that the kernel evaluates;
remote models used only as retrieval.

It depends on [ADR 0138](../../adr/0138-self-issued-identity-one-native-host.md)
only for the host integration (phase 4). Phases 1–3 stand alone.

## Where things stand

| Area | Today | Source |
|---|---|---|
| Local inference | Chrome Prompt API, Ollama / LM Studio over loopback; text only, no sampling controls | `packages/app-core/src/tutorial/agents/prompt-api/`, `.../provider/provider-agent.ts`, `lib/browser-inference.ts` |
| Hosted models | AG-UI support endpoint behind the Identity API; the Host broker's OpenAI / Anthropic connectors are credential passthroughs | `tutorial/agents/ag-ui/`, `apps/control-plane/src/services/support-proxy.ts`, `crates/connection-broker/src/catalog.json` |
| Model internals | Nothing in the workspace reads hidden states, and no inference library is a dependency | workspace manifests |
| Deterministic runtimes | GuideLang and its runtime (ports only, closed outcomes) | `packages/guide-lang`, `packages/guide-runtime` |
| Native bindings | UniFFI already builds `authenticator-core` for Android and iOS | `crates/authenticator-core`, `apps/authenticator-native/scripts/build-core.sh` |
| Pinned downloads | Marketplace manifest with sha256 per entry | `.opensesame/marketplace.json`, `scripts/release/pin-marketplace.mjs` |

## Target

```
crates/
  kernel/            forward pass, weights, tokenizer, sampler, residual hook (no model-specific deps)
  kernel-sae/        feature pack format, JumpReLU sensing, steering vectors
  behavior-graph/    graph format, validator, compiler, deterministic evaluator
  kernel-ffi/        UniFFI surface for Android and iOS; wasm-bindgen surface for the PWA
apps/cli             `opensesame kernel run|compile|eval` (and the ADR 0138 host API)
packages/
  kernel-web/        loads the wasm build as an ADR 0130 capability; OPFS pack store
marketplace/
  behaviors/         behavior packs (graph + feature rows), pinned like item types
```

A model pack (quantized weights plus tokenizer, a few hundred MB) is never in
the repository or an app bundle; its manifest entry pins its sha256 and its
source.

## The pack formats

**Model pack.** One file per model: a header (architecture `gemma3`, sizes,
quantization), the tokenizer, then tensors in a fixed order. Quantization is
Q8_0 to start (a scale per block of 32), Q4_0 once golden tests pass. We
convert from the reference checkpoint with a one-shot tool and pin the
output; the kernel reads only this format.

**Behavior pack.** Authored as JSON, compiled to a binary the kernel maps:

```json
{
  "apiVersion": "opensesame.dev/v1alpha1",
  "kind": "BehaviorGraph",
  "model": { "pack": "gemma-3-270m-it-q8", "sha256": "…" },
  "sae": { "release": "gemma-scope-2-270m-it", "site": "resid_post", "layer": 9, "width": "16k" },
  "sensors": {
    "hostility": { "feature": 10423, "on": 18.0, "off": 11.0, "dwellTokens": 4 },
    "confusion": { "feature": 2210, "on": 9.5, "off": 6.0, "dwellTokens": 6 }
  },
  "states": {
    "calm":    { "steer": { "5518": 4.0 } },
    "curious": { "steer": { "5518": 2.0, "7741": 6.0 } },
    "guarded": { "priority": 10, "steer": { "13002": 8.0, "7741": -4.0 } }
  },
  "initial": "calm",
  "transitions": [
    { "from": "*", "to": "guarded", "when": { "sensor": "hostility", "edge": "on" } },
    { "from": "guarded", "to": "calm", "when": { "sensor": "hostility", "edge": "off" }, "minTurns": 2 },
    { "from": "calm", "to": "curious", "when": { "sensor": "confusion", "edge": "on" } },
    { "from": "curious", "to": "calm", "when": { "event": "turn.end" } }
  ],
  "bounds": { "maxStrength": 10.0 }
}
```

(The feature numbers above are placeholders; authoring picks real ones.)

The compiler checks every state is reachable, every transition's guard
names a declared sensor or event, strengths stay within `bounds`, and there
is no transition cycle that fires within one token. It then writes the
encoder rows, biases and thresholds of the sensed features, and one summed
steering vector per state.

## Phases

### Phase 0 — Decide and clear the ground

- Accept ADR 0139.
- License review of Gemma 3 and Gemma Scope 2 for redistributing converted
  packs; record the outcome in `docs/reference/reuse.md`.
- Pick the reference devices and write their budgets into
  `tools/quality/kernel-budgets.json`: Raspberry Pi 5 (8 GB) and one
  mid-range Android and iPhone, each with a tokens-per-second floor and a
  peak-memory ceiling for Gemma 3 270M and 1B.

### Phase 1 — The kernel

- `crates/kernel`: the Gemma 3 text forward pass (embedding, RMSNorm, RoPE
  with the local/global layer mix and sliding window, grouped-query
  attention with a KV cache, gated MLP, tied output), the model-pack reader
  (memory-mapped where the platform allows), the tokenizer, and a sampler
  (greedy, temperature, top-p).
- The residual hook: `fn at_layer(&mut self, layer: usize, pos: usize,
  resid: &mut [f32])`, called once per token per registered layer.
- Kernels for NEON, SIMD128 and portable Rust; single-threaded first, then
  a fixed worker pool.
- A dependency budget gate like `daemon-deps-gate.sh`, checking the full
  tree.

**Exit:** golden fixtures — for a handful of prompts, the reference
implementation's top-k logits at every position and the residual at the
hooked layer, generated once offline and committed (small) — match within
tolerance on x86_64, aarch64 and wasm32. The budgets in
`kernel-budgets.json` pass on a Raspberry Pi 5.

### Phase 2 — SAE sensing and steering

- `crates/kernel-sae`: the feature-row format, JumpReLU encode over a
  feature subset (`f = a · [a > θ]`, where `a` is the release's encoder
  pre-activation — `W_enc·x + b_enc` for Gemma Scope), and steering-vector
  application through the phase 1 hook.
- A conversion tool that extracts chosen rows from a published Gemma Scope
  2 release.

**Exit:** on fixture prompts, sensed activations match the reference SAE
within tolerance; adding a feature's decoder direction raises that
feature's measured activation and changes generations as expected; an
evaluation harness (`opensesame kernel eval`) reports fluency (perplexity
on a held-out set) against steering strength, so each pack's `bounds` are
measured, not guessed.

### Phase 3 — Behavior graphs

- `crates/behavior-graph`: the JSON schema, validator and compiler above,
  and the evaluator: sensors with hysteresis and dwell, prioritized
  hierarchical states, transitions on sensor edges, host events and time.
  Per token the kernel senses, the evaluator steps, and the next token uses
  the new state's vector.
- A replay harness that runs a transcript through the graph and prints the
  state timeline, for authoring and for tests.

**Exit:** property tests (the evaluator is deterministic for a given
activation stream; no state flickers under noise inside the hysteresis
band; an unreachable or unbounded pack is refused); two example packs in
`marketplace/behaviors/` with replay fixtures.

### Phase 4 — The host and retrieval

- `opensesame kernel run` on the Raspberry Pi, and the kernel served by the
  ADR 0138 host so a phone can use a Pi's kernel across the tailnet.
- The retrieval path: a remote answer (from the Host broker's connectors or
  the AG-UI endpoint) enters the local context as a quoted source with
  provenance; the steered kernel writes the reply. Consent and egress follow
  ADR 0083.
- Capability-registry entries for the new verbs (ADR 0065).

**Exit:** an end-to-end test on a Pi where a hostile turn moves the graph to
`guarded` and the reply's sensed features confirm it; remote text never
raises a graph event directly.

### Phase 5 — Phones

- `crates/kernel-ffi` UniFFI bindings, built by the same script pattern as
  `authenticator-core`; the kernel inside `apps/authenticator-native`
  (`apps/android` after ADR 0138) with packs stored in app storage.

**Exit:** the phase 1 fixtures pass on device; the reference phones meet
their budgets; thermal throttling after ten minutes of generation stays
inside the budget's floor.

### Phase 6 — The PWA

- The wasm32 build loaded by `packages/kernel-web` as an optional ADR 0130
  capability (descriptor, module runtime, ownership rule, absence fixture);
  packs downloaded after consent into OPFS, never cached silently.
- The kernel's wasm size gets its own entry in
  `tools/quality/bundle-budgets.json`.

**Exit:** `pnpm --filter @opensesame/pages verify:capability-graph` shows the
kernel is unreachable before consent; `verify:static` is unchanged with the
capability off; the golden fixtures pass in headless Chromium.

## Risks

- **Owning a transformer.** A subtle mismatch (RoPE base, norm placement,
  the sliding window) degrades output silently. The golden logits and
  hooked-layer residuals are the defence; no phase ships without them on
  every target.
- **Small models.** Gemma 3 270M is weak on its own. Retrieval compensates
  for knowledge, not for reasoning; the 1B model is the default wherever the
  device budget allows.
- **Feature quality.** SAE features can be noisy or polysemantic, and strong
  steering hurts fluency. Measured bounds per pack and the replay harness
  are the controls.
- **Pack size on phones.** A 270M model at Q8 is a few hundred MB, most of
  it the 262k-token embedding table; Q4 for the embedding is the first
  lever.
- **Licenses.** Redistribution waits on the phase 0 review.
