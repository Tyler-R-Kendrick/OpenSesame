import { ADR_MODEL_KEYS } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Model keys (ADR 0190): a person hands an app or an agent a key that stands
 * for a saved model provider's credential without being it. The key is made
 * in the page by the person, narrowed by RFC 8693 token exchange, and spent
 * through the same connection that holds the credential. It lives in the
 * memory of the page that issued it, so it has no CLI and no host.
 */

/** Authority is handed over by a person, and an agent cannot hand itself some. */
const HUMAN_GRANT: CapabilityExclusion = {
  reason:
    "creating, listing and revoking the keys handed to apps and agents is the person's own act; an agent that could create a key would approve its own grant",
  adr: ADR_MODEL_KEYS,
};

/** A key is presented by the app that holds it, over a channel that knows which app that is. */
const NO_CALLER_IDENTITY: CapabilityExclusion = {
  reason:
    "a key is only good in the hands of the client it was issued to, and an MCP or WebMCP tool call does not say which client is calling; their results are also fenced against anything shaped like a key",
  adr: ADR_MODEL_KEYS,
};

/** Keys are in memory. */
const IN_THE_PAGE: CapabilityExclusion = {
  reason:
    "keys are held in the memory of the page that issued them and end with it; a terminal has no page to ask",
  adr: ADR_MODEL_KEYS,
};

const HUMAN = {
  cli: IN_THE_PAGE,
  mcp_host: HUMAN_GRANT,
  mcp_client: HUMAN_GRANT,
  webmcp: HUMAN_GRANT,
} as const;

const PRESENTED = {
  cli: IN_THE_PAGE,
  mcp_host: NO_CALLER_IDENTITY,
  mcp_client: NO_CALLER_IDENTITY,
  webmcp: NO_CALLER_IDENTITY,
} as const;

const NONE = {
  cli: null,
  mcp_host: null,
  mcp_client: null,
  webmcp: null,
} as const;

export const modelKeyCapabilities: readonly Capability[] = [
  {
    id: "models.keys.mint",
    title: "Create a model key for an app or agent from a saved provider",
    plane: "client_local",
    kind: "ceremony",
    surfaces: { ...NONE, pwa: "lib/model-keys/mint.ts:mintModelKey" },
    excluded: HUMAN,
  },
  {
    id: "models.keys.read",
    title: "List the model keys handed out and what each may still do",
    plane: "client_local",
    kind: "read",
    surfaces: { ...NONE, pwa: "lib/model-keys/broker.ts:ModelKeyBroker" },
    excluded: HUMAN,
  },
  {
    id: "models.keys.revoke",
    title: "Revoke a model key and every key made from it",
    plane: "client_local",
    kind: "admin",
    surfaces: { ...NONE, pwa: "lib/model-keys/broker.ts:ModelKeyBroker" },
    excluded: HUMAN,
  },
  {
    id: "models.keys.exchange",
    title: "Exchange a model key for a narrower one (RFC 8693)",
    plane: "client_local",
    kind: "act",
    surfaces: { ...NONE, pwa: "lib/model-keys/exchange.ts:exchangeKey" },
    excluded: PRESENTED,
  },
  {
    id: "models.keys.invoke",
    title: "Call a model provider with a model key, never its credential",
    plane: "client_local",
    kind: "act",
    surfaces: { ...NONE, pwa: "lib/model-keys/gateway.ts:invokeWithModelKey" },
    excluded: PRESENTED,
  },
];
