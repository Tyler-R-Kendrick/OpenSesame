# The password form: one field and one Options line

Two real builds, walked the same way at 390 wide (a phone, 1500 tall so the whole
editor shows) and 1280 wide (a mouse). The base is the branch below this one
(`claude/lazy-age`: the generator, its rules, a strength figure and the pepper
checkbox are all drawn); the branch is this commit's build.

| Sheet | What it shows |
| --- | --- |
| `390-default.png`, `1280-default.png` | A new account's password as it opens: the password with its show and make-another keys, and one line, *Options* |
| `390-options.png`, `1280-options.png` | *Options* opened: the generator (*Algorithmic*), its choices in plain words, and *Include pepper* (on) with *Pepper goes* (`end`) |
| `390-words.png`, `1280-words.png` | Random words chosen inside *Options* |

Measured in the browser (`capture-evidence.mjs`, `measure` step on the password
method, `.method`):

- Closed, the method is **530 px → 169 px** at 390 and **314 px → 113 px** at 1280.
  Opened it is 694 px and 442 px: the same choices, plus where the pepper goes.
- The generator list and *Include pepper* / *Pepper goes* are no longer on the form;
  they are inside *Options*. The default generator is *Algorithmic* and the pepper
  is on, at the end, so neither needs to be opened to get a password.
- The password field's own label is for screen readers; its group already says
  *Password*.
- Wording: `A–Z a–z 0–9 Avoid l1IO0 Minimum digits ≈126 bits` → `Capital letters
  Lowercase letters Numbers Avoid look-alike characters Fewest numbers Excellent`.

The journey (`journey.json`) is replayable with
`node apps/pages/scripts/capture-evidence.mjs capture before|after <journey.json>`.
