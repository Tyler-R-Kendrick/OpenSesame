---
name: OpenSesame
description: Bitwarden-class authority vault for humans and agents
colors:
  sidebar-navy: "#152033"
  content-mist: "#eef1f6"
  elevated: "#ffffff"
  ink: "#1a2230"
  muted: "#5c6b7e"
  line: "#d5dde8"
  accent-teal: "#0f766e"
  accent-ink: "#f0fdfa"
  accent-soft: "#ccfbf1"
  ok: "#047857"
  warn: "#b45309"
  err: "#b91c1c"
typography:
  display:
    fontFamily: "Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "1.85rem"
    fontWeight: 700
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
  body:
    fontFamily: "Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.04em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.9rem"
rounded:
  sm: "8px"
  md: "10px"
  pill: "999px"
spacing:
  sm: "0.45rem"
  md: "0.85rem"
  lg: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-teal}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.95rem"
  button-secondary:
    backgroundColor: "{colors.content-mist}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.95rem"
  unlock-card:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.ink}"
    rounded: "14px"
    padding: "1.75rem 1.5rem"
  vault-row:
    backgroundColor: "{colors.content-mist}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.75rem 0.85rem"
---

# Design System: OpenSesame

## Overview

**Creative North Star: "Authority Vault"**

OpenSesame’s Pages client is a Bitwarden-class vault for sealed authority — not a protocol dashboard and not a password manager clone. Humans unlock, search, and open typed items; agents use the same catalog through a peer view. Craft bar (user-pinned): Bitwarden; companion assumed: 1Password. OpenSesame teal + navy replace competitor purple.

**Key Characteristics:**
- Unlock-first session gate
- Navy sidebar + light content shell
- Search + type filters over a dense item list
- Teal primary actions; soft 10px radius
- Synthetic items always labeled

## Colors

Restrained: neutrals carry the vault; teal is the control accent.

### Primary
- **Accent Teal** (#0f766e): Primary buttons, active nav, focus, type badges for connections.

### Neutral
- **Sidebar Navy** (#152033): Primary navigation plane.
- **Content Mist** (#eef1f6): App ground and row fills.
- **Elevated** (#ffffff): Cards, panels, unlock surface.
- **Ink** (#1a2230) / **Muted** (#5c6b7e) / **Line** (#d5dde8).

### Named Rules
**The Competitor Marks Rule.** Match Bitwarden vault habits, never Bitwarden brand purple or wordmarks.

**The Unlock Honesty Rule.** Copy must state session unlock does not decrypt sealed blobs into the page.

## Typography

**Display / Body:** Source Sans 3  
**Mono:** IBM Plex Mono (codes, digests, status chips only)

### Hierarchy
- Unlock product name ~1.85rem bold
- Vault page titles ~1.45rem
- Row names bold; subtitles muted 0.9rem
- Filter chips 0.88rem semibold

## Layout

Desktop: 15.5rem sidebar + content (`max-width` ~52rem). Mobile: sticky top bar + 4-tab nav (Vault / Agent / Tools / Settings). Vault home is search → filters → list — never twin marketing cards.

## Elevation & Depth

Soft ambient shadow on unlock card and panels (`0 8px 24px rgba(21, 32, 51, 0.08)`). Rows are flat tonal fills with 1px lines.

## Shapes

Radius 10px on controls/panels; 8px on type badges; pills for filters and status chips.

## Components

### Buttons
Primary teal fill; secondary mist fill + line; compact variants in agent rows.

### Navigation
Sidebar links with icons; active state mixes teal into navy. Mobile icon+label grid.

### Vault rows
Icon badge + name/subtitle + type meta. Hover softens toward accent-soft.

### Unlock card
Centered elevated card; mark + product + honest PIN copy + primary CTA.

## Do's and Don'ts

### Do:
- **Do** keep Vault as the home after unlock.
- **Do** label synthetic demo items.
- **Do** offer Agent as a peer of Vault, not a separate product.

### Don't:
- **Don't** revive the yellow airport depth-band world on this surface.
- **Don't** show raw secrets, private keys, or `getSecret()` affordances.
- **Don't** clone Bitwarden’s purple brand identity.
