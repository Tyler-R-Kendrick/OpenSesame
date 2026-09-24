import type { CapabilityExclusion } from "./index.js";

/**
 * ADR citations and the standing capability exclusions shared by the
 * registry entries. Split out of `index` for the 400-line module budget
 * (ADR 0093); every constant is unchanged.
 */

export const ADR_AUTHORITY_HANDLE = "0005-authority-handle-connectionref.md";
export const ADR_MCP_BEARER = "0023-mcp-bearer-vs-dpop.md";
export const ADR_PM_BRIDGING = "0052-password-manager-ecosystem-bridging.md";
export const ADR_AGENT_SURFACE_PARITY = "0065-agent-surface-parity.md";
export const ADR_KEY_CUSTODY = "0075-host-certificate-key-custody.md";
export const ADR_FIRST_RUN_SETUP = "0077-first-run-setup-ceremony.md";
export const ADR_SECURITY_EVENTS = "0080-security-event-hooks.md";
export const ADR_AI_SUPPORT = "0088-ai-native-contextual-support.md";
export const ADR_LIVE_OBSERVATION = "0081-live-session-observation.md";
export const ADR_CEREMONIES = "0082-agent-run-registration-ceremonies.md";
export const ADR_MODEL_PLANE = "0083-browser-plane-inference-fallback.md";
export const ADR_NOTIFICATION_CEREMONIES =
  "0084-external-authorization-notifications.md";
export const ADR_PWA_INSTALL = "0085-pwa-install-offer.md";
export const ADR_INTERACTION_LAYER = "0086-wallet-native-interaction-layer.md";
export const ADR_DEVICE_VAULTS = "0089-device-vault-switching.md";

export const NEVER_AGENT_SECRET: CapabilityExclusion = {
  reason:
    "raw secret material must never transit agent context; agents hold ConnectionRefs only",
  adr: ADR_AUTHORITY_HANDLE,
};

export const AUTH_CEREMONY: CapabilityExclusion = {
  reason:
    "authentication ceremonies run out-of-band; inbound agent tokens are never minted or forwarded by tools",
  adr: ADR_MCP_BEARER,
};

export const INTERACTION_APPROVAL: CapabilityExclusion = {
  reason:
    "approving an interaction is the human decision the whole layer exists to obtain; an agent surface that could answer one would make the ceremony decorative",
  adr: ADR_INTERACTION_LAYER,
};

export const INTERACTION_REQUESTER_CHANNEL: CapabilityExclusion = {
  reason:
    "the requester already learns the outcome on the channel it created the interaction on; a second agent-facing read would be a way to watch somebody else's inbox",
  adr: ADR_INTERACTION_LAYER,
};

export const HUMAN_CEREMONY: CapabilityExclusion = {
  reason:
    "consequential authority grant/approval; headless agents get read-only visibility, WebMCP opens the ceremony for a human decision",
  adr: ADR_AGENT_SURFACE_PARITY,
};

export const OPS_PLANE: CapabilityExclusion = {
  reason: "operator/device lifecycle surface, not an agent capability",
  adr: ADR_AGENT_SURFACE_PARITY,
};

/**
 * Where an authorization prompt appears is who gets to approve it. An agent
 * that could rebind a destination could route its principal's prompts to
 * itself, so this is withheld from every agent surface rather than merely
 * gated.
 */
export const APPROVAL_ROUTING: CapabilityExclusion = {
  reason:
    "binding a notification destination decides where authorization prompts appear; an agent that could rebind one could route its principal's prompts to itself",
  adr: ADR_NOTIFICATION_CEREMONIES,
};

export const PM_PLANE: CapabilityExclusion = {
  reason:
    "password-manager ecosystem surface is human/device/ops plane only, never agent-facing",
  adr: ADR_PM_BRIDGING,
};

export const BREACH_CHECK_TAKES_A_SECRET: CapabilityExclusion = {
  reason:
    "the only route that accepts a secret value; an agent surface must never be the thing that carries one, even to have it vetted",
  adr: ADR_SECURITY_EVENTS,
};

export const ADR_ITEM_TYPE_PLUGINS = "0087-vault-item-type-plugins.md";

export const ITEM_TYPE_HUMAN_CEREMONY: CapabilityExclusion = {
  reason:
    "an item type defines the shape a human is then asked to fill in; an agent that could install or enumerate one could shape that prompt",
  adr: ADR_ITEM_TYPE_PLUGINS,
};

export const CUSTODY_KEY_MATERIAL: CapabilityExclusion = {
  reason:
    "returns or places a certificate private key; agent-facing APIs carry references, never material",
  adr: ADR_KEY_CUSTODY,
};

export const DEFERRED: CapabilityExclusion = {
  reason:
    "not yet exposed to agents; revisit deliberately rather than by accretion",
  adr: ADR_AGENT_SURFACE_PARITY,
};

export const MODEL_PLANE_REDIRECT: CapabilityExclusion = {
  reason:
    "choosing the model plane names the endpoint redacted frames are sent to; an agent able to make that choice holds a redirect primitive, and the boundary holds only because nobody untrusted picks the destination",
  adr: ADR_MODEL_PLANE,
};

export const DEVICE_GESTURE: CapabilityExclusion = {
  reason:
    "installing is a browser-mediated act on the human's own device: the install dialog only opens inside a transient user activation, and there is no gesture an agent can supply or consent it can give on the device owner's behalf",
  adr: ADR_PWA_INSTALL,
};

export const COMMAND_BAR_HUMAN_ONLY: CapabilityExclusion = {
  reason:
    "the shell omnibox is a human mic / typed command surface that copies vault fields onto the device clipboard; an agent must not hold the mic, speak a copy verb, or receive a secret value through WebMCP",
  adr: "0122-shell-command-omnibox.md",
};

export const IN_PAGE_GUIDANCE_ONLY: CapabilityExclusion = {
  reason:
    "guidance opens UI in the person's own unlocked tab and points at controls there; a headless MCP server has neither a page to guide nor a person watching it, and the walkthrough itself is authored in-repo rather than accepted from a caller, so there is nothing for a headless surface to carry",
  adr: ADR_AI_SUPPORT,
};

export const FIRST_RUN_CEREMONY: CapabilityExclusion = {
  reason:
    "the anonymous first visitor is the deployment's operator; letting an agent answer who this app trusts for identity would let it choose the issuer that authenticates every later human",
  adr: ADR_FIRST_RUN_SETUP,
};
export const DEVICE_VAULT_CEREMONY: CapabilityExclusion = {
  reason:
    "picking, sealing or deleting a vault on a device is a human ceremony at the unlock boundary; an agent holds a ConnectionRef into one open vault and never chooses which tomb is open",
  adr: ADR_DEVICE_VAULTS,
};
