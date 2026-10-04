# ADR 0163 — A failure lives in the tray, never in a box in the page

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a screen draws
  nothing it cannot act on), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (nothing is placed in front of the first screen)

## Context

Nearly every Pages screen carried a red error box. `DESIGN.md`,
`docs/design/controls.md` and AGENTS.md already said a failure is a `StatusMark`
on the thing that failed or a notice in the tray, and `pnpm lint:design` ratcheted
`note--err` per file — but the lint matched only that literal class. A dynamic
`note--${tone}` (which `StatusNote` built), a `*__error` paragraph, a
`broker__card--err` card, and any bare `role="alert"` walked past it, so the
rule was written down, enforced against one spelling, and broken in about
forty files.

Moving the sentence into the tray exposed a second gap: the bell lives in the
unlocked shell, so a failure raised on the unlock screen, the front door, the
federated return or an unframed popup would have landed in a tray nobody could
open.

## Decision

1. **A failure is never drawn in the page.** Not as a `note--err`, a dynamic
   note tone, a `*__error` / `*__err` / `*-error` block, a `conn-error` or
   `conn-flash`, a `broker__card--err`, a visible `role="alert"`, or CSS that
   fills a block with the error wash.
2. **The seam is one hook.** `useFailureNotice(id, title, message, tone?)`
   (`apps/pages/src/components/use-failure-notice.ts`), and its component form
   `<FailureNotice>`, mirror a sentence into the tray under a stable `id` —
   a new sentence replaces the old, a cleared one clears it, and a notice
   outlives its screen. `StatusNote` rides the same hook: errors and warnings
   go to the tray, a success stays quiet and inline.
3. **A screen with no shell gets the bell.** `NoticeCorner` is mounted by
   `AppRoot` when the unlocked shell is absent and draws only while the tray
   holds something; the shell keeps its own bell and does not mount it.
4. **The lint has no ledger.** The count is zero everywhere, so
   `no-in-page-error` (markup) and `no-error-box-css` (CSS) are plain
   failures (`scripts/quality/design-lint-failures.mjs`), pinned by
   `apps/pages/src/screens/setup/failure-contract.test.ts`, which runs the lint
   against each spelling that once got through. A visually-hidden live region is
   the one allowed `role="alert"`; the tray's own card, danger controls, the
   `StatusMark` glyph and `aria-invalid` field borders may carry the error colour.

## Consequences

- Browser harnesses read the tray (`apps/pages/scripts/lib/tray-contract.mjs`)
  instead of looking for an alert in the page; a keyboard-only journey checks
  the bell's pending state rather than opening it.
- Where a notice was the only explanation on a pre-unlock screen (for example
  an enrolled authenticator with no passkey, PIN or password), the explanation
  is now read from the bell.
- Amber warnings that carry a recovery control or a countdown
  (`PasskeyHostNote`, the lockout, the non-durable-storage warning) are not
  failures in this sense and remain `note--warn`; they are not covered by the
  lint and are the next candidates if the rule is widened.
- `impeccable detect` is third-party and has no custom-rule API; it reads
  `DESIGN.md` as context, and the enforcing gate is `lint:design`, which the
  agent hook and `.githooks/pre-commit` run on every `.tsx` and `.css` edit.
