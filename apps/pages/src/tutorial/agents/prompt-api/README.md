# Prompt API support agent

A `SupportAgentPort` (`@opensesame/support-agent`) backed by the browser's
built-in on-device language model — the Prompt API's global `LanguageModel`
object. There is no vendor SDK here and no network call: the question, the
authored page context and the answer never leave the machine.

## What it is

- `detect.ts` — feature detection. Returns an OpenSesame-local
  `LocalLanguageModelApi` with pre-bound methods, or `null`. Every platform
  method is treated as absent until proven present, and no raw platform value
  escapes the module.
- `prompt-api-agent.ts` — `createPromptApiSupportAgent()` and
  `acquireLocalModel()`.

The platform surface is injected: `PromptApiAgentOptions.api` defaults to
`detectLocalLanguageModel()`, and tests pass a hand-written fake instead. Pass
`null` to state that the platform is absent.

## Acquiring the model needs a user gesture

The first use downloads the model. `run()` refuses with
`SupportError("AGENT_UNAVAILABLE", …)` whenever the model is anything other
than `available`; a click handler calls `acquireLocalModel({ onDownloadProgress })`,
which is the only path in this directory that can start a download. Nothing
here starts a multi-gigabyte transfer on a person's behalf.

## The honest limitation

This is the narrowest support backend we ship, and it is not a default:

- **Desktop Chrome-family browsers only.** At the time of writing the Prompt
  API ships in Chrome 138+ on Windows 10/11, macOS 13+, Linux and ChromeOS
  (Chromebook Plus). Firefox and Safari do not have it.
- **Effectively unavailable on mobile.** Android and iOS browsers do not
  expose it, so a phone visiting Pages falls back to another support agent or
  to none.
- **Hardware gated.** Chrome documents roughly 22 GB of free storage and
  either a GPU with 4+ GB of VRAM or a capable CPU. A machine under those
  requirements reports `unavailable`, and no gesture changes that.
- **A large one-time download.** Acquisition needs an unmetered connection and
  real time. `availability()` reports `downloading` with a progress fraction so
  the UI can say so rather than appearing hung.
- **Offline afterwards.** Once the model is on the device, answering works with
  no network at all — which is the whole reason this backend exists for an
  offline-first PWA.

Availability is a runtime question, never an assumption: call `availability()`
and render what it says. Treat `{ kind: "unavailable" }` as the common case.

## What the model can and cannot do

The agent hands the model the system instruction the shared policy builder
produced from the authored page context, plus the sanitized question and
transcript. It gets back text, which `parseSupportTurn` turns into a
`SupportTurn` — prose and, at most, GuideLang source that is still untrusted
and still has to survive the compiler and the registries. There is no field
through which the model can return a selector, a URL, a tool call or an
authority mutation, and nothing in this directory reads the DOM, storage or a
vault record.

Sampling controls (`temperature`, `topK`) are deliberately not exposed: they
are not part of the stable web API, and a support answer is not a place to
invite tuning.
