import type { HelpTopic } from "./goal-types.js";

export const ITEM_REFERENCE_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.item-references",
    title: "How do I make an environment template from an item?",
    answer:
      "Open the item. The keys on its toolbar download a reference-only environment template (one os:// reference per secret field, no values), or a plaintext .env after a second press. To read one value, use the field's own reveal and copy. To compare or replace a saved password, use the update key on its row. Password health lists items worth filing or renaming.",
    routes: ["/vault"],
    goal: null,
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
