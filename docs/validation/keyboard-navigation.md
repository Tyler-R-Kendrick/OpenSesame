# Keyboard navigation regression contract

Keyboard access is required from arrival, not only after a pointer click or
a test calls `focus()`. See the keyboard rule in root `AGENTS.md`.

## September 2026 regression

The empty vault correctly focused its New item link, but the shell's capture
listener consumed Enter and called the vault listing's activation handler.
The link never activated. The native-control exception covered buttons only.
Separately, Tab switched listings or refocused the same listing, trapping
users away from controls elsewhere on the page.

The previous tests missed the composition failure: handler spies asserted
dispatch, form tests injected focus, and built-page journeys clicked links.
Some tests explicitly required the Tab trap. A green suite therefore proved
the wrong contract, not keyboard accessibility.

The first correction still missed immediate movement after unlocking an empty
saved vault. New item held focus, but arrow/vim movement dispatched to an empty
listing, and F6 refused toolbar focus. Movement now selects the rail when the
vault has no rows and lands focus on its target. F6 also admits toolbar focus.
The browser gate now seals a password vault, reloads, unlocks by typing and
Enter, then checks immediate navigation without preparatory Tab or focus calls.

## Enforcement

- Native link/button activation belongs to the browser. Composite controls
  own their navigation keys. The shell must yield before consuming them.
- Tab/Shift-Tab traverse native control order. F6 switches listings without
  taking away access to toolbars, footer controls or browser chrome.
- Only an active modal contains focus; closing it restores its trigger.
- `verify:keyboard` uses real browser keyboard input, starting from a fresh
  static-origin load. It covers saved password-vault unlock, guest entry, empty-vault New, editing and
  cancellation, saving an item, populated-tree navigation, section chords,
  footer reachability, modal return, lock and reload at 1280px and 390px.
- Identity tree children and tabs share the same URL-backed view. Connector
  movement previews the selected tile with a border and scroll position;
  Enter activates it. Right/l must not open a preview leaf. Load more is the
  last indexed row, and activation retains tree focus on the first new row.
- The local-directory journey creates, renames, disables, reloads and deletes
  all four record kinds using only the keyboard at both widths. Invalid names
  retain the draft and focus; competing row mutations are disabled during an
  edit. This proves directory CRUD, not authentication or access enforcement
  ([ADR 0102](../adr/0102-vault-local-identity-directory.md)).
- The existing required Bundle budgets CI job runs it against the build it
  measured. A unit contract protects the command wiring and forbids pointer,
  focus-injection and synthetic-event shortcuts in that journey.

Run after a fresh `VITE_BASE=/OpenSesame/` Pages build:

```bash
pnpm --filter @opensesame/pages verify:keyboard
```

Set `PLAYWRIGHT_CHROMIUM` to the installed browser when needed. Before the fix,
the browser test failed because Enter on New item did not open `form.editor`.
Do not update a test to bless a lost interaction. Retain that failing oracle
and fix the shared owner. These checks are not a claim that every assistive
technology or browser has been tested; manual screen-reader testing remains
necessary for changes to semantics or announcements.
