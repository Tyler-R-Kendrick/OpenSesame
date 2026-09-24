# ADR 0083 — The browser is a model plane, and it is the fallback

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Related: [ADR 0076](0076-autonomous-web-login-rotation.md),
  [ADR 0077](0077-first-run-setup-ceremony.md),
  [ADR 0078](0078-external-idp-is-the-identity-service.md),
  [ADR 0065](0065-agent-surface-parity.md)

## Context

[ADR 0076](0076-autonomous-web-login-rotation.md) gives a model a narrow job:
look at a redacted picture of a website's own password-reset form and say
*which* field to fill. It never learns *what* to type — `fill_credential(ref,
selector)` names a credential and a place, there is no `read_field_value`, and
redaction happens at capture rather than at render.

Choosing who runs that model is an offer on the post-setup board
(`docs/design/setup-next-steps/`), and the board is skippable by construction:
nothing on it is a step, and doing nothing and pressing the commit is a
complete path. Skipping it meant the ceremony was off — OpenSesame would open
the right settings page and hand the job back to the person.

That floor is defensible but it is not the best floor available, because we
were ignoring a model that is frequently *already there*. The device rendering
this PWA may carry an on-device model the browser exposes through the Prompt
API. Its weights belong to the browser, are shared across origins, and are
never ours to ship.

## Decision

**Declining to name a provider resolves to the browser plane where the browser
can carry it, and to nothing where it cannot.**

Three consequences follow, and each is load-bearing.

### 1. The browser plane is the narrowest plane, not a degraded one

Ranked by what leaves the device:

| Plane | Frames leave the page | Frames leave the machine | Second process holds them |
|-------|----------------------|--------------------------|---------------------------|
| Browser (in-page) | no | no | no |
| Local (Ollama, LM Studio over loopback) | yes | no | yes |
| Hosted (an API) | yes | yes | yes |

The browser plane is strictly narrower than *every* option on the sheet,
loopback Ollama included: a local model server is a separate process with the
frames in its address space and its own logging. So the fallback is not a
consolation — it is the best row in the table, and the panel says so.

A configured provider still wins. An operator who typed an endpoint is not
second-guessed by a capability probe, and a device that happens to carry a
model is not a reason to ignore what somebody chose.

### 2. The redaction boundary does not move

It would be easy to argue that in-page inference makes capture-time redaction
unnecessary — nothing crosses a network, so what is there to protect? That
argument is wrong twice.

The frames go into the sealed observation log, which is a durable artifact
sealed to the owner's viewer key ([ADR 0076](0076-autonomous-web-login-rotation.md) §5,
[ADR 0081](0081-live-session-observation.md)). Where the model ran has no
bearing on what the log holds. And "redaction applied when a transcript is
displayed is not redaction" is the same sentence whichever plane rendered it.

So the pipeline is identical on every plane: struck out before the picture
exists, one tool that names a field and never a value, one redaction path.
The plane changes who watches. It never changes what there is to watch.

### 3. Skipping a step must never start a download

The browser plane has rungs, and only the top one is a fallback:

| Rung | What it is | Is it the fallback |
|------|------------|--------------------|
| `builtin` | the browser's own model, resident, image input available | **yes** |
| `builtin-download` | the same model, which the browser will fetch on first use | no — offered, download named |
| `webgpu-download` | no built-in vision model, but hardware that could run a small one we would have to send | no — offered, egress named |
| `none` | nothing | no |

`builtin-download` is the browser's own one-time fetch, shared with every site
that asks — cheap in aggregate, but not instant, and an operator must not meet
it mid-ceremony. `webgpu-download` is worse in kind: somebody has to *send* the
weights, which is a request to a model host from an app whose whole posture is
that it makes none on its own. Neither is reached by pressing skip.

Image input decides the top rung, and it is queried separately from text. The
Prompt API gates the two apart, and the same device can answer `available` for
text and `unavailable` for images. A model that cannot be shown a page has
nothing for `fill_credential` to point at, so a text-only built-in model is
reported as its own outcome — not as absence, because "your browser has a model
but it cannot see" and "your browser has no model" send an operator to
different places.

### 4. An agent may read the plane and may never choose it

Under [ADR 0065](0065-agent-surface-parity.md) both halves are registered:

- `model_plane.read` is mapped onto WebMCP. Whether autonomous reset is
  available is ordinary posture, and an agent that cannot see it will offer a
  ceremony that cannot run.
- `model_plane.choose` is excluded from every agent surface. The choice names
  an endpoint that redacted frames are sent to. An agent able to make it holds
  a redirect primitive: point the plane at a host it names and the pictures
  follow. That it is only *redacted* frames is not a defence — the boundary
  holds because nobody untrusted picks the destination.

## Consequences

- A deployment on a browser with a resident on-device vision model gets
  autonomous password reset with no provider, no key and no endpoint, and with
  a boundary narrower than any configured option.
- A deployment on any other browser behaves exactly as before: OpenSesame opens
  the right settings page and the person makes the change. It never half-tries.
- Capability detection is a cheap probe — no weights, no prompt, no network —
  and is re-read per session rather than cached at import, because a browser can
  expose the model after first paint.
- No API key is stored beside the plane record, on any rung. A provider's key is
  a secret and lives in the vault behind the same seal as everything else; the
  record holds a kind, an address and a model id, and has no field a key could
  be smuggled into.
- The stored record's `endpoint` is dropped on read for the browser plane, so a
  tampered record cannot aim in-page inference at a remote host.

## Alternatives considered

**Ship a small VLM with the app.** Rejected: `apps/pages` is an offline Pages
deploy measured in kilobytes, and the smallest useful vision model is three
orders of magnitude larger. It would also make us the weights distributor,
which is a supply-chain position we have no reason to take.

**Fall back to a text-only model reading the accessibility tree.** Tempting —
a DOM extract is arguably *more* value-blind than pixels — but it is a second
capture pipeline with a second redaction surface, and ADR 0076 §5's guarantees
are stated over the picture. Worth designing on its own merits later; not worth
smuggling in as a fallback.

**Start the browser's download automatically when skipped.** Rejected. The
step is skippable precisely so that a person in a hurry can move on, and
turning that into gigabytes on a phone is the opposite of what pressing skip
meant.
