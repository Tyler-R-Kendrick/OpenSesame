# The password generator form, closed by default

Two real builds, walked the same way at 390 wide (a phone, 1500 tall so the whole
editor shows) and 1280 wide (a mouse): the base is `claude/derived-generator`,
the branch adds the derived default and the quieter form.

| Sheet | What it shows |
| --- | --- |
| `390-default.png`, `1280-default.png` | A new account's password as it opens |
| `390-options.png`, `1280-options.png` | The options, opened from their one line |
| `390-words.png`, `1280-words.png` | The same for random words |

Measured in the browser (`capture-evidence.mjs`, `measure` / `report` steps):

- Options block at 390: **247 px, always drawn → hidden until opened** (274 px
  open, which now also names each option in words).
- At 1280 the block was 130 px and always drawn; it is 157 px when opened.
- Words the options used: `A–Z a–z 0–9 Avoid l1IO0 Minimum digits ≈126 bits` →
  `Capital letters, Lowercase letters, Numbers, Avoid look-alike characters,
  Fewest numbers, Excellent` (hover on the look-alike option says what it
  means). No character string or bit count is on the page.
- Default generator: `Rules` → `Computed` (derived).
- *Include pepper* is on the form for every generator.

The journey (`journey.json`) is replayable with
`node apps/pages/scripts/capture-evidence.mjs capture before|after <journey.json>`.
