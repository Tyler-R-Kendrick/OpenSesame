# Keybindings: the half-typed keys on the statusline

[ADR 0155](../../adr/0155-keybindings-and-macros.md) §8 gives the workspace
statusline a segment that shows keys while they are half-typed. The pull request
that added it (#574) shipped without a before/after sheet; this gallery is it.

Two real builds walked the same journey (`journey.json`): the base is the commit
before #574 (`25395fba^`), the branch is this stack. Each build opens as a guest,
goes to the vault, reads the statusline, types `3` then `g` and reads it again.

| Sheet | Shows |
|---|---|
| [`1280-pending.png`](1280-pending.png) | Desktop. Before, nothing while keys are pending. After, the caps `3` `g` and the next-key list (`g First row, or row N · v Vault · s Settings · y Activity`) in the same row. |
| [`390-pending.png`](390-pending.png) | Phone. After, only the caps `3 g`; the list is not drawn under `(pointer: coarse), (max-width: 900px)`. |

## Measurements (from the browser)

| Width | Statusline, idle | Statusline, keys pending |
|---|---|---|
| 1280 | 1280 × 53 | 1280 × 53 |
| 390 | 390 × 56 | 390 × 56 |

The statusline does not change height when the segment appears: it is a part of
the row, never a layer over it, and the phone keeps its one line
(DESIGN.md § Touch).
