/**
 * Targets and the walkthrough that `sharing.drops` contributes (ADR 0062,
 * ADR 0163 §6): the Share once key on an open item, live only while secret
 * drops are in the plan. Sharing is a locked key (ADR 0156), so the tour
 * points at the key and says what it opens, and never presses or binds it.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const DROPS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "item.share",
    description:
      "Share once on an open item: opens the ceremony that seals the item's value into a link and a code that open one time, for a time you choose. The item is not changed. Drawn when the item has a value to share.",
    role: "ceremony",
    routes: ["/vault/item"],
    capabilityId: "vault.item.share",
  },
];

export const DROPS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.share",
    title: "Share an item once",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-items"],
    guide: [
      "guide/1",
      'goal "vault.item.share"',
      'say "Share once seals one value into a link and a code that open it a single time. The item itself is not touched."',
      'navigate "/vault/item"',
      'wait route "/vault/item" timeout=15000',
      'focus "item.share" "Share once opens the ceremony: choose how long the link lasts, then seal. The s key in the list opens it for the row under the cursor." side=top',
      'success "Share is a locked key: it cannot be remapped onto, and no macro can run it."',
      "end",
    ].join("\n"),
  },
];
