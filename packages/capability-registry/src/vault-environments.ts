import { ADR_ENVIRONMENTS } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * An environment's values are secrets, set by a person in the vault's own
 * sheet. An agent that could write one would put a credential in the vault
 * under nobody's hand, and one that could read one would carry it in its
 * context; an agent that needs a value gets a ConnectionRef and an Intent
 * (ADR 0005), never a `.env` (ADR 0192 §6).
 */
const HUMAN_ENVIRONMENT_VALUES: CapabilityExclusion = {
  reason:
    "an environment's values are secrets a person sets in the vault's own sheet; an agent would write a credential under nobody's hand, or carry one in its context, where it holds only a ConnectionRef and an Intent",
  adr: ADR_ENVIRONMENTS,
};

/**
 * Named environments on a vault (`vault.environments`, ADR 0192): the vault
 * path strip's Environments key and the sheet it opens, where a vault's keys
 * get a value and a required rule per environment and the `.env.schema` they
 * generate is shown. The person's own act on this device, with no agent
 * surface and, today, no CLI one.
 */
export const vaultEnvironmentCapabilities: readonly Capability[] = [
  {
    id: "vault.environments.manage",
    title:
      "Name environments and give a vault's keys a value and a required rule in each",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/vault/environments-write.ts:writeEnvironments",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HUMAN_ENVIRONMENT_VALUES,
      mcp_client: HUMAN_ENVIRONMENT_VALUES,
      webmcp: HUMAN_ENVIRONMENT_VALUES,
    },
  },
];
