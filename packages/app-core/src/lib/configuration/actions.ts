export type ActionKind = "navigate" | "preference" | "draft" | "authority";

export type RegisteredAction = {
  id: string;
  label: string;
  defaultKeys: readonly string[];
  kind: ActionKind;
  /** Human confirmation required; keybindings cannot skip this. */
  requiresConfirmation: boolean;
};

/** Stable action vocabulary shared by keymap, help, menus, and palette. */
export const REGISTERED_ACTIONS: readonly RegisteredAction[] = [
  {
    id: "command.palette",
    label: "Command bar",
    defaultKeys: ["Control+l", ":"],
    kind: "navigate",
    requiresConfirmation: false,
  },
  {
    id: "listing.search",
    label: "Search this pane",
    defaultKeys: ["/"],
    kind: "navigate",
    requiresConfirmation: false,
  },
  {
    id: "listing.next",
    label: "Next row",
    defaultKeys: ["j"],
    kind: "navigate",
    requiresConfirmation: false,
  },
  {
    id: "item.trash",
    label: "Move to trash",
    defaultKeys: ["x"],
    kind: "authority",
    requiresConfirmation: true,
  },
  {
    id: "item.share",
    label: "Share once",
    defaultKeys: ["s"],
    kind: "authority",
    requiresConfirmation: true,
  },
  {
    id: "item.edit",
    label: "Edit",
    defaultKeys: ["e"],
    kind: "draft",
    requiresConfirmation: false,
  },
  {
    id: "help.keymap",
    label: "Keyboard help",
    defaultKeys: ["?", "Shift+?"],
    kind: "navigate",
    requiresConfirmation: false,
  },
];

const BY_ID = new Map(REGISTERED_ACTIONS.map((action) => [action.id, action]));

export function actionById(id: string): RegisteredAction | undefined {
  return BY_ID.get(id);
}

export function isBindableAction(id: string): boolean {
  const action = BY_ID.get(id);
  return action !== undefined && action.kind !== "authority";
}
