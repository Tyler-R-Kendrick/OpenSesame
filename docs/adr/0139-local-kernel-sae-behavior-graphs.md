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

Steering needs the residual stream, and nothing we use today exposes it.
Every model plane in the product is text in, text out: the Chrome Prompt
API, Ollama or LM Studio over loopback, and the hosted support path
(`packages/app-core/src/tutorial/agents/`). There is no AI gateway; the Host
broker's OpenAI and Anthropic connectors are credential passthroughs. No
hosted provider we route to exposes activations, and the one hosted
feature-steering API (Goodfire Ember) has had its SDK archived since
2025-10-13.

The model family is **Qwen**. It has the most active SAE community, and the
Qwen team's own Qwen-Scope release publishes residual-stream SAEs for every
layer of Qwen3-1.7B, Qwen3-8B, Qwen3.5-2B and larger models (TopK, k = 50 or
100, 32K–128K features). Qwen3's small dense models are Apache-2.0. We will
train our own SAEs and fine-tune the models later, so the design cannot
depend on any one published SAE.

The targets are mostly phones and some custom Raspberry Pis, with the same
minimal distribution on every platform. General runtimes are the wrong
shape: llama.cpp reaches activations only through callbacks and fixed
control vectors, and device runtimes (ExecuTorch, LiteRT-LM, MLC) run
compiled graphs that hide the residual stream.

## Decision

### 1. One kernel, one architecture, every platform

`crates/kernel` is a small Rust inference engine that implements one model
architecture, **Qwen3 dense**, and owns its forward pass. It builds, from
the same source, for:

| Target | How it ships |
|---|---|
| Android, iOS | A library through UniFFI, as `crates/authenticator-core` already does |
| Raspberry Pi (aarch64 Linux), desktop | Linked into `opensesame` (ADR 0138): `opensesame kernel …` |
| Browser (the PWA) | wasm32 with SIMD128, loaded as an optional capability under ADR 0130 |

It knows nothing about SAEs or behavior. It exposes one extension point, a
hook called with the residual vector of each token at the layers it was
asked for, which may read and add to it. A second architecture (Qwen3.5, if
its layers differ) is one more file beside the first, decided when needed.

The kernel reads **standard formats**: weights are a safetensors file (int8
or int4 blocks with their scales, under our tensor names) and the tokenizer
is Qwen's own `tokenizer.json`. Anything that can open safetensors can
inspect a pack; we write no bespoke binary format.

### 2. Behavior is a separate crate that plugs into the hook

`crates/behavior` owns everything about character: loading SAE features,
sensing and steering through the kernel's hook, and evaluating the state
graph. The kernel never depends on it.

A behavior pack is two files: the graph (JSON, authored by a person) and the
feature rows it references (safetensors). Only the rows the graph uses are
shipped: the encoder rows and thresholds of sensed features, the decoder
rows of steered features. At Qwen3-1.7B (residual width 2048, fp16) one row
is 4 KB, so a graph over 128 features carries about 512 KB, against about
268 MB for a whole 32K-feature SAE.

Sensing a subset of features is exact for JumpReLU and ReLU SAEs, where each
feature's activation depends only on its own row. Qwen-Scope's SAEs are
TopK, where a feature fires only if it is among the k largest, which needs
the full encoder. For those, compilation calibrates a threshold per sensed
feature from the full SAE on a reference corpus, so the pack still carries
rows only; evaluation measures agreement against the full SAE. The SAEs we
train ourselves will be JumpReLU so the subset is exact.

Each state's steering (feature, strength) pairs are summed into one vector
per hooked layer at compile time; changing state swaps a vector.

### 3. Behavior state graphs are data, evaluated deterministically

A graph is a hierarchical state machine:

- **states**, each with a steering profile (features and bounded
  strengths), optionally nested, with a priority so an interrupt state
  overrides its siblings;
- **sensors**, each a feature with an on-threshold, a lower off-threshold
  (hysteresis) and a minimum dwell, so a transition cannot flicker on one
  noisy token;
- **transitions**, each a guard over sensor edges, events the host raises
  (a turn began, a timer fired) and time in state.

The behavior crate evaluates the graph, never the model. Model output cannot
edit the graph, choose a state or raise an event. A pack is validated before
it loads — every state reachable, every referenced feature present,
strengths within declared bounds — and a malformed pack is refused whole.

Steering shapes behavior; it confers nothing. A graph cannot name a tool, a
capability, a grant or a connection, and no state widens what the model or
its host may do.

### 4. Remote models are retrieval, never the voice

A remote model answers as a source, not as the character: its text enters
the local model's context as quoted retrieval with provenance, and the
steered local kernel writes the reply. The request is egress under ADR 0083.
A remote endpoint is steerable only when it is our kernel, served by the ADR
0138 host (a phone steering a model on a Raspberry Pi over the tailnet).

### 5. Our own SAEs and fine-tunes enter through the same two files

Training happens offline in `tools/model-lab/`, outside the product build.
A fine-tune is merged into the weights before conversion, so the kernel
has one weight path and no adapter runtime. An SAE is trained against the
exact weights it will steer: a fine-tune invalidates SAEs trained on the
base model until they are retrained or shown to transfer by the evaluation
in §2. The lab's only outputs are a model pack and an SAE file; the
converters that turn them into packs are in the product crates, so a pack
built from our lab and one built from a public release go through the same
checks.

### 6. Packs are content-addressed and consented

Model packs and behavior packs are pinned by sha256 in a manifest, as item
types are in `.opensesame/marketplace.json` (ADR 0134). Downloading a pack
is egress and needs consent; skipping never starts one (ADR 0083 §3). Model
packs are never in an app bundle.

## Consequences

- One kernel, one model family and one pair of pack formats run on phones,
  Raspberry Pis, desktops and the PWA. Behavior is authored once.
- Two crates with one seam between them: the kernel runs a model, behavior
  decides how it acts. Either can change without the other.
- We own a transformer implementation. Correctness is proven against
  reference logits and hooked-layer residuals committed as fixtures;
  performance is held to per-device budgets.
- Qwen3-1.7B at int4 is about 1 GB, fine on a Raspberry Pi 5 and current
  phones; Qwen3-0.6B fits older phones but has no published SAEs, so it
  waits for our own.
- SAE features are noisy and sometimes polysemantic. Strengths are bounded
  per pack, and every pack ships with an evaluation showing its steering
  moves the targeted features without breaking fluency.

## Open questions

1. Hook one mid-depth layer or several?
2. Behavior packs as marketplace entries beside item types, or a separate
   catalog?
3. Qwen3.5-2B instead of Qwen3-1.7B, once its layer types are confirmed to
   fit the kernel's single architecture?
