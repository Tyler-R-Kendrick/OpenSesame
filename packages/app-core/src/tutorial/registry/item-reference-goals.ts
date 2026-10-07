import type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";

export const ITEM_REFERENCE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.credentials",
    title: "Build an environment template from an item",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-items"],
    guide: [
      "guide/1",
      'goal "vault.item.credentials"',
      'navigate "/vault/item"',
      'focus "item.credentials.references" "The fields above each have their own reveal and copy. This key writes all of them out by reference, as a template that holds no value; the key beside it writes a plaintext .env, and only after a second press. This guide reveals and submits nothing." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const ITEM_REFERENCE_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.item-references",
    title: "How do I make an environment template from an item?",
    answer:
      "Open the item. The keys on its toolbar download a reference-only environment template (one os:// reference per secret field, no values), or a plaintext .env after a second press. To read one value, use the field's own reveal and copy. To compare or replace a saved password, use the update key on its row. Password health lists items worth filing or renaming.",
    routes: ["/vault"],
    goal: "vault.item.credentials",
    keywords: [
      "2password",
      "references",
      "environment",
      "template",
      "env",
      "credentials",
      "compare",
    ],
  },
];
