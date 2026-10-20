import type { GuideGoalDescriptor } from "./goal-types.js";

/**
 * Environments in the vault (ADR 0194): the key in the vault's own strip and
 * the sheet it opens. Offered only once the capability is approved, because
 * the key is not drawn before.
 */
export const ENVIRONMENTS_GOAL = {
  id: "vault.environments",
  title: "Give a key a value in each environment",
  routes: [],
  capabilities: ["vault.environments"],
  requires: ["shell.wide"],
  guide: [
    "guide/1",
    'goal "vault.environments"',
    'say "An environment is a place a key is used: development, staging, production. Every secret starts as a key, and each environment holds its own sealed value for it."',
    'wait state "vault.unlocked" is=true timeout=60000',
    'navigate "/vault"',
    'wait route "/vault" timeout=15000',
    'focus "vault.environments" "The Environments key opens a sheet: pick or add an environment, mark a key required where it must have a value, and type the value. One .env.<name>.schema per environment is shown below and never holds a value." side=bottom',
    'wait target "vault.environments" event=activate timeout=60000',
    'success "A required key with no value in an environment is flagged in the bell until it has one."',
    "end",
  ].join("\n"),
} satisfies GuideGoalDescriptor;
