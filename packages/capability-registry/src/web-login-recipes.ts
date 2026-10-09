import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * The recipes a Host-run web-login rotation replays, and the keys that sign
 * them (ADR 0076 §4, ADR 0159). Every one of these is administered from the
 * native CLI, by a person, and withheld from every agent surface: the recipes
 * govern the agent, so an agent that could write one — or pin the key that
 * signs one — would govern itself.
 */
const ADR_WEB_LOGIN = "0076-autonomous-web-login-rotation.md";
const ADR_AGENT_HOOKS = "0159-agent-hooks-interceptor.md";

/**
 * Not an agent tool. An agent reading the recipes learns exactly which
 * settings pages it may be sent to and by which selectors; one writing them,
 * or the signers that make them trusted, chooses the page that governs it.
 */
const RECIPES_GOVERN_THE_AGENT: CapabilityExclusion = {
  reason:
    "the recipes a hosted web-login run replays, and the keys that sign them, govern the agent (ADR 0076 §1: it orchestrates, deterministic tools hold the secrets); an agent that could read or write them would learn or choose the page that governs it, so they are for a person at the native CLI (ADR 0159)",
  adr: ADR_AGENT_HOOKS,
};

/**
 * Pages is complete without a backend and never names a Host; the extension
 * and Android run no hosted web-login run for a recipe to govern.
 */
const RECIPES_FROM_THE_CLI: CapabilityExclusion = {
  reason:
    "web-login recipes and their signers are administered on the Host from the native CLI (ADR 0076 §4); this surface names no Host and runs no hosted web-login run",
  adr: ADR_WEB_LOGIN,
};

const RECIPE_EXCLUSIONS = {
  pwa: RECIPES_FROM_THE_CLI,
  mcp_host: RECIPES_GOVERN_THE_AGENT,
  mcp_client: RECIPES_GOVERN_THE_AGENT,
  webmcp: RECIPES_GOVERN_THE_AGENT,
  extension: RECIPES_FROM_THE_CLI,
  android: RECIPES_FROM_THE_CLI,
} as const;

/**
 * Signing is a local act: the private key is a file the native CLI reads and
 * nothing else, never an argument, never printed, never sent, and the Host
 * holds only public keys. No other surface has a place to keep one.
 */
const SIGNING_IS_LOCAL: CapabilityExclusion = {
  reason:
    "signing a recipe is a local act of the native CLI: the private key is a file it reads and nothing else, never an argument, never printed and never sent; the Host holds only public keys (ADR 0076 §4)",
  adr: ADR_WEB_LOGIN,
};

const LOCAL_SIGNING_EXCLUSIONS = {
  pwa: SIGNING_IS_LOCAL,
  mcp_host: RECIPES_GOVERN_THE_AGENT,
  mcp_client: RECIPES_GOVERN_THE_AGENT,
  webmcp: RECIPES_GOVERN_THE_AGENT,
  extension: SIGNING_IS_LOCAL,
  android: SIGNING_IS_LOCAL,
} as const;

const CLI_ONLY = {
  pwa: null,
  mcp_host: null,
  mcp_client: null,
  webmcp: null,
  extension: null,
  android: null,
} as const;

export const webLoginRecipeCapabilities: readonly Capability[] = [
  {
    id: "web_login.recipes.list",
    title:
      "List the organization's web-login recipes: trust, signer, canary, and whether a run may replay each attended and unattended",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame access connectors rotate recipe ls",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.recipes.read",
    title:
      "Read one web-login recipe: its document and what the Host verified about it",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame access connectors rotate recipe get",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.recipes.write",
    title:
      "Store a web-login recipe (compare-and-set); the Host verifies its signature against the pinned signers and derives its trust, and an unsigned recipe is a candidate no run replays",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame access connectors rotate recipe put",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.recipes.remove",
    title: "Remove a web-login recipe (compare-and-set)",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame access connectors rotate recipe rm",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.recipes.sign",
    title:
      "Sign a web-login recipe with a private key file, locally (Ed25519 over its canonical JSON); names no Host",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame access connectors rotate recipe sign",
      ...CLI_ONLY,
    },
    excluded: LOCAL_SIGNING_EXCLUSIONS,
  },
  {
    id: "web_login.recipes.canary",
    title:
      "Start one attended run of a verified recipe from the caller's own browser; a completed run is the recipe's canary, which an unattended run requires",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame access connectors rotate recipe canary",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.signers.list",
    title:
      "List the Ed25519 public keys the organization trusts to sign web-login recipes, revoked ones included",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame access connectors rotate signer ls",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.signers.write",
    title:
      "Pin a public key as a web-login recipe signer (needs the operator token or a fresh passkey step-up)",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame access connectors rotate signer add",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.signers.revoke",
    title:
      "Revoke a web-login recipe signer, for good; the recipes it signed stop being replayable at their next run",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame access connectors rotate signer rm",
      ...CLI_ONLY,
    },
    excluded: RECIPE_EXCLUSIONS,
  },
  {
    id: "web_login.signers.keygen",
    title:
      "Make a recipe-signing key file (mode 0600, never overwritten), printing only its public half and id; names no Host",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame access connectors rotate signer keygen",
      ...CLI_ONLY,
    },
    excluded: LOCAL_SIGNING_EXCLUSIONS,
  },
];
