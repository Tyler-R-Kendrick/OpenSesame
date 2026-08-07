---
name: OpenSesame
description: Offline-capable authorization client — sealed store, ceremonies, task ceilings
colors:
  night-navy: "#0f1419"
  panel-steel: "#1a2330"
  line-steel: "#2a3848"
  fog: "#e8eef4"
  mist: "#9aabbc"
  accent-cyan: "#3d9cf0"
  junction-yellow: "#f5c518"
  band-ink: "#121820"
  ok: "#8fd4a8"
  warn: "#e6b84d"
  err: "#ff8f8f"
typography:
  display:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(2.4rem, 6.5vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.04em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.9rem"
    fontWeight: 400
rounded:
  none: "0px"
spacing:
  sm: "0.45rem"
  md: "0.85rem"
  lg: "1.25rem"
  shell: "1.15rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-cyan}"
    textColor: "#061018"
    rounded: "{rounded.none}"
    padding: "0.65rem 1.1rem"
  button-primary-hover:
    backgroundColor: "#66b0f3"
    textColor: "#061018"
    rounded: "{rounded.none}"
    padding: "0.65rem 1.1rem"
  button-secondary:
    backgroundColor: "#243246"
    textColor: "{colors.fog}"
    rounded: "{rounded.none}"
    padding: "0.65rem 1.1rem"
  depth-band:
    backgroundColor: "{colors.junction-yellow}"
    textColor: "{colors.band-ink}"
    rounded: "{rounded.none}"
    padding: "0.65rem 0.85rem"
  chip:
    backgroundColor: "#1a2330cc"
    textColor: "{colors.fog}"
    rounded: "{rounded.none}"
    padding: "0.3rem 0.55rem"
  panel:
    backgroundColor: "#1a2330eb"
    textColor: "{colors.fog}"
    rounded: "{rounded.none}"
    padding: "1.2rem 1.3rem"
---

# Design System: OpenSesame

## Overview

**Creative North Star: "Authority Depth Wayfinding"**

OpenSesame’s client shell is night-ops equipment, not a marketing dashboard. Depth is the product: operators move Surface → Vault → Ceremonies → Task → Ratchet under a sticky junction band, the same way an airport forces the next decision into yellow while the rest of the terminal stays dim. Cyan is the control language; yellow never paints the page ground.

The system is restrained: flat steel panels, sharp corners, IBM Plex for both UI and measurement. Expression lives in topology and the band — not cards of equal weight or decorative glow.

**Key Characteristics:**
- Night navy ground with panel steel planes
- Junction yellow reserved for the sticky depth band
- Accent cyan on primary actions and focus
- Sharp (0 radius) controls and panels
- Brand-first Surface; descent is supporting copy + CTAs

## Colors

Restrained strategy: neutrals carry the shell; cyan and junction yellow are scarce, purposeful signals.

### Primary
- **Accent Cyan** (#3d9cf0): Primary buttons, links, focus rings — the control voice.

### Secondary
- **Junction Yellow** (#f5c518): Sticky “Next decision” depth band only; ink is band-ink (#121820).

### Neutral
- **Night Navy** (#0f1419): Page ground / theme-color.
- **Panel Steel** (#1a2330): Panels and chip fills.
- **Line Steel** (#2a3848): Borders and secondary button edges.
- **Fog** (#e8eef4): Primary text.
- **Mist** (#9aabbc): Supporting / muted text.

### Named Rules
**The Junction Rule.** Yellow is for wayfinding junctions only. Never use it as page ground, card fill, or primary CTA.

**The Cyan Controls Rule.** Primary actions and focus affordances speak cyan; status greens/ambers/reds are semantic only.

## Typography

**Display Font:** IBM Plex Sans (Segoe UI, system-ui)
**Body Font:** IBM Plex Sans (Segoe UI, system-ui)
**Label/Mono Font:** IBM Plex Mono (ui-monospace)

**Character:** Industrial wayfinding — confident sans for brand and body; mono only for codes, digests, and live status values.

### Hierarchy
- **Display** (700, clamp 2.4–3.4rem): Brand “OpenSesame” on the shell.
- **Headline** (700, ~1.35rem): Panel titles deeper in the flow.
- **Body** (400, 1rem / 1.55): Lede and supporting copy; measure ~68ch.
- **Label** (700, 0.72rem, tracked uppercase): Band label and status keys.
- **Mono** (400, ~0.9rem): Codes, digests, connectivity values.

### Named Rules
**The Brand Leads Rule.** On Surface, OpenSesame is the only display-scale type; descent copy stays body-scale.

## Layout

Narrow shell (`max-width: 52rem`, padded ~1.15rem). Surface is a single descent column (`max-width: 40rem`), not a multi-card dashboard. From 720px up, deeper pages may use panels; Surface must not return to equal twin cards. Sticky depth band stays under the brand row. Spacing: tight groups inside panels, generous separation between band and descent.

## Elevation & Depth

Mostly tonal: panels sit slightly above night navy via fill + 1px line. The depth band uses a soft offset shadow for stickiness.

### Shadow Vocabulary
- **Band stick** (`box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35)`): Sticky depth band only.

### Named Rules
**The Flat Shell Rule.** No glow halos, glass stacks, or embossed metal. Depth is topology (the band + route order), not decoration.

## Shapes

Sharp geometry: `border-radius: 0` on buttons, inputs, panels, chips, and the band. 1px steel borders. No pill clusters.

## Components

### Buttons
- **Shape:** Sharp rectangle (0 radius)
- **Primary:** Accent cyan fill, near-black ink, weight 700
- **Secondary:** `#243246` fill, fog text, steel border
- **Disabled:** ~55% opacity
- **Linkish:** Inline cyan underline for probe actions

### Chips
- **Style:** Steel fill, mono text, steel border
- **Online / Offline:** Border/text tint toward ok or warn

### Cards / Containers
- **Panels:** Panel steel fill, line border, used on ceremony/task/settings — not as Surface hero scaffolding
- **Hints / Warns:** Accent- or warn-tinted bordered callouts

### Inputs / Fields
- **Style:** Near-black fill `#0c121a`, steel border, fog text
- **Focus:** 2px accent outline, 2px offset

### Navigation
- **Depth band:** Junction yellow, sticky, uppercase “Next decision” label, arrow-separated depth links; current page underlined in band ink
- **Secondary:** Settings / Queue after a · separator

### Signature: Depth Band
Airport-style next-junction strip. Owns the operator’s place in authority depth. Yellow here is the product’s signature material.

## Do's and Don'ts

### Do:
- **Do** keep yellow on the depth band only.
- **Do** lead Surface with brand scale + Vault primary / Ceremonies alternate.
- **Do** label synthetic task demo data as synthetic.
- **Do** respect `prefers-reduced-motion` (band entrance only).

### Don't:
- **Don't** build Surface as equal twin cards or a metric dashboard.
- **Don't** put primary CTAs in yellow or mute cyan to a chip-only accent.
- **Don't** use rounded-full pills, glow edges, or glass as default chrome.
- **Don't** invent Host/Identity capabilities this static shell cannot provide.
