import type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";

export const PASSWORD_WORKFLOW_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.credentials",
    title: "Use credential references on an item",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-items"],
    guide: [
      "guide/1",
      'goal "vault.item.credentials"',
      'navigate "/vault/item"',
      'focus "item.credentials.references" "Copy references or download a reference-only environment template beside this item. Reading plaintext requires your explicit confirmation. A login also offers private comparison and a verified password update; this guide submits nothing." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.password-workflows",
    title: "Find references and manage credentials privately",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.password-workflows"',
      'navigate "/vault/password-workflows"',
      'focus "vault.workflow.find" "Find accepts several title queries. Results contain metadata and os:// references for this vault, never values. Native 1Password discovery uses the CLI." side=bottom',
      'focus "vault.workflow.inventory" "Inventory lists references, item kinds and timestamps. It does not read credential values." side=bottom',
      'focus "vault.workflow.audit" "Audit checks duplicate titles, aging logins and URLs worth reviewing. Results describe organization, not password strength." side=bottom',
      'focus "vault.workflow.template" "Templates map environment names to references. Creating one does not resolve values. Plaintext download is a separate human choice, and local resolution accepts this vault only." side=bottom',
      'focus "vault.workflow.read" "Downloading a value writes a private plaintext file on this device. Choose a reference and explicitly confirm that choice yourself; the tutorial never reads a value." side=bottom',
      'focus "vault.workflow.private" "Create, compare and update use private input. Comparison reports only whether it matches; updates are read back and verified. Nothing is submitted by this walkthrough." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.password-workflows.open",
    title: "Open password workflows from the vault",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vault.password-workflows.open"',
      'navigate "/vault"',
      'focus "vault.workflow.open" "Password workflows opens from the list toolbar, or the Add menu on a phone. It works on this unlocked vault; native provider authentication and process execution remain in the CLI." side=bottom',
      'success "Choose the credential workflow you need. Private inputs are submitted only by you."',
      "end",
    ].join("\n"),
  },
];

export const PASSWORD_WORKFLOW_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.password-workflows",
    title:
      "How do I find references, audit inventory, or create environment templates?",
    answer:
      "Open a vault item for credential references, templates, private reads, and login comparison or updates. The Health report includes organization findings linked to each item. For cross-item tasks, open Password workflows from the vault toolbar or the phone Add menu. Discovery, inventory and audit return metadata and references. Templates stay reference-only until you deliberately request a plaintext download. Private creation, comparison and updates run on this unlocked vault; native provider sessions and child processes use the CLI.",
    routes: ["/vault"],
    goal: "vault.password-workflows",
    keywords: [
      "2password",
      "inventory",
      "audit",
      "references",
      "environment",
      "template",
      "credentials",
      "compare",
    ],
  },
];
