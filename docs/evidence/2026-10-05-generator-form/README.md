# The password generator form, closed by default

Two real builds, walked the same way at 390 wide (a phone, 1500 tall so the whole
editor shows) and 1280 wide (a mouse). The base is the branch below this one
(`claude/lazy-age`: an account's generator is *Rules*, its options always drawn);
the branch is this commit's build.

| Sheet | What it shows |
| --- | --- |
| `390-default.png`, `1280-default.png` | A new account's password as it opens: *Algorithmic*, one line saying what it will make, the password, *Include pepper* |
| `390-options.png`, `1280-options.png` | The options, opened from that line |
| `390-pepper.png`, `1280-pepper.png` | *Include pepper* ticked, with *Pepper goes* (`-4`: before the last four characters) |
| `390-words.png`, `1280-words.png` | The same line and disclosure for random words |

Measured in the browser (`capture-evidence.mjs`, `measure` / `report` steps):

- Options block opened, 390: **247 px (always drawn) → 274 px (hidden until opened)**.
  At 1280: **130 px → 157 px**. Closed, it is the one summary line.
- What the options say: `A–Z a–z 0–9 Symbols Avoid l1IO0 Minimum digits Minimum symbols ≈126 bits`
  → `Capital letters Lowercase letters Numbers Symbols Avoid look-alike characters
  Fewest numbers Fewest symbols Excellent`. No character string or bit count is on the page.
- Default generator: *Rules* → *Algorithmic*. The list names kinds only.
- *Include pepper* and *Pepper goes* are on the form for every generator; the
  product asks for no pepper and keeps none (ADR 0174).

The journey (`journey.json`) is replayable with
`node apps/pages/scripts/capture-evidence.mjs capture before|after <journey.json>`.
