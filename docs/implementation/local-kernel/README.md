# Local kernel with SAE steering — implementation plan

The work behind [ADR 0139](../../adr/0139-local-kernel-sae-behavior-graphs.md):
a small Rust kernel that runs Qwen3 on phones, Raspberry Pis, desktops and the
PWA; sparse-autoencoder features as its sensors and actuators; behavior state
graphs that decide how it acts; remote models used only as retrieval.

## Two ideas, two crates

Everything here is one of two things, and each has one home:

- **Running a model** — `crates/kernel`. Weights in, tokens out. It knows
  nothing about SAEs, states or characters.
- **Deciding how it behaves** — `crates/behavior`. SAE features and state
  graphs. It knows the kernel only through one trait, `Hook`.

```
crates/
  kernel/                       opensesame-kernel: run a model
    src/
      lib.rs                    Kernel::load(), Kernel::generate(), trait Hook
      qwen3.rs                  the one architecture: layers, attention, MLP, KV cache
      math.rs                   dot, matmul, rmsnorm, rope, softmax, int8/int4 blocks
      tokenizer.rs              Qwen's byte-level BPE, read from tokenizer.json
      sample.rs                 greedy, temperature, top-p
      pack.rs                   model pack: read (mmap) and convert from a checkpoint
    tests/
      golden.rs                 logits and hooked residuals vs committed fixtures
      fixtures/                 small reference outputs from tools/model-lab

  behavior/                     opensesame-behavior: how the model acts
    src/
      lib.rs                    Behavior::load(); implements kernel::Hook
      graph.rs                  states, sensors, transitions: the data model
      validate.rs               reachability, feature presence, strength bounds
      features.rs               sense (encoder rows, thresholds), steer (decoder rows)
      step.rs                   per token: sense → transition → steering vector
      compile.rs                graph JSON + SAE file → behavior pack
    tests/
      graph.rs                  determinism, hysteresis, refusal of bad packs
      replay.rs                 transcript → state timeline, against fixtures

  kernel-bindings/              opensesame-kernel-bindings: the same API elsewhere
    src/lib.rs                  UniFFI for Kotlin and Swift; wasm-bindgen for the PWA

apps/cli/src/kernel.rs          opensesame kernel run | convert | compile | replay | eval

marketplace/behaviors/          authored graphs (*.json), pinned in .opensesame/marketplace.json

tools/model-lab/                offline and outside CI: fine-tuning, SAE training,
                                fixture generation, feature exploration (Python)
```

Rules that keep it that way:

- `kernel` has no dependency on `behavior`; `behavior` depends on `kernel`
  for `Hook` and nothing else.
- One architecture per file in `kernel`. A second one is a new file and a
  new decision, never a flag inside `qwen3.rs`.
- `kernel-bindings` only translates; logic added there belongs in one of
  the other two.
- Every file stays under 400 lines (ADR 0093). `math.rs` is the likeliest to
  grow; it splits into `math/{mod,neon,wasm}.rs` when it does.
- `tools/model-lab` produces files; nothing in the product imports it.

## The seam

```rust
// crates/kernel/src/lib.rs
pub trait Hook {
    /// Layers this hook wants to see.
    fn layers(&self) -> &[usize];
    /// Called once per token per requested layer, after that layer's
    /// residual update. May read `resid` and add to it.
    fn at(&mut self, layer: usize, resid: &mut [f32]);
    /// Called between turns with events the host raised.
    fn event(&mut self, _event: &str) {}
}

pub struct Kernel { /* weights, tokenizer, KV cache */ }

impl Kernel {
    pub fn load(pack: &Path) -> Result<Self, Error>;
    pub fn generate(&mut self, prompt: &str, opts: &Sample, hook: &mut dyn Hook,
                    on_token: &mut dyn FnMut(&str)) -> Result<(), Error>;
}
```

```rust
// crates/behavior/src/lib.rs
pub struct Behavior { /* graph, feature rows, current state */ }

impl Behavior {
    pub fn load(pack: &Path) -> Result<Self, Error>;   // validates, or refuses whole
    pub fn state(&self) -> &str;
}

impl kernel::Hook for Behavior { /* sense → step → steer */ }
```

A caller runs a character with three lines: load a `Kernel`, load a
`Behavior`, call `generate` with the behavior as the hook.

## Files a person touches

| File | What it is | Made by |
|---|---|---|
| `*.safetensors` + `tokenizer.json` | Model pack: weights and tokenizer | `opensesame kernel convert` from a Qwen checkpoint or a merged fine-tune |
| `marketplace/behaviors/<name>.json` | Behavior graph: states, sensors, transitions | A person |
| `<name>.features.safetensors` | The feature rows that graph uses | `opensesame kernel compile` from the graph and an SAE |

A behavior graph:

```json
{
  "apiVersion": "opensesame.dev/v1alpha1",
  "kind": "BehaviorGraph",
  "model": "qwen3-1.7b-int4",
  "sae": { "source": "Qwen/SAE-Res-Qwen3-1.7B-…", "layer": 14 },
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

Feature numbers, the layer and the SAE id are placeholders; authoring picks
real ones in the lab.

## Phases

### Phase 0 — Decide

- Accept ADR 0139; settle the three open questions.
- Pick reference devices (a Raspberry Pi 5, one mid-range Android phone, one
  iPhone) and write a tokens-per-second floor and a peak-memory ceiling for
  each into `tools/quality/kernel-budgets.json`.
- `tools/model-lab/`: the fixture script. It runs the reference model
  (Hugging Face transformers) on a handful of prompts and writes top-k logits
  and hooked-layer residuals to `crates/kernel/tests/fixtures/`.

### Phase 1 — `crates/kernel`

`qwen3.rs`, `math.rs`, `tokenizer.rs`, `sample.rs`, `pack.rs`, and
`opensesame kernel convert` and `run`. Portable Rust first; NEON and SIMD128
paths after the golden tests pass.

**Exit:** `tests/golden.rs` passes on x86_64, aarch64 and wasm32; a Raspberry
Pi 5 meets its budget with Qwen3-1.7B at int4.

### Phase 2 — `crates/behavior`

`graph.rs`, `validate.rs`, `features.rs`, `step.rs`, `compile.rs`, and
`opensesame kernel compile`, `replay` and `eval`. `eval` reports, per pack,
fluency against steering strength and, for TopK SAEs, how often calibrated
thresholds agree with the full SAE.

**Exit:** the graph and replay tests pass; two example graphs in
`marketplace/behaviors/` with replay fixtures and eval reports.

### Phase 3 — Host and retrieval

The kernel served by the ADR 0138 host, so a phone can use a Pi's kernel; a
remote model's answer enters as a quoted source and the steered kernel
writes the reply; capability-registry entries for the new verbs (ADR 0065).

**Exit:** on a Pi, a hostile turn moves the graph to `guarded` and the reply's
sensed features confirm it; remote text never raises a graph event directly.

### Phase 4 — Phones

`crates/kernel-bindings` with UniFFI, built the way `authenticator-core` is,
and the kernel inside the Android and iOS app.

**Exit:** the golden tests pass on device; the reference phones meet their
budgets after ten minutes of generation.

### Phase 5 — The PWA

The wasm32 build of `kernel-bindings`, loaded as an ADR 0130 capability;
packs downloaded after consent into OPFS; its own entry in
`tools/quality/bundle-budgets.json`.

**Exit:** `verify:capability-graph` shows the kernel unreachable before
consent; golden tests pass in headless Chromium.

### Later — our own SAEs and fine-tunes

Both happen in `tools/model-lab/` and leave through the same two files:

1. Fine-tune, merge the adapter into the weights, `opensesame kernel convert`.
2. Train a JumpReLU SAE on the merged model's residual stream at the hooked
   layer; `opensesame kernel compile` takes it like any other SAE.
3. Regenerate the golden fixtures and each pack's eval. A pack compiled
   against the base model's SAE is not trusted on a fine-tune until its eval
   passes there.

## Risks

- **Owning a transformer.** A subtle mismatch (RoPE, norm placement,
  QK-norm) degrades output silently. No phase ships without the golden
  tests passing on every target.
- **TopK sensing.** Calibrated thresholds approximate TopK membership; the
  eval reports the agreement rate, and our own SAEs remove the
  approximation.
- **Feature quality.** Strong steering hurts fluency; each pack's bounds
  come from its eval, not a guess.
- **Pack size.** Qwen3-1.7B at int4 is about 1 GB; the 151k-token embedding
  table is a large share of it.
