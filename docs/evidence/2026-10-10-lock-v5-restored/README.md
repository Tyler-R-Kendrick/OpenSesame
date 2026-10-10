# Lock-v5 title screen restored

Evidence for putting back the approved lock-v5 title screen (#946, #947) in
place of the plate-tier wordmark (#1012). Each pair is captured from two real
builds, `main` at `652e15368` and this branch, walked the same way at phone
(390) and desktop (1280) width: the front door after the decrypt, a guest
skipped in and locked, the unlock gate, then Unlock pressed.

| Sheet | What it shows |
|-------|---------------|
| `1280-door.png` | The front door title: a 480×64 fitted particle field becomes the approved 278×45 wordmark |
| `390-door.png` | The same at 390: 350×49 becomes 278×45 |
| `1280-unlock.png` | The unlock gate: a 198×31 solid wordmark in the card becomes the 546×72 hero above it, with the CipherDial (13 canvases, 0 before) behind the card |
| `1280-unlock-night.png` | The gate at night, the hero caught mid-decrypt |
| `390-unlock.png` | The gate at 390: the hero is 348×48 and the dial sits below the notes |
| `1280-doors.png` | 1.45s after Unlock: `main` is already in the vault; the branch is mid-ceremony, doors parting at the divider over the vault |
| `390-doors.png` | The same at 390 |

Door travel, sampled every 100ms after Unlock (`--unlock-door-shift` on the
gate; "gate" is the held gate before the doors move):

```
main    1280  gate shell shell …                       (vault in under 100ms, no ceremony)
branch  1280  gate ×9  0.1% 3.7% 14% 40% 69% 85% 101%  shell …
branch   390  gate ×10 0.9% 7.2% 25% 53% 74% 91%       shell …
```

Verified besides the images: `verify:static` (the wordmark decrypt contract
and the unlock-hero contract, light and dark), `verify:keyboard`,
`verify:mobile` and `verify:auth`, all passing on the branch build.
