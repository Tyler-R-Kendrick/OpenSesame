# ADR 0167 — The keymap has two loadouts, and a phone leads with gestures

- Status: Accepted
- Date: 2026-10-04
- Amends: [ADR 0156](0156-keybindings-and-macros.md) (the keymap is the
  keyboard's half of one keymap, not the whole of it) and DESIGN.md § Touch
  (Keybindings is no longer withheld from a device with no pointing device)
- Builds on: [ADR 0065](0065-agent-surface-parity.md) (every surface is a twin,
  never the only road), [ADR 0134](0134-item-type-marketplaces-and-settings-files.md)
  (Settings is files), [ADR 0149](0149-nothing-stored-in-the-clear.md) (what the
  client stores is sealed), [ADR 0158](0158-settings-rows-act-or-are-absent.md)
  (a row acts, or it is not drawn)

## Context

ADR 0156 made every key a person's. A phone has none to press. What it had
instead were three gestures hard-wired in the shell (`lib/gestures.ts`: a tap,
a hold or a row swiped left for its menu, a pane swiped right to go back), a
static list of them on the `?` sheet, and — because there was no key to bind —
no Keybindings tab at all: `(any-pointer: fine)` decided, and a phone with only
a keyboard attached lost it too. So a finger could not be given a command, and
a person who carried a phone and a Bluetooth keyboard could not reach the page
that configures the keyboard.

A finger's natural controls are touches and the phone's own motion, and a
keyboard's are keys. Which one is better is a property of the interface being
used, not of the person: the same person is on a laptop in the morning and a
phone at lunch.

## Decision

1. **The keymap has two loadouts, Keyboard and Gestures,** and
   Settings › Keybindings draws both as tabs (`LoadoutTabs`, a tablist with
   arrow, Home and End keys). A device opens on its own: a coarse primary
   pointer lands on Gestures, anything else on Keyboard
   (`preferredLoadout(touch)`, the same `(pointer: coarse)` query the `?` sheet
   already reads, so the sheet, the tab and the help row cannot disagree). The
   other loadout is always one tab away: keys still work on a phone with a
   keyboard attached, and gestures on a laptop with a touch screen, so neither
   is withheld. A link to `#settings-gestures` or `#settings-keymap` opens its
   tab, and the rail's Keybindings subtree lists Keymap, Gestures and Macros.
   Keybindings is therefore drawn on every device; the pointer-only rule in
   DESIGN.md § Touch is retired.

2. **A gesture is bound to a command exactly as a key is** — same catalogue,
   same macros, same `runTarget` — and nothing else. There is no second
   authority model. A gesture's run is a press of a key that happens to be made
   with a hand: it goes into a register recording as the key would
   (`recordRun`), a macro bound to it runs under the macro limits, and it is
   refused where a key would be refused. The set is **closed and small**, like
   the contexts, and ships with defaults a thumb cannot do harm with:

   | Gesture | Default |
   |---|---|
   | two-finger swipe left | `listing.dive` |
   | two-finger swipe right | `listing.climb` |
   | two-finger swipe up | `listing.last` |
   | two-finger swipe down | `listing.first` |
   | two-finger tap | `command.palette` |
   | shake | `help.keymap` |

   Two-finger swipes go in on the left and out on the right, the way the
   fixed one-finger swipe already goes back; up is toward the end of the list.

3. **One finger is the page's, and is fixed.** A tap activates, a drag scrolls,
   a hold or a row swiped left asks for the row's actions, a pane swiped right
   goes back, and a pinch is the browser's zoom. Those are listed under the
   lock in the Gestures panel (`FIXED_GESTURES`) and a file that names one
   (`swipe-right: …`, `pinch: …`) is refused with its reason, as a reserved key
   is. A bindable gesture is therefore one a thumb cannot make by accident: two
   fingers, or the phone itself. A gesture is never the only road: each default
   is also a key and an on-screen control (ADR 0065; WCAG 2.5.1 asks for a
   single-pointer alternative to a multipoint or path gesture, and there is
   one for each).

4. **The guardrails of ADR 0156 hold, and are stricter.** A command that asks
   before it acts (`item.trash`, `item.share`, `item.purge`) cannot be bound
   to a gesture at all — not even to its own, because none ships on one — so no
   accidental swipe or shake can reach authority. A register key waits for a
   letter a hand cannot give, so `register.*` is refused too. A target may not
   be a URL, a macro must exist, and a gesture whose macro is deleted or renamed
   follows it (`retargetKeys` moves gestures with keys). The Gestures panel
   never offers what the file would refuse.

5. **A gesture stands down where a key does.** While a field holds the keyboard,
   a modal dialog is open, or a context menu is, a gesture does nothing. A
   touch that began there is ignored to its end. A two-finger *swipe* counts only
   when both fingers began in the same listing (the vault list or the rail tree):
   outside one, two fingers scroll the page as they always did. A tap and a
   shake act from anywhere. A swipe is **claimed** (its `touchmove` cancelled,
   so the list does not also scroll) only once it is sure — travelled past a
   12px slop, both fingers the same way, the gap between them held — **and**
   only when that gesture is bound, so an unbound or struck two-finger drag still
   scrolls. The claim is held for the swipe's own 900 ms and no longer: a slower
   two-finger drag is a scroll, not a flick, and is let go to the browser rather
   than stranded between a gesture it will never be and a scroll it was denied. A third finger, a pinch, a second finger that landed late (over
   180 ms), a drag over 900 ms, or a tap that wandered over 16px is not a
   gesture. The numbers live in one place (`RECOGNIZER`,
   `lib/keymap/gesture-recognizer.ts`), which is pure: a shell feeds it points
   and asks which gesture, so any shell can reuse it.

6. **A shake is the one gesture made by moving the phone, and it is opt-out
   and permission-aware.** Four hard jolts inside a second, none closer than
   90 ms, then two seconds of rest (`SHAKE`): one bump, a step or a phone set
   down is not a shake. It is switched by `motion: false` (WCAG 2.5.4 Motion
   Actuation) from the panel's switch, which is not drawn where the browser has
   no motion sensor at all (ADR 0158). Where the browser asks first (iOS
   Safari), nothing asks on its own: the panel draws an **Allow** key beside the
   switch, only a press of it calls `DeviceMotionEvent.requestPermission`, and a
   refusal is drawn as a status mark that says where to change it. The sensor
   is listened to only while a shake is bound **and** motion is on, so a phone
   that never shakes never runs it.

7. **The file is the same file.** `settings/keybindings/config.yaml` gains
   `gestures:` (gesture name → action id, `~` or `nop` strikes one) and
   `motion:` (written only once it is off), sparse against the defaults like
   `keybindings:`; the Form and the file view round trip with comments kept,
   `gestures:` completes its names and the actions a gesture may take, and a
   stored keymap is salvaged entry by entry as before, so a gesture a later build
   retires costs the person that one gesture:

   ```yaml
   gestures:
     two-finger-tap: item.favorite
     shake: ~
   motion: false
   ```

8. **Each loadout resets on its own tab.** The Keyboard tab's reset forgets keys
   and macros and keeps the gestures that name no macro (those would otherwise
   dangle); the Gestures tab's forgets gestures and `motion` and keeps the keys.
   The reset key is not drawn while there is nothing to forget.

9. **The `?` sheet a finger reads is the gestures in force** — the fixed
   gestures and visible keys, then one row per bound gesture with what it runs
   now — and a shake the phone cannot make, or that is switched off, is not
   listed, so the sheet never promises what nothing does.

## Consequences

- A phone's Keybindings page opens on Gestures: one row per gesture with its
  glyph, name and id, what it runs as a native choice (grouped like the Keymap
  table, then the person's macros, with no command that asks first), a reset key
  once changed, and the fixed gestures under the lock. A target this plan does
  not have is drawn under "Not on this plan" so a row never says a gesture runs
  nothing while the file says it runs something.
- `verify:mobile` and `verify:keyboard` are the gates for the Settings page
  itself; the gesture runtime is covered by tests that drive real touch
  sequences through the recognizer and the handlers (`gesture-runtime.test.ts`),
  not by a spy on the handler, and the recognizer by its own numbers
  (`gesture-recognizer.test.ts`).
- A device keeps its own loadout choice implicitly (the tab opens on the
  pointer in use), not as a stored preference: there is nothing to forget, and
  a convertible changes loadout with its pointer.
- Adding a gesture is a row in `GESTURES` (`lib/keymap/gestures.ts`) and a
  case in the recognizer; nothing renames a gesture id, as nothing renames a
  command id.
