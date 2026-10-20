import type { GuideGoalDescriptor } from "./goal-types.js";

/**
 * Environments in the vault (ADR 0194 as revised): an Environment item type,
 * not a key in the vault's strip. Offered only once the capability is approved,
 * because the item kind is not created before.
 */
export const ENVIRONMENTS_GOAL = {
  id: "vault.environments",
  title: "Create an Environment item",
  routes: [],
  capabilities: ["vault.environments"],
  guide: [
    "guide/1",
    'goal "vault.environments"',
    'say "An Environment item holds one varlock-compatible .env.schema and the vault item paths its keys bind to. It writes <vault-item-name>.<env-name>.env.schema and never holds a value."',
    'wait state "vault.unlocked" is=true timeout=60000',
    'navigate "/vault"',
    'wait route "/vault" timeout=15000',
    'say "Press New item, choose Environment, name it, type the environment name, paste the schema, and add one KEY=vault/item/path alias for each key whose item name differs from the variable."',
    'success "Save writes the item; its generated schema is ready to copy or download."',
    "end",
  ].join("\n"),
} satisfies GuideGoalDescriptor;
