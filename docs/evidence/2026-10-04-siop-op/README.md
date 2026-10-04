# The Self-issued OpenID card is unchanged (ADR 0161)

This branch changes no screen. An earlier revision lengthened the summary of the
**Self-issued OpenID** card in Setup › Capabilities to say what Pages is not;
that is an explainer caption on a screen (AGENTS.md §5), so it was reverted. The
card reads exactly as it does on `main`. This directory is the proof of that, not
of a change: two real builds, walked the same way, giving the same card.

The two builds: the base (`2ac61beb`, the tip of `origin/main` this branch was
last merged with, so the merge-base) built in its own `git worktree` with
`VITE_BASE=/OpenSesame/`, captured with `EVIDENCE_DIST`; and this branch built the
same way. Both are walked by `apps/pages/scripts/capture-evidence.mjs` with
[`journey.json`](journey.json): front door › Set up your own › Custom › Customize
this installation › Custom, then the card
(`[data-testid="capability-card-identity.siop"]`), at desktop and phone width.
Sizes are read from the browser by the journey's `measure` step, the text by its
`report` step.

| Screen | Base `2ac61beb` | This branch |
|---|---|---|
| Setup › Capabilities, 1280 × 800 | card 544x102 | card 544x102 |
| Setup › Capabilities, 390 × 844 | card 353x180 | card 353x180 |

Summary text on both, at both widths: "Answer SIOPv2 requests from a registered
local application with a self-issued token, gated on a passkey identity."

## 1280 × 800

![Setup › Capabilities, Self-issued OpenID card, 1280](1280-siop-card.png)

## 390 × 844

![Setup › Capabilities, Self-issued OpenID card, 390](390-siop-card.png)

## Where the statement lives instead

SIOPv2 (Implementer's Draft), not a conventional OpenID Connect provider, is said
in [ADR 0161](../../adr/0161-what-a-static-origin-can-be-as-an-openid-provider.md),
in [Use OpenSesame Pages as your login](../../operators/use-pages-as-your-login.md),
in the guided-help goal `identity.local.siop.authorize` (spoken by the support
panel only when someone asks), and in the capability registry title (read by
agents and the support model's context). The two registry and support texts have
no fixed place on a screen to capture; they are covered by the
tutorial-registry tests (the GuideLang parser and validator accept the text) and
by `siop-boundary.test.ts`, which pins the registry title.

## What has no picture

`siop-metadata.json`, the relying-party kit and the examples have no rendered
surface of this app's; their evidence is `pnpm --filter @opensesame/pages
verify:siop` (see the ADR's *Testing* section), not images. The example relying
party's own sign-in page is a separate origin's page, not part of Pages, and is
exercised in a real browser by that journey.
