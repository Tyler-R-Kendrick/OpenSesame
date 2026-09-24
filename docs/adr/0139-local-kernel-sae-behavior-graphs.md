# ADR 0139 — One local kernel with SAE steering driven by behavior state graphs

- Status: Proposed
- Date: 2026-09-24
- Builds on: [ADR 0138](0138-self-issued-identity-one-native-host.md) (one
  native host; the kernel is a crate it links),
  [ADR 0083](0083-browser-plane-inference-fallback.md) (model planes, weights
  as consented egress), [ADR 0088](0088-ai-native-contextual-support.md)
  (model output is untrusted, deterministic runtimes drive it),
  [ADR 0130](0130-operator-controlled-capability-composition.md) (optional
  code loads only after consent), [ADR 0087](0087-vault-item-type-plugins.md)
  (behavior as a manifest, not a code path)
- Plan: [docs/implementation/local-kernel](../implementation/local-kernel/README.md)

## Context

We want to shape how a model behaves the way game design shapes a
character: a state graph — calm, curious, guarded, refusing — whose states
change what the character does and whose transitions fire on what it
perceives. For a language model, the direct lever is its internal
activations. A sparse autoencoder (SAE) trained on one layer's residual
stream turns those activations into features that are individually
readable (a feature fires when the model represents a concept) and
individually writable (adding a feature's decoder direction pushes the
model toward it). Features are therefore both the sensors and the
actuators a behavior graph needs.

Steering needs access to the residual stream, and nothing we use today has
it. Every model plane in the product is text in, text out: the Chrome
Prompt API, Ollama or LM Studio over loopback, and the hosted support path
(`packages/app-core/src/tutorial/agents/`). There is no AI gateway; the Host
broker's OpenAI and Anthropic connectors are credential passthroughs. No
hosted provider we route to exposes activations; the one hosted
feature-steering API (Goodfire Ember) has had its SDK archived since
2025-10-13. Open-weight models with published SAEs do exist: Google's Gemma
Scope 2 covers every size of Gemma 3, 270M through 27B, with JumpReLU SAEs
on the residual stream of every layer, including instruction-tuned
variants.

The targets are mostly phones and some custom Raspberry Pis, and the owner
wants the same minimal distribution on every platform. llama.cpp can read
intermediate tensors (its eval callback) and add fixed vectors (control
vectors), but it is a large general runtime, and steering through it is
callback plumbing. Engines that target devices — ExecuTorch, LiteRT-LM,
MLC — run compiled graphs that do not expose the residual stream at all.

## Decision

### 1. One kernel crate, one architecture, every platform

`crates/kernel` is a small Rust inference engine that implements one model
architecture, Gemma 3 text, and owns its forward pass. It builds, from the
same source, for:

| Target | How it ships |
|---|---|
| Android, iOS | A library through UniFFI, as `crates/authenticator-core` already does for `apps/authenticator-native` |
| Raspberry Pi (aarch64 Linux), desktop | Linked into `opensesame` (ADR 0138): `opensesame kernel run`, and the host's local API |
| Browser (the PWA) | wasm32 with SIMD128, loaded as an optional capability under ADR 0130 |

It reads one quantized weight format, carries its own tokenizer and a
minimal sampler, uses NEON on ARM, SIMD128 in wasm and a portable fallback
elsewhere, and keeps third-party dependencies to a budget that a gate
checks, as the daemon's is (ADR 0048 §5). It is not a general runtime: a
second architecture is a new decision, not a flag.

Owning the forward pass is what makes steering cheap. A hook at a chosen
layer sees the residual vector for each token and may add to it; there is
no callback protocol.

### 2. Only the features a graph uses are shipped

Gemma Scope 2's SAEs are JumpReLU: each feature's activation depends only
on its own encoder row, bias and threshold. A behavior pack therefore
carries just the rows it references — the encoder rows of the features it
senses and the decoder rows of the features it steers — not the SAE. At
Gemma 3 270M (residual width 640, fp16), a full 16k-feature SAE is about
42 MB; 64 sensed and 64 steered features are about 160 KB. Per token,
sensing is 64 dot products of length 640 and steering is one vector add.

A state's steering (feature, strength) pairs are summed into one vector
per hooked layer when the pack is compiled, so switching state is swapping
a precomputed vector.

### 3. Behavior state graphs are data, evaluated deterministically

A behavior graph is a hierarchical state machine in a declarative,
versioned format:

- **states**, each with a steering profile (features and bounded
  strengths), optionally nested, with a priority so an interrupt state
  (for example "guarded") overrides its siblings;
- **sensors**, each a feature with an activation threshold, hysteresis
  and a minimum dwell, so a transition cannot flicker on one noisy token
  (the standard game-AI remedy);
- **transitions**, each a guard over sensor edges, external events the
  host raises (a turn began, the user said something, a timer), and time
  in state.

The kernel evaluates the graph, never the model. A model's output cannot
edit the graph, choose a state, or raise an event. A pack is validated
before it loads: every state reachable, every referenced feature present,
strengths within the pack's declared bounds. A malformed pack is refused
whole, as GuideLang programs are (ADR 0088).

Steering shapes behavior; it confers nothing. A graph cannot name a tool,
a capability, a grant or a connection, and no state widens what the model
or its host may do. Authority stays where ADRs 0005, 0120 and 0130 put it.

### 4. Remote models are retrieval, never the voice

When a remote model is used, it answers as a source, not as the
character. Its output enters the local model's context as quoted
retrieval with provenance, and the steered local kernel writes the
response. The request is egress under ADR 0083 and needs the same consent.
Remote output never raises a graph event or reaches a sensor except
through the local model's own activations while it reads that text.

A remote endpoint is steerable only when it is our kernel: the ADR 0138
host exposes the kernel over its API, so a phone can steer a model running
on a Raspberry Pi on the same tailnet. No third-party gateway is assumed to
support steering.

### 5. Packs are content-addressed and consented

A model pack (weights and tokenizer) and a behavior pack (graph and
feature rows) are each pinned by sha256 in a manifest, as item types are
in `.opensesame/marketplace.json` (ADR 0134). A download is egress and
needs consent; skipping never starts one (ADR 0083 §3). Model packs live
outside the app bundle, so bundle budgets are unaffected; the kernel's
wasm build has its own budget.

## Consequences

- One kernel, one model family and one pack format run on phones,
  Raspberry Pis, desktops and the PWA. Behavior is authored once.
- We own a transformer implementation. Correctness is proven against
  reference logits and reference SAE activations committed as fixtures;
  performance is held to per-device budgets.
- Model quality is Gemma 3 270M or 1B on phones and Pis. Remote models can
  make it better informed through retrieval, never better spoken.
- SAE features are noisy and sometimes polysemantic. Strengths are bounded
  per pack, and every pack ships with an evaluation that shows its steering
  moves the targeted features without breaking fluency.
- Gemma 3 weights come under Google's Gemma terms; the Gemma Scope 2
  release carries its own license. Both need review before we
  redistribute packs.

## Open questions

1. Hook placement: one mid-depth layer (simplest, what Gemma Scope's
   sweeps favor), or several?
2. Should behavior packs be marketplace entries beside item types, or a
   separate catalog?
3. Do we train SAEs of our own for a smaller or fine-tuned model later,
   or stay on Gemma Scope 2's published ones?
