---
name: OpenSesame
description: End-to-end encrypted vault for humans, agents, websites, and developers
colors:
  canvas: "#f2f5f9"
  surface: "#ffffff"
  surface-2: "#f7f9fc"
  surface-3: "#eef2f8"
  rail: "#101a2b"
  rail-fg: "#dbe6f4"
  ink: "#0e1826"
  ink-2: "#566880"
  ink-3: "#7e8fa6"
  line: "#dce4ef"
  line-strong: "#c4d1e2"
  accent: "#0d7268"
  accent-ink: "#ffffff"
  accent-wash: "#e4f6f3"
  ok: "#0f7a51"
  warn: "#a25a05"
  err: "#b32424"
typography:
  display:
    fontFamily: "system-ui stack (-apple-system, Segoe UI, Roboto, …)"
    fontSize: "1.4rem"
    fontWeight: 650
    letterSpacing: "-0.021em"
  headline:
    fontFamily: "system-ui stack"
    fontSize: "1.0625rem"
    fontWeight: 650
  body:
    fontFamily: "system-ui stack"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui stack"
    fontSize: "0.6875rem"
    fontWeight: 600
    letterSpacing: "0.06em"
    textTransform: "uppercase"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
rounded:
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  sm: "0.4rem"
  md: "0.9rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  panel:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.lg}"
  item-row:
    backgroundColor: "transparent"
    activeColor: "{colors.accent-wash}"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.6rem"
---

# Design System: OpenSesame

## Overview

**Creative North Star: "One vault, four readings."**

OpenSesame is an end-to-end encrypted vault. A human uses it as a password
manager and passkey store, an agent as a secret store it can never read out, a
website as an auth broker, and a developer as an authority. The same encrypted
store underlies all four, and the interface has to make each one feel like the
product was built for them.

The craft bar is Bitwarden and 1Password. Password-manager canon — unlock gate,
list and detail, conceal by default, copy without revealing — is followed
because users already know it, in OpenSesame navy and teal rather than
competitor brand color.

**Key characteristics:**
- Master-password gate, no PIN theater, no recovery path
- Navy rail, light canvas, teal for exactly one thing: the primary action
- List-and-detail spine for the vault; full-width panels for the plane-backed
  sections
- System font stack — no webfont request, no flash, no third-party origin
- Sample data always badged

## Colors

Neutrals carry the interface. Teal is scarce enough to mean something.

### Primary
- **Accent** (#0d7268): primary buttons, active navigation, focus rings,
  strongest step of the strength meter. In dark mode it lifts to #2fb3a3.

### Neutral
- **Rail** (#101a2b): the navigation plane, dark in both themes.
- **Canvas** (#f2f5f9): the ground everything sits on.
- **Surface** (#ffffff): panels and cards.
- **Ink / Ink-2 / Ink-3** (#0e1826 / #566880 / #7e8fa6): primary, secondary,
  and placeholder text.

### Status
**ok** #0f7a51, **warn** #a25a05, **err** #b32424, each with a wash for filled
callouts. The password strength ramp (`--s-0` … `--s-4`) runs red → amber →
green → teal so "excellent" lands on the brand color.

### Named rules

**The Competitor Marks Rule.** Match Bitwarden's habits, never its brand.

**The Honest Crypto Rule.** Every claim in the interface is one the code makes
true. If copy says nothing leaves the device, nothing leaves the device — the
health report is computed locally and contacts no breach service, and TOTP codes
are derived in the page.

**The No-Recovery Rule.** The absence of a recovery path is stated before the
vault is created, acknowledged with a checkbox, and repeated where it matters.
Never soften it.

## Typography

System font stack for UI, system mono for anything a machine produced: codes,
identifiers, connection references, capability actions, snippets. Mono is a
signal that a value is literal, so never use it for prose.

### Hierarchy
- Page and detail titles ~1.4rem, weight 650, tight tracking
- Panel headings ~1.0625rem
- Body 15px / 1.5
- Field labels 0.6875rem uppercase with 0.06em tracking
- Numbers that change in place use `font-variant-numeric: tabular-nums`

## Layout

Desktop is a 15.5rem rail plus content. The vault adds a 21rem list column
between rail and detail, giving the familiar three-pane shape; the other
sections use a single 60rem column of panels.

Below 900px the rail is replaced by a sticky top bar and a five-item tab bar,
and the vault collapses to one pane at a time with a back link. Because the
rail carries the vault's filters, the list header grows a scrolling chip row at
that breakpoint — nothing in the rail may become unreachable.

Prose is measured (roughly 48–62ch). A paragraph is never as wide as a panel.

## Elevation & depth

Three shadow steps, all cool-tinted. Panels take the smallest; the unlock card
takes the largest. Rows are flat with hairline separators — depth marks
containers, not list items.

## Shapes

10px on controls and rows, 14px on panels and cards, pills for chips and
filters.

## Components

### Buttons
Teal fill for the primary action, surface fill with a hairline for secondary,
ghost for tertiary, and a red-tinted variant for anything destructive. One
primary per view.

### Field rows
The vault's atom: uppercase label, value, and right-aligned actions. Secrets
render as dots with a reveal toggle, and copy never requires revealing first.

### Navigation
Rail links carry an icon, a label, and a count. Active state is a teal wash. The
mobile tab bar mirrors the five sections and nothing else.

### Callouts
`note` with `--ok`, `--warn`, `--err` variants for a stated condition. Live
regions are `<output>`, control groups are `<fieldset>`, so the accessibility
role comes from the element rather than an attribute.

### Empty states
An empty state must say what would be here and why it is not — offline,
unauthenticated, or genuinely empty — and offer the action that fills it. The
vault's unselected detail pane goes further and reports what the vault holds,
what changed recently, and what needs attention.

## Do's and Don'ts

### Do:
- **Do** conceal secret values by default and allow copying without revealing.
- **Do** state what a network-backed surface cannot show while offline or
  unauthenticated.
- **Do** badge sample data on every item and keep removing it to one action.
- **Do** treat a reload re-locking the vault as correct behavior and say so.

### Don't:
- **Don't** add a shortcut around the master password. There is no PIN, no
  "remember this device," no recovery.
- **Don't** put a secret, or a hash of one, on the network.
- **Don't** let prose run the full width of a panel.
- **Don't** clone Bitwarden's brand identity.
