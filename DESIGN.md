---
name: OpenSesame
description: End-to-end encrypted vault for humans, agents, websites, and developers
colors:
  canvas: "#fafafa"
  surface: "#ffffff"
  surface-2: "#f5f5f5"
  surface-3: "#ededed"
  rail: "#fafafa"
  rail-fg: "#171717"
  ink: "#171717"
  ink-2: "#5c5c5c"
  ink-3: "#6f6f6f"
  line: "#e7e7e7"
  line-strong: "#d4d4d4"
  accent: "#0d7268"
  accent-ink: "#ffffff"
  accent-wash: "#eaf2f0"
  scrim: "rgba(0, 0, 0, 0.44)"
  ok: "#0f7a51"
  warn: "#a25a05"
  err: "#b32424"
typography:
  display:
    fontFamily: "system mono stack (ui-monospace, SF Mono, Menlo, …)"
    fontSize: "1.4rem"
    fontWeight: 600
    letterSpacing: "-0.021em"
  headline:
    fontFamily: "system mono stack"
    fontSize: "1.0625rem"
    fontWeight: 600
  chrome:
    fontFamily: "system mono stack"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "system-ui"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system mono stack"
    fontSize: "0.75rem"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
rounded:
  md: "2px"
  lg: "2px"
  pill: "999px"
spacing:
  sm: "0.4rem"
  md: "0.9rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  item-row:
    backgroundColor: "transparent"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.6rem"
---

# Design System: OpenSesame

## Overview

**Creative North Star: "One vault, four readings."**

OpenSesame is an end-to-end encrypted vault. A human uses it as a password
manager and passkey store, an agent as a secret store it can never read out, a
website as an auth broker, and a developer as an authority. The same encrypted
store underlies all four, and the interface has to make each one feel like the
product was built for them.

The craft bar is Bitwarden and 1Password. Password-manager canon — unlock gate,
list and detail, conceal by default, copy without revealing — is followed
because users already know it, executed with Scandinavian restraint: a neutral
black-and-white foundation, teal as the single accent, and nothing decorative.

**Key characteristics:**
- Master-password gate, no PIN theater, no recovery path
- One paper surface: the whole workspace is a light, hairline-divided
  terminal — mono filesystem rail, content buffer, statusline. Dark mode
  inverts the same system onto near-black paper.
- Teal is the single accent, and it means state and identity: the cursor,
  the active row, focus, links, and the brand mark. Primary actions are ink.
- Scandinavian restraint: zero-spread neutrals, sentence case everywhere,
  hairline rules and chapters instead of boxed cards, 6/10px radii, no
  decorative gradients or shadows
- List-and-detail spine for the vault; flowing chapter documents for the
  plane-backed sections
- System font stack — no webfont request, no flash, no third-party origin
- Sample data always badged

## Mark

The mark is **the door ajar**: the vault slab slid aside with a slit of
light where it opened — Open Sesame's own story, drawn as two sharp
rectangles. The slab is ink, the light is the accent teal; this is the one
place teal means identity rather than state. In the chrome the mark is
bare — no tile, no circle, no badge — beside the lowercase mono wordmark
`open-sesame`. Only the OS app icon puts it on a dark tile with the
platform's mask. The old padlock-in-a-teal-tile is retired everywhere.

The wordmark reveals through eleven character-sized background slots. Each slot
steps through hexadecimal ciphertext and locks to its letter before the next
begins: randomly 6–12 glyph cycles at 35ms each, once on entry, without delaying
interaction. Counts stay fixed through re-renders; the full reveal takes 2.31–4.62s.
The reels are decorative; assistive technology reads `open-sesame` once.
Reduced motion shows the completed word immediately. All front doors and the
desktop rail use the same `Wordmark` component.

## Colors

Neutrals carry the interface. Teal is scarce enough to mean something.

### Primary
- **Accent** (#0d7268): state and identity only — the tree cursor, active
  navigation, focus rings, links, the brand mark, and the strongest step of
  the strength meter. Primary buttons are ink, not accent. In dark mode the
  accent lifts to #2fb3a3.

### Neutral
All neutrals are zero-spread grays — no warm or cool casts anywhere in chrome.
- **Rail** (#fafafa): the navigation plane shares the canvas — one paper
  surface, separated from the buffer by a hairline, not a color change.
- **Canvas** (#fafafa): the ground everything sits on.
- **Surface** (#ffffff): panels and cards.
- **Ink / Ink-2 / Ink-3** (#171717 / #5c5c5c / #6f6f6f): the ink ladder —
  primary, supporting, and metadata text, stepped like alpha-black on white
  (roughly 100% / 64% / 56%). The lowest rung stays above 4.5:1 on white.

### Status
**ok** #0f7a51, **warn** #a25a05, **err** #b32424, each with a wash for filled
callouts. The password strength ramp (`--s-0` … `--s-4`) runs red → amber →
green → teal so "excellent" lands on the brand color.

### Named rules

**The Competitor Marks Rule.** Match Bitwarden's habits, never its brand.

**The Honest Crypto Rule.** Every claim in the interface is one the code makes
true. If copy says nothing leaves the device, nothing leaves the device — the
health report is computed locally and contacts no breach service, and TOTP codes
are derived in the page.

**The No-Recovery Rule.** The absence of a recovery path is stated before the
vault is created, acknowledged with a checkbox, and repeated where it matters.
Never soften it.

## Typography

The chrome speaks mono — the terminal voice. Every control, heading, label,
navigation entry, and data value sets in the system mono stack at 14px.
Prose is the one exception: paragraphs and hints read in the system sans
stack at a readable measure, because explanations are for reading, not
scanning.

### Hierarchy
- Page and detail titles ~1.4rem, weight 600, tight tracking
- Panel headings ~1.0625rem
- Body 15px / 1.5
- Field labels 0.75rem, weight 600, sentence case — never all-caps, never
  tracked out; hierarchy comes from size, ink rung, and space, not from
  shouting. Weights stop at 600.
- Numbers that change in place use `font-variant-numeric: tabular-nums`

## Layout

Desktop is a 15.5rem rail plus content over a full-width statusline — the
terminal frame: tree on the left, buffer in the middle, one mono strip of
plane truth (connectivity, notifications, lock) at the foot. The vault adds
a 21rem list column between rail and detail, giving ranger's three panes;
the other sections read as a single 60rem flowing document of chapters.

Below 900px the rail gives way to a slim top bar (identity and the lock),
the statusline keeps carrying plane truth, a five-item tab bar closes the
frame, and the vault collapses to one pane at a time with a back key and a
back swipe. Because the rail carries the vault's
filters, the list header grows a scrolling chip row at that breakpoint —
nothing in the rail may become unreachable.

Prose is measured (roughly 48–62ch). A paragraph is never as wide as a panel.

### VFS interaction model

The workspace is a filesystem, not a webpage. Every vault is a tomb with a
canonical path space — `personal:/Work/GitHub` — folders are directories,
the session context is a shell prompt (`guest@personal:/` — each segment a
button that opens its switcher; never a widget stack of dropdowns),
items are files with kind pseudo-extensions (`GitHub.login`, `Deploy
webhook.secret`), and the vault list renders as a compact first-party mono
file tree (ADR 0073), never as a card wall. The navigation rail is the same
tree one level up: sections are directories off the tomb root (`vault/`,
`connections/`, `access/`, `identity/`, `settings/`), each advertising its
`g`-jump key; the active section starts open but its parent row toggles
expand/collapse without changing the selected child. Arrow Left/Right use the
same behavior. Rows without children remain navigation links. The vault's
filter views, folders, and `health` — and the settings categories — appear
under their parent as entries with live counts. A path strip pins the tomb
root at the top of the vault pane; the mobile tab bar keeps labeled icons.

A visible cursor row owns focus — inverse video, always rendered — and
moving it with the keyboard previews that item in the buffer, ranger's own
reading: browsing is previewing. The pane has no header; new and import are
icon keys in the path strip. Motions are vim's: `j`/`k`/arrows move, a
count prefix repeats them (`5j`), `Ctrl-d`/`u` half-page, `Ctrl-f`/`b` and
`PgUp`/`PgDn` page, `H`/`M`/`L` jump to the high/mid/low of the window,
`gg`/`0`/`Home` first, `G`/`$`/`End` last (`5G` the fifth row). `l`/`→`
dives (and from the rail, into the vault listing), `h`/`←`/`Backspace`
climbs (and from a vault root row, onto the rail). `F6` switches the two
listings when one of them holds the keyboard. `Tab`/`Shift-Tab` always follow
native control order and can leave either listing. `Enter` activates the
focused control; the tree keymap must never swallow a link or button. `/` opens
a vim-style command line at the foot of the pane, backed by a real input so
typed keys never leak into the keymap; matches highlight, non-matches hide,
`Esc` closes it and returns the keyboard to the tree. Item verbs are single
keys: `y` copies the secret, `u` the username, `e` edits, `x` trashes, `n`
creates, `.` toggles favorite, and `s` shares a secret once. `g v/c/a/i/s`
jumps between sections (`g` times out like vim so a stray `g` does not
swallow the next key) and `?` shows the keymap. A mono status line always
shows the focused path, item count, and active filter (or the live query).
Pointer access remains complete: rows click, directories toggle, a `⋯` menu
on the cursor or hovered row carries the verbs, and the `/` and `?` key
chips in the path strip are buttons.

The keyboard lands on arrival, every time. A page load, an unlock, a route
change, a browser Back, a switched tab — each leaves focus on `<body>` unless
the screen claims it, and from `<body>` the first Tab starts at the top of the
document, the cursor has no home, and a phone shows no keyboard. So every
screen owns its landing (`lib/focus.ts`): the unlock form's secret field (or
its go control for passkey), the first road of setup, the first vault on the
front door, the tree — or the "New item" link of an empty vault — in the
vault, and the content of a framed section. A landing yields to a caret
something else already placed (an editor's first field), and on a phone it
follows the visible pane. Opening the item the cursor already previews
replaces the history entry rather than pushing a second one, so Back always
goes somewhere.

## Touch

A finger is not a mouse pointer, and the phone is not a narrow desktop.

- **Nothing may make the document wider than the device.** Every pane in the
  grid/flex chain is pinned to `min-width: 0` so a `nowrap` row truncates
  instead of dictating the page width; a page that overflows sideways gets
  shrink-to-fit, which scales every target away from where it is drawn.
- **44px is the floor.** Under `(pointer: coarse)` every row, key, chip and
  tab is at least 2.75rem. The mono density survives the change: the row
  grows, the type does not.
- **Nothing waits to find out it was a tap.** Interactive elements set
  `touch-action: manipulation`, drop the platform tap highlight, and answer
  with a `:active` ink instead.
- **Every hover-only affordance has a touch twin.** The `⋯` row menu is
  revealed by hover for a mouse and by a long press for a finger; the back
  key is also a rightward swipe on the pane. Nothing is gesture-only.
- **The frame is rows, not overlays.** The tab bar is a row of the app grid
  rather than a bar floating over the content, so nothing scrolls under it,
  and `env(safe-area-inset-*)` keeps it clear of the home indicator.
- **Scrollers contain their own overscroll** and never hand a flick to the
  page behind them.
- **The keyboard is not summoned uninvited**: a form does not autofocus on a
  touch pointer, where it would throw the keyboard over the record.

## Elevation & Depth

Hairline borders carry structure; shadows exist only where elevation
communicates behavior (menus, popovers, the unlock card), and even there they
are neutral and barely visible. Panels are bordered, not floated. Rows are
flat with hairline separators.

## Shapes

All-sharp, one documented scale: 2px on every control, chip, badge, and menu
(just enough to keep focus rings clean). Pills survive only where the
mechanic is genuinely round — switch tracks and meter segments. The mark is
bare in the chrome; only the OS app icon keeps a tile and its platform
mask.

## Selection

Selection is inverse video, the terminal's own idiom: the tree cursor, the
rail's current leaf, and pressed toggles render paper-on-ink. Exactly one
row in a tree is inverse at a time — the open directory above a selected
leaf shows only its open caret and weight. Teal never marks selection.

## Components

### Actions are symbols
An action that executes — edit, trash, copy, reveal, rotate, restore, new,
import, save, cancel, lock — renders as an icon key: a square icon button
whose `aria-label` and tooltip carry the sentence. Text survives on a
button only where it is the object of a choice (a provider, a mode, a
navigation target) or where a destructive ceremony must be spelled out.
Never a text verb stretched across a grid row.

The vault pane always retains its top path-strip command group: **+**, import,
export, each an icon key with an accessible name and tooltip. Empty, filtered,
and trash views use the same group. Replacing it with text-labelled New item,
Import, or Export buttons in an empty state is a hard design violation,
enforced by `pnpm lint:design` and the vault render tests.

### Buttons
Ink fill for the primary action (inverting to paper-on-ink in dark mode),
surface fill with a hairline for secondary, ghost for tertiary, and a
red-tinted variant for anything destructive. One primary per view, sized to
its content — never block-width.

### Forms are records
A form is a record being filled in, not a wall of boxes: each field is a
row — mono label column on the left, value on the right — and inputs are
ruled underlines on the paper (focus thickens the rule to ink). The vault
editor goes further: the item is a file, so its name is the document title,
its kind the extension beside it, and save/cancel follow all fields in both
visual and natural keyboard order. Repeatable groups grow with a `+` key beside their label.
An explicit `/vault/new/:kind` fixes the type as an extension label; only
`/vault/new` offers a type picker. Unknown types are refused with a link to
choose an installed type, never silently replaced with a login.
The title reads folder / name / type, with one folder selector before the name.
On name blur, slash paths resolve relative to the selected folder (`/` starts
at the vault root, `..` moves up), select their folder and leave only the leaf
name. New folders remain drafts until the item is saved; escaping the root or
omitting the leaf is an error, not a guessed item name.
Login Websites precedes Username. Wildcard (`*.example.com`) and regex
(`(.*\.)?example\.com`, without delimiters/flags) are explicit match modes,
applied case-insensitively to the entire hostname, never a URL path or query.
`*.example.com` excludes the apex; add `example.com` separately when needed.
The local Test match control evaluates a pattern in a disposable worker with
a one-second timeout and a 256-character pattern limit. Invalid patterns cannot
be saved; patterns are not clickable links, authorization rules or autofill.
Sealed-store manifests retain the selected mode across export/import.
Across vault item forms, optional metadata, notes, custom fields and pinning start
as explicit Add/Pin commands, not empty inputs. Commands reveal and focus the
field; existing values are always visible when editing. Clearing a revealed
field does not collapse it or discard other values. Note items keep their
primary Notes editor visible. Manifest-defined forms honor required fields;
empty optional fields use Add commands, including repeating and composite fields.
Certificate alternative DNS/IP names are opt-in, never silently prefilled.
Every type uses the shared folder/name title and native document tab order,
with Save and Cancel after the fields. Drop retention stays an explicit,
unchecked custody choice; payload and expiry remain visible.

### Field rows
The vault's atom: a small sentence-case label, value, and right-aligned
actions. Secrets render as dots with a reveal toggle, and copy never requires
revealing first.

### Navigation
The rail renders as a mono filesystem tree (see "VFS interaction model")
rooted at the prompt line `guest@personal:/`: directory rows with counts
and g-jump key chips. Selection is inverse video (see "Selection"). The
mobile tab bar mirrors the five sections and nothing else.
Password health is a notifications-only review, never a tree entry or vault filter chip.

Identity's children and its content tabs share the URL's `view` selection;
the rail and tabs always name the same view. Connections has separate
Connected and Add a Connection branches. Moving the connector cursor previews
the corresponding service or catalog entry in the buffer, scrolls it into view,
and outlines it in teal; the rail cursor remains inverse video. Enter or a
click opens the connector. Directional movement never starts its ceremony.
The searchable catalog grows twelve entries at a time. Load more is the final
indexed tree row, reachable by the same motions as a connector; activation
selects the first newly added entry. New rows enter over 180ms with a small
upward settle; reduced motion removes the animation.

### Tabs
Flat underline tabs on a hairline: text with a 2px accent underline for the
selected view — never boxed segmented controls.

### Local directory records
People, agents, applications, and organizations use the existing bordered
panel, identity rows, status chips, and record form. The name and stable
reference lead each row; editing opens one Name field with Save and Cancel
after it. While a draft is open, New and other row mutations are disabled.
Failed saves retain the draft and return focus to its field; closing the
form restores its initiating control when focus has not moved elsewhere.
Deletion requires an explicit confirmation. The panel states that these
records are local to the encrypted vault; creating a record alone grants
no resource access. Broader identity and access management remains incomplete.

### Local identity passkeys
Each People row has a native Passkeys disclosure. Opening it loads that
person's credentials; Enroll passkey and Sign in locally load the human
ceremony only when pressed. Credential rows stay flat inside the person row,
separated by hairlines, with a short credential suffix and enrollment date.
Pending results use inline outputs and errors use alerts. Disabled people
cannot enroll or sign in, but their credentials can still be revoked.

Revoke passkey becomes Confirm revocation beside Keep passkey. Keeping it
returns focus to Revoke passkey; successful removal returns focus to the
Passkeys summary only when the removed control held focus and focus has fallen
to the document body. Focus elsewhere is preserved.

Sign in locally verifies a passkey and shows the active local session and its
expiry; Sign out locally revokes it. Closing the disclosure or navigating away
does not sign out: reopening validates the stored session. Directory changes
(including disabling and re-enabling a person or changing a role), expiry, or
revoking its passkey require a fresh sign-in. Inline status explicitly reports
that no application access was granted; local authentication is not a claim
that broader IAM is complete.

### Local agent keys
Each Agents row has a native Agent keys disclosure. Public ES256 credentials
appear as flat, hairline-separated rows with a key suffix and enrollment date.
Enroll public key reveals and focuses a labeled Public key JWK textarea;
Save public key and Cancel enrollment follow it. Failed saves retain the draft.
Private keys are never requested. Disabled agents cannot enroll or authenticate,
but their keys remain revocable.

Authenticate agent opens a read-only, one-use challenge followed by a Signed
challenge textarea and Verify agent / Close challenge actions. The challenge
expires after two minutes; a failed verification requires a new challenge.
Its arrival focuses the challenge only if focus remains at the initiator or
has fallen to the body. Native fields scroll internally and record/action rows
wrap at narrow widths, retaining the existing typography and focus treatment.

Status distinguishes machine authentication from human approval and application
access; neither is granted by this session. Sign out agent revokes the session.
A read failure reports Local session unavailable, never an absent-session claim.
Revoke agent key requires Confirm key revocation or Keep agent key. Keeping it
restores the revoke control; closing a form or removing a key restores the
connected initiating control, or the disclosure summary if it was removed,
only when focus fell to the body. Focus moved elsewhere is preserved. This
pattern documents local agent authentication, not local application delegation
or completion of browser IAM; it introduces no raster imagery or new tokens.

### Local authenticators in Devices
Without a configured Identity API, Identity → Devices presents Authenticators
with the existing Reload directory icon. A short scope notice explains that
synced passkeys may span devices; the list describes this vault's sign-in keys,
not physical hardware. People and agents retain their name, wrapped public
reference and enabled state in the incumbent bordered identity rows. Their
native Passkeys and Agent keys disclosures reuse the enrollment, local sign-in
and confirmed revocation controls documented above. Credential rows remain
hairline-separated; actions wrap on mobile with visible teal keyboard focus.

Loading and read errors remain distinct from emptiness; an empty directory
links to Create a person. A failed directory read disables credential mutations
until recovery. Directory changes refresh the list. If a whole principal is
removed, Reload receives focus only when the previously focused control was
disconnected and focus fell to the body; deliberate focus elsewhere survives.
This extension introduces no tokens or imagery and does not establish completion
of broader browser IAM.

### Local organization members
Each organization row has a native Members disclosure. Existing members appear
as flat, hairline-separated rows with their names, role chips, and confirmed
removal. Keep member restores the removal button; confirming removal moves
focus to Members before the row changes. Errors remain in the directory panel.

The custodian assigns membership with labeled native Person or agent and
Organization role selects. Selecting an existing member loads its role and
changes Add member to Save role. People may be members, admins, or owners;
agents remain members. Empty organizations ask for an enabled person as the
first owner; removing, demoting, or disabling the last enabled owner is refused.
Role changes require local sessions to sign in again. These controls retain
the incumbent row wrapping, typography, hairlines, and focus treatment.

### Local application registration
Access → Policies reuses this same registration disclosure from Identity →
Applications, backed by the same encrypted store and role evaluator. Each
application keeps its name and stable public identifier together; the identifier
wraps beneath the name using the existing muted reference treatment. The panel
introduction keeps the established readable prose measure. Local policies work
without Host, with Host policies presented independently.

Each Applications row has a native Application registration disclosure. Its
record form uses a labeled Organization select, a bordered, vertically
resizable Redirect URIs textarea (one exact callback per line), and an
Allowed scopes input (space separated, including `openid`). Organizations
must be enabled and have an owner; when none qualify, the hint directs the
custodian to create an organization and assign its first owner. The controls
reuse the existing mono labels, ruled fields, hairlines, and focus treatment.

Roles allowed per scope follows the scope names, before Save registration.
Each scope groups native owner, admin, and member checkboxes; unchecked roles
are denied, including owners. New custom scopes start entirely unchecked.
Tab and Space retain native behavior, and role rows wrap on narrow screens.
Role choices share the retained draft and encrypted save/reload behavior;
selecting a role never replaces explicit sign-in consent.
Saving a changed policy invalidates existing application grants and requires
a new sign-in and explicit consent. Disabled applications remain visible with
their editor disabled; loading, safe read failures, and no applications are
distinct states. A failed directory refresh disables editing until recovery.

Save registration persists the encrypted configuration; Reload registration
reads it again. Loading and read errors never become a not-registered claim.
Failed saves retain the draft for correction or retry. Remove registration
becomes Confirm removal beside Keep registration; keeping it returns focus
to Remove registration. After a save, focus returns to the initiating control
only if it is still connected and focus fell to the document body; after
removal, the disclosure summary provides that fallback. Focus moved elsewhere
is preserved.

Inline status distinguishes registration from authorization. Exact HTTPS
callbacks (or loopback HTTP for development) and allowed scopes configure
admission; they do not issue tokens, grant sign-in or resource access, or
establish completion of browser IAM (ADR 0106).

### Local application consent
The consent panel leads with the application name and requesting origin; a
native disclosure reveals the exact callback. Agent requests also name the
agent and disclose its identity and enrolled public key reference, followed
by requested scopes. The native Approving person selector lists enabled owners
and admins in the application's organization. Verify with passkey precedes a
separate Allow agent access action beside Deny. Person requests retain Person
and Allow application. Inline outputs report connection state, alerts carry
failures, and active connections offer End application session. Controls reuse
the existing record layout, ink action and teal focus; long references wrap.
This pattern records the consent surface, not completion of broader browser IAM.

### Local requests
Access → Requests uses the existing panel with New and Reload icon commands,
flat ruled rows, a truthful count, and wrapped public request references.
One inline fieldset opens at a time. Creation reuses local person/agent
authentication and labeled native fields for application, exact registered
callback, scopes and reason; failures retain the draft. Status is an inline
output and read failures remain alerts, distinct from an empty list.

Review names the requester, application, organization, reason, scopes and
callback. Only pending requests offer an authorized-person selector and
request-bound Approve with passkey / Deny with passkey actions. The open review
resolves its record by ID against current data: expiry and external decisions
remove obsolete approval controls. Active focus is preserved; disappearing
controls or records restore useful focus within the review or to the connected
initiator, falling back to Reload. Withdrawal and settled-history removal each
require confirmation. Native controls, ink actions, teal focus and wrapping
action rows retain the incumbent desktop/mobile treatment.

Requests expire after five minutes. Creation grants no access; approval never
bypasses application policy. Popup application consent now creates a transaction-
bound request, obtains a fresh request-bound passkey decision, consumes approval
once, then issues through the existing PKCE code flow. The binding covers the
client, callback, scopes, state, nonce, PKCE and agent. An organization member
may consent only to their own bound sign-in; manual and agent requests require
an owner or admin. The same role-eligibility rule drives review controls and
enforcement. This describes the connected popup flow, not completion of broader
IAM or its full validation gates.

### Local sessions and grants
Access → Grants reuses this panel in a grant-only variant, showing encrypted
application grants without requiring Host. Access → Sessions retains the combined
sessions-and-grants ledger. Host delegation controls remain independently
available when configured. Flat, hairline-separated rows name the principal and application, with
scope, expiry and exact public record references. Counts describe recorded,
unexpired sessions and grants, never live connections; empty counts use a dash.
Loading and read failures remain distinct from an empty ledger.

Both variants use the same confirmed revocation. An inline fieldset names the exact record and consequence,
with Confirm revocation and Cancel revocation. Cancel receives initial focus;
closing returns focus to the source control, or Reload if the row was removed,
only when focus is idle. Moved focus is preserved. Success uses inline output;
failures remain alerts with reload/retry recovery. Long references and mobile
action rows wrap within the existing panel, using the incumbent ink buttons,
hairlines and teal focus treatment. Native focus scrolling brings confirmation
and restored controls into view; introductory prose keeps the readable measure.

### Callouts
`note` with `--ok`, `--warn`, `--err` variants for a stated condition. Live
regions are `<output>`, control groups are `<fieldset>`, so the accessibility
role comes from the element rather than an attribute.

### Empty states
An empty state must say what would be here and why it is not — offline,
unauthenticated, or genuinely empty — and offer the action that fills it, as
plain text with no icon tile. Vault commands stay in the top path strip, not
in a second empty-state button row. The vault's unselected buffer is two mono
lines: what is sealed, and the keys — because moving the cursor previews
items, there is nothing else for it to say. Password-health warnings live in
the global notifications panel so they remain visible from every section.

## Do's and Don'ts

### Do:
- **Do** conceal secret values by default and allow copying without revealing.
- **Do** state what a network-backed surface cannot show while offline or
  unauthenticated.
- **Do** badge sample data on every item and keep removing it to one action.
- **Do** treat a reload re-locking the vault as correct behavior and say so.

### Don't:
- **Don't** add a shortcut around the master password. A passkey or PIN may
  unlock the vault, but each is an alternate wrap of the same vault key,
  entered every time — never a remembered device and never a recovery path.
- **Don't** put a secret, or a hash of one, on the network.
- **Don't** let prose run the full width of a panel.
- **Don't** clone Bitwarden's brand identity.
