# ADR 0122 — Shell command omnibox (STT + on-device LLM)

Status: Accepted
Date: 2026-09-15
Supplements: ADR 0088 ([AI-native contextual support](0088-ai-native-contextual-support.md)),
ADR 0090 ([static frontend complete without backend](0090-static-frontend-complete-without-backend.md)),
ADR 0005 ([ConnectionRef / no getSecret](0005-authority-handle-connectionref.md))

## Context

Operators want click-to-toggle voice listening and a browser URL-bar–shaped
command strip that can navigate, open vault items, and put a field on the
clipboard. The Pages shell is offline-first: there is no Host route to host
a chat backend, and ADR 0088 already forbids models from acting on the DOM.

## Decision

1. **Chrome.** A `CommandBar` sits in `AppShell` under crumbs — one mono
   omnibox with a click-to-toggle mic and a submit key. It is not a chat panel.
2. **STT.** Transcription uses the browser Web Speech API
   (`SpeechRecognition` / `webkitSpeechRecognition`) only. Click or `m`
   toggles listening; a second click/`m` stops and submits. Escape cancels.
   While armed, spontaneous engine ends restart so a pause does not end the
   turn. No cloud STT vendor. `Ctrl-l` / `:` focuses the omnibox (browser
   URL-bar style). Both chords are listed on the `?` keymap sheet.
3. **Control path.** Utterances become a closed `AppCommand` schema
   (navigate / open_item / copy_field / search / help). A deterministic
   parser runs first. When the Chrome Prompt API reports `available`,
   Vercel AI SDK `generateObject` maps freer phrasing through a
   `LanguageModelV2` adapter over `LanguageModel` — never a network model
   by default.
4. **Secrets.** The model receives item *names* only. `copy_field`
   resolves values in-process and writes them through the existing
   clipboard clear path. The outcome string never echoes the secret.
5. **ADR 0088.** Support GuideLang stays the pointing agent. The command
   bar is a separate, typed verb surface — not GuideLang and not DOM
   automation.

## Consequences

- Mic control is absent where Web Speech is missing; typed commands still
  work.
- On-device model download remains a user gesture elsewhere (Support);
  the bar does not start a multi-gigabyte fetch.
- Bundle includes `ai` + `zod` for `generateObject`; initial paint still
  works if the model path is unused.
