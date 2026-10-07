/**
 * The authored rows of the `?` sheet — must stay in lockstep with DESIGN.md
 * and the handler. Each row names the commands it speaks for: while none of
 * them has moved, the compact authored text is shown as it is; once a person
 * rebinds one, `keymap-help-rows.ts` rebuilds the row from the keys in force,
 * so a moved key is never drawn on its old command and an unbound command's
 * row is dropped.
 */

export type KeymapHelpRow = readonly [keys: string, action: string];

export type HelpSource = Readonly<{
  keys: string;
  action: string;
  /** Command ids the row speaks for; none for the fixed keys. */
  commands: readonly string[];
  /** A fixed key the authored row names (Enter, Esc): kept when it is rebuilt. */
  fixed?: KeymapHelpRow;
  /** The row shows a count before the key (`3j`). */
  counted?: boolean;
}>;

export const HELP_SOURCES: readonly HelpSource[] = [
  // On `/claim`, Ctrl-l is left to the browser address bar (`keymap.ts`).
  // `:` still opens the command bar. The sheet keeps this authored row.
  { keys: "Ctrl-l / :", action: "Command bar", commands: ["command.palette"] },
  { keys: "m", action: "Push to speak", commands: ["voice.toggle"] },
  {
    keys: "j / k or arrows",
    action: "Move",
    commands: ["listing.next", "listing.previous"],
  },
  {
    keys: "3j  10k",
    action: "Repeat a motion",
    commands: ["listing.next", "listing.previous"],
    counted: true,
  },
  {
    keys: "Ctrl-d / u",
    action: "Half-page",
    commands: ["listing.half-down", "listing.half-up"],
  },
  {
    keys: "Ctrl-f / b or PgUp/Dn",
    action: "Page",
    commands: ["listing.page-down", "listing.page-up"],
  },
  {
    keys: "H / M / L",
    action: "High, mid, low",
    commands: ["listing.high", "listing.mid", "listing.low"],
  },
  {
    keys: "gg / G  0 / $",
    action: "First or last",
    commands: ["listing.first", "listing.last"],
  },
  {
    keys: "l / h  Enter  Backspace",
    action: "Dive or climb",
    commands: ["listing.dive", "listing.climb"],
    fixed: ["Enter", "Open or activate"],
  },
  { keys: "Tab / Shift-Tab", action: "Next or previous control", commands: [] },
  { keys: "F6", action: "Other listing", commands: [] },
  {
    keys: "/  Esc",
    action: "Search or focus the tree",
    commands: ["listing.search"],
    fixed: ["Esc", "Leave the field, then the pane"],
  },
  {
    keys: "y / u",
    action: "Copy secret or username",
    commands: ["item.copy-secret", "item.copy-username"],
  },
  {
    keys: "e / x",
    action: "Edit or trash",
    commands: ["item.edit", "item.trash"],
  },
  {
    keys: "n / .",
    action: "New or favorite",
    commands: ["item.new", "item.favorite"],
  },
  { keys: "s", action: "Share", commands: ["item.share"] },
  {
    keys: "qa … q  @a  @@",
    action: "Record or replay a macro",
    commands: ["register.record", "register.replay"],
  },
  {
    keys: "Shift-F10 / Shift-Enter / Menu",
    action: "Actions for the focused row",
    commands: [],
  },
];

/** The authored rows as they read before anyone rebinds a key. */
export const KEYMAP_HELP_CORE: readonly KeymapHelpRow[] = HELP_SOURCES.map(
  ({ keys, action }) => [keys, action] as const,
);

/** What a capability brought that the sheet names: its row shows only then. */
export type KeymapExtras = Readonly<{ voice: boolean; share: boolean }>;

/** `voice.toggle` belongs to the on-device model's voice, `item.share` to secret drops. */
const GATED = new Map<string, keyof KeymapExtras>([
  ["voice.toggle", "voice"],
  ["item.share", "share"],
]);

/** The authored rows whose capability, if any, contributed its control. */
export function offeredSources(extras: KeymapExtras): readonly HelpSource[] {
  return HELP_SOURCES.filter((source) =>
    source.commands.every((id) => {
      const gate = GATED.get(id);
      return gate === undefined || extras[gate];
    }),
  );
}
