/**
 * Every command a key or a macro may name (ADR 0156). The shell's keymap binds
 * these ids to what they do; Settings › Keybindings draws one row per command;
 * the `config.yaml` names them. A command id is stable — a person's file names
 * it — so one is never renamed. A retired id is refused by a panel or a file,
 * and dropped from a stored keymap on load, leaving the rest of it (`salvage.ts`).
 */
import { contributionsSnapshot } from "../contributions.js";

/**
 * What a command may touch. `navigate` moves, `draft` opens an editor,
 * `mutate` changes an item, `reveal` copies, `voice` opens the microphone.
 * `authority` (trash, share, delete) is locked: no remap onto it, and no
 * macro may run it. An `on:` trigger runs `navigate` only.
 */
export type CommandKind =
  | "navigate"
  | "draft"
  | "mutate"
  | "reveal"
  | "voice"
  | "authority"
  | "nop";

export type CommandGroup = "move" | "find" | "item" | "macros" | "go";

export type KeymapCommand = Readonly<{
  id: string;
  label: string;
  group: CommandGroup;
  kind: CommandKind;
  /** Default sequences, in the notation of `notation.ts`. */
  defaults: readonly string[];
  /** A count prefix (`5j`) repeats it, or picks a row (`5G`). */
  counts?: boolean;
}>;

export const GROUP_LABEL = {
  move: "Move",
  find: "Find and ask",
  item: "Item",
  macros: "Macros",
  go: "Go to",
} as const satisfies Readonly<Record<CommandGroup, string>>;

export const GROUP_ORDER: readonly CommandGroup[] = [
  "move",
  "find",
  "item",
  "macros",
  "go",
];

/** A binding to `nop` is an unbind: vim's `<Nop>`, VS Code's `-command`. */
export const NOP = "nop";

/** A macro is bound as `macro.<name>`. */
export const MACRO_PREFIX = "macro.";

/**
 * vim's `q{register}` and `@{register}`: the key waits for a letter a–z. The
 * shell runs these itself, and no macro or event may name one.
 */
export const REGISTER_PREFIX = "register.";
export const REGISTER_RECORD = `${REGISTER_PREFIX}record`;
export const REGISTER_REPLAY = `${REGISTER_PREFIX}replay`;

/** A section jump is `section.<first path segment>`: `section.vault`. */
export const SECTION_PREFIX = "section.";

const COMMANDS: readonly KeymapCommand[] = [
  {
    id: "listing.next",
    label: "Next row",
    group: "move",
    kind: "navigate",
    defaults: ["j", "ArrowDown"],
    counts: true,
  },
  {
    id: "listing.previous",
    label: "Previous row",
    group: "move",
    kind: "navigate",
    defaults: ["k", "ArrowUp", "Control+p"],
    counts: true,
  },
  {
    id: "listing.first",
    label: "First row, or row N",
    group: "move",
    kind: "navigate",
    defaults: ["g g", "Home", "0"],
    counts: true,
  },
  {
    id: "listing.last",
    label: "Last row, or row N",
    group: "move",
    kind: "navigate",
    defaults: ["G", "$", "End"],
    counts: true,
  },
  {
    id: "listing.high",
    label: "Top of the window",
    group: "move",
    kind: "navigate",
    defaults: ["H"],
  },
  {
    id: "listing.mid",
    label: "Middle of the window",
    group: "move",
    kind: "navigate",
    defaults: ["M"],
  },
  {
    id: "listing.low",
    label: "Bottom of the window",
    group: "move",
    kind: "navigate",
    defaults: ["L"],
  },
  {
    id: "listing.half-down",
    label: "Half a page down",
    group: "move",
    kind: "navigate",
    defaults: ["Control+d"],
    counts: true,
  },
  {
    id: "listing.half-up",
    label: "Half a page up",
    group: "move",
    kind: "navigate",
    defaults: ["Control+u"],
    counts: true,
  },
  {
    id: "listing.page-down",
    label: "Page down",
    group: "move",
    kind: "navigate",
    defaults: ["PageDown", "Control+f"],
    counts: true,
  },
  {
    id: "listing.page-up",
    label: "Page up",
    group: "move",
    kind: "navigate",
    defaults: ["PageUp", "Control+b"],
    counts: true,
  },
  {
    id: "listing.dive",
    label: "Dive in",
    group: "move",
    kind: "navigate",
    defaults: ["l", "ArrowRight"],
    counts: true,
  },
  {
    id: "listing.climb",
    label: "Climb out",
    group: "move",
    kind: "navigate",
    defaults: ["h", "ArrowLeft", "Backspace"],
    counts: true,
  },
  {
    id: "listing.search",
    label: "Search this pane",
    group: "find",
    kind: "navigate",
    defaults: ["/"],
  },
  {
    id: "command.palette",
    label: "Command bar",
    group: "find",
    kind: "navigate",
    defaults: ["Control+l", ":"],
  },
  {
    id: "help.keymap",
    label: "Keyboard help",
    group: "find",
    kind: "navigate",
    defaults: ["?"],
  },
  {
    id: "voice.toggle",
    label: "Push to speak",
    group: "find",
    kind: "voice",
    defaults: ["m"],
  },
  {
    id: "item.copy-secret",
    label: "Copy secret",
    group: "item",
    kind: "reveal",
    defaults: ["y"],
  },
  {
    id: "item.copy-username",
    label: "Copy username",
    group: "item",
    kind: "reveal",
    defaults: ["u"],
  },
  {
    id: "item.edit",
    label: "Edit",
    group: "item",
    kind: "draft",
    defaults: ["e"],
  },
  {
    id: "item.new",
    label: "New item",
    group: "item",
    kind: "draft",
    defaults: ["n"],
  },
  {
    id: "item.favorite",
    label: "Favorite",
    group: "item",
    kind: "mutate",
    defaults: ["."],
  },
  {
    id: "item.trash",
    label: "Move to trash",
    group: "item",
    kind: "authority",
    defaults: ["x"],
  },
  {
    id: "item.share",
    label: "Share once",
    group: "item",
    kind: "authority",
    defaults: ["s"],
  },
  {
    id: "item.restore",
    label: "Restore",
    group: "item",
    kind: "mutate",
    defaults: ["r"],
  },
  {
    id: "item.purge",
    label: "Delete permanently",
    group: "item",
    kind: "authority",
    defaults: ["X"],
  },
  {
    id: REGISTER_RECORD,
    label: "Record a macro into a register",
    group: "macros",
    kind: "navigate",
    defaults: ["q"],
  },
  {
    id: REGISTER_REPLAY,
    label: "Replay a register",
    group: "macros",
    kind: "navigate",
    defaults: ["@"],
    counts: true,
  },
  {
    id: "session.join",
    label: "Join a session",
    group: "go",
    kind: "navigate",
    defaults: ["g j"],
  },
];

/** The two jumps the core shell always has; the rest arrive as contributions. */
const CORE_JUMPS: readonly { key: string; path: string; label: string }[] = [
  { key: "v", path: "/vault", label: "Vault" },
  { key: "s", path: "/settings", label: "Settings" },
];

/** `/connections/catalog` → `section.connections`. */
export function sectionCommandId(path: string): string {
  const segment = path.replace(/^\/+/, "").split("/")[0] ?? "";
  return `${SECTION_PREFIX}${segment}`;
}

/** The label a contributed section is drawn with in the rail. */
function sectionLabel(path: string): string {
  const section = contributionsSnapshot("section").find(
    (entry) => entry.to === path,
  );
  const fallback = path.replace(/^\/+/, "").split("/")[0] ?? path;
  return section?.label ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

/** Every section jump registered right now: core first, then contributions. */
export function sectionCommands(): readonly KeymapCommand[] {
  const seen = new Set<string>();
  const jumps: KeymapCommand[] = [];
  const add = (key: string, path: string, label: string) => {
    const id = sectionCommandId(path);
    if (seen.has(id)) return;
    seen.add(id);
    const taken = jumps.some((jump) => jump.defaults.includes(`g ${key}`));
    jumps.push({
      id,
      label,
      group: "go",
      kind: "navigate",
      defaults: taken ? [] : [`g ${key}`],
    });
  };
  for (const jump of CORE_JUMPS) add(jump.key, jump.path, jump.label);
  for (const jump of contributionsSnapshot("keymap-jump")) {
    add(jump.key, jump.path, sectionLabel(jump.path));
  }
  return jumps;
}

/** The commands every plan has: the fixed ones and the two core jumps. */
export const CORE_COMMANDS: readonly KeymapCommand[] = [
  ...COMMANDS,
  ...CORE_JUMPS.map((jump) => ({
    id: sectionCommandId(jump.path),
    label: jump.label,
    group: "go" as const,
    kind: "navigate" as const,
    defaults: [`g ${jump.key}`],
  })),
];

/** The whole catalogue for this plan: fixed commands, then the jumps. */
export function keymapCommands(): readonly KeymapCommand[] {
  return [...COMMANDS, ...sectionCommands()];
}

export function commandById(
  id: string,
  commands: readonly KeymapCommand[] = keymapCommands(),
): KeymapCommand | undefined {
  return commands.find((command) => command.id === id);
}

/** Fixed keys: Tab, Enter, Escape, F6, counts, and the browser's tab and window keys. */
const reserved = new Map([
  ["Tab", "Next control"],
  ["Shift+Tab", "Previous control"],
  ["Enter", "Open or activate"],
  ["Shift+Enter", "Actions for the row"],
  ["Escape", "Leave the field, then the pane"],
  ["F6", "Other listing"],
  ["Shift+F10", "Actions for the row"],
  ["ContextMenu", "Actions for the row"],
  ["Control+Tab", "The browser's"],
  ["Control+Shift+Tab", "The browser's"],
  ["Control+PageUp", "The browser's"],
  ["Control+PageDown", "The browser's"],
  ["Control+w", "The browser's"],
  ["Control+t", "The browser's"],
  ["Control+T", "The browser's"],
  ["Control+W", "The browser's"],
  ["Control+n", "The browser's"],
  ["Control+N", "The browser's"],
  ["Control+q", "The browser's"],
  ["Control+r", "The browser's"],
  ["F5", "The browser's"],
  ["F11", "The browser's"],
  ["F12", "The browser's"],
]);
for (const digit of "123456789") {
  reserved.set(digit, "Count");
  reserved.set(`Control+${digit}`, "The browser's");
}
export const RESERVED_KEYS: ReadonlyMap<string, string> = reserved;

/** The fixed rows Settings › Keybindings lists under its lock. */
export const FIXED_ROWS: readonly (readonly [keys: string, label: string])[] = [
  ["Tab / Shift+Tab", "Next or previous control"],
  ["Enter", "Open or activate"],
  ["Escape", "Leave the field, then the pane"],
  ["F6", "Other listing"],
  ["Shift+F10 / Shift+Enter / ContextMenu", "Actions for the row"],
  ["1 … 9", "Count before a key"],
];
