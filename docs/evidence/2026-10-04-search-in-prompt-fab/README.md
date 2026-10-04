# One text input; actions redrawn for a phone

Before/after from two real builds — the base (`49c9e438`, `main`) and this
branch — same journey (`journey.json`): a vault seeded with 14 logins through
the editor, a touch context at 390 × 844 and 320 × 568, a mouse context at
1280 × 800. Steps marked `only` run on one side of the pair: the base has a
search key to press, the branch has a verb to type.

Everything below is read from the browser (`capture-evidence.mjs` `measure` /
`report`), and `verify:mobile` fails the build on the same facts at 320, 390,
430 and landscape.

| 390 × 844 | before | after |
|---|---|---|
| Text inputs on screen while searching | **2** — `352 × 44` (a `/` box above the status line) and the prompt `248 × 44` | **1** — the prompt, `248 × 44` |
| What the list header holds | 6 unlabelled glyphs, each `44 × 44` (back, funnel, +, import, export, search) | back `44 × 44` and the view, named: `All items ▾` at `331 × 48` |
| Import / Export | two bare arrows in a strip at the top | two labelled rows, `371 × 52` each, under the tree |
| New item | a `44 × 44` glyph in the strip | a `56 × 56` corner button at `318,684`, above the status line and the prompt |
| After Enter on a search | `/search ban` emptied the prompt and opened a bordered "Searching for…" box over it (from the command bar's code; the list never read the `?q=` it navigated to) | the words stay in the prompt; `.command-bar__status` absent (measured) |
| Search `ban` | `2/14 · /ban` after typing in the second box | `2/14 · /ban` while typing in the prompt, before Enter |
| 320 × 568 header | funnel `44 × 44` among six keys | `All items ▾` `261 × 48` |
| 1280 × 800 list row | icon keys, one of them the `/` search key | the same icon keys without it (one fewer measured key); no corner button (`.fab` count `0`) |

## 1. Landing — 390

![Landing](390-landing.png)

Import and Export say what they do, and sit under the tree they act on — they
act on the whole vault, not on a list. No strip of keys above the tree. New is
the corner button.

## 2. List — 390

![List](390-list.png)

The header is back and the view the list is showing, named, as one choice the
width of the rest. Narrowed is said in the accent colour.

## 3. Search — 390

![Search](390-search.png)

Before: a search key opened a second `/` box above the status line, with the
statusline's own prompt (whose hint already lists `search`) below it. After:
`/? ban` is typed into that one prompt and the list narrows as it is typed,
with the count in the status line. The same prompt searches Activity and the
connector catalog; those screens' search keys and boxes are gone too.

## 4. Enter keeps the words — 390

![Search, committed](390-search-kept.png)

Enter hands the keyboard to the list; the words stay in the prompt, no notice
box opens over it, and Esc (in the prompt or the list) empties it.

## 5. List — 320

![List at 320](320-list.png)

## 6. Desktop — 1280

![Desktop](1280-vault.png)

The list's row keeps its icon keys for New, Import and Export. The `/` key on
a keyboard writes `/? ` into the prompt and focuses it.
