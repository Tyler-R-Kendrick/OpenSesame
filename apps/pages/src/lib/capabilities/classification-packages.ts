/**
 * Exclusive external and workspace packages. A package listed as optional
 * may only be reached through that capability's module; the forbidden-
 * reachability gate (S07) fails a build where the entry chunk imports it.
 */

import { core, optional, shared } from "./classification-rule.js";

const NM = "node_modules/";

export const PACKAGE_RULES = [
  // --- exclusive to one optional capability ----------------------------------
  optional(
    `${NM}@azure/msal-browser`,
    "identity.ambient-sso",
    "MSAL: only lib/ambient-auth/entra.ts and auth/redirect-bridge.ts",
  ),
  optional(
    `${NM}@azure/msal-common`,
    "identity.ambient-sso",
    "reached only through @azure/msal-browser",
  ),
  optional(
    `${NM}simple-icons`,
    "connectors.external",
    "connector marks (sections/connections/connector-marks.ts)",
  ),
  optional(
    `${NM}@ag-ui/client`,
    "support.remote-ai",
    "AG-UI transport (tutorial/agents/ag-ui)",
  ),
  optional(
    `${NM}ai`,
    "support.local-ai",
    "AI SDK generateObject over the Prompt API (command-bar/interpret.ts)",
  ),
  optional(
    `${NM}@ai-sdk/provider`,
    "support.local-ai",
    "LanguageModelV2 types (command-bar/prompt-model.ts)",
  ),
  optional(
    `${NM}@ai-sdk/gateway`,
    "support.local-ai",
    "the gateway provider only `ai` imports; unclaimed, it left vendor-ai-sdk in a chunk cycle",
  ),
  optional(
    `${NM}mqtt`,
    "sharing.live",
    "MQTT carrier, loaded when a session names one (modules/sharing.live/carriers/mqtt.ts)",
  ),
  optional(
    `${NM}@nats-io/nats-core`,
    "sharing.live",
    "NATS carrier, loaded when a session names one (modules/sharing.live/carriers/nats.ts)",
  ),
  optional(
    `${NM}@nats-io/nkeys`,
    "sharing.live",
    "nats-core's signer, and a session's minted credential (lib/live/nats-credentials.ts)",
  ),
  optional(
    `${NM}@nats-io/services`,
    "sharing.live",
    "the owner's session as a NATS service (modules/sharing.live/carriers/nats.ts)",
  ),
  optional(
    `${NM}@nats-io/nuid`,
    "sharing.live",
    "reached only through @nats-io/nats-core",
  ),
  optional(
    `${NM}nostr-tools`,
    "sharing.live",
    "Nostr carrier, loaded when a session names one (modules/sharing.live/carriers/nostr.ts)",
  ),
  optional(
    `${NM}@opensesame/support-agent`,
    "support.guided-help",
    "support port and system-instruction builder",
  ),
  optional(
    `${NM}@opensesame/guide-lang`,
    "support.guided-help",
    "GuideLang parser",
  ),
  optional(
    `${NM}@opensesame/guide-runtime`,
    "support.guided-help",
    "GuideLang runtime",
  ),
  optional(
    `${NM}kdbxweb`,
    "vault.interop-formats",
    "KDBX reader (vault/import/formats/kdbx.ts)",
  ),
  optional(
    `${NM}hash-wasm`,
    "vault.interop-formats",
    "Argon2 for KDBX key derivation",
  ),
  optional(
    `${NM}@xmldom/xmldom`,
    "vault.interop-formats",
    "the XML parser kdbxweb requires for a KDBX document",
  ),
  optional(
    "__vite-browser-external",
    "vault.interop-formats",
    "Vite's empty stand-in for the Node `crypto` kdbxweb's UMD header requires",
  ),
  optional(
    `${NM}@opensesame/wallet-budget`,
    "wallet.spending",
    "conserved ledger",
  ),
  optional(
    `${NM}@opensesame/wallet-consent`,
    "wallet.spending",
    "spending consent proofs",
  ),
  optional(
    `${NM}@opensesame/siop-v2`,
    "identity.siop",
    "SIOPv2 request/response",
  ),
  optional(
    `${NM}@opensesame/webmcp`,
    "agents.webmcp",
    "document.modelContext registrar",
  ),
  shared(
    `${NM}@opensesame/contracts`,
    "Host schemas the vault, duress and connectors share",
  ),
  // The duress corner of that package is core, and the longer pattern wins.
  // A duress code is an unlock method, so its policy documents, compiler and
  // incident records belong to `vault.local-unlock` (ADR 0131) — the same
  // rule `src/lib/duress/` already gets. Without this the core duress
  // settings could not name a contract without dragging the connector
  // schemas in behind it.
  core(
    `${NM}@opensesame/contracts/src/duress/`,
    "vault.local-unlock",
    "duress policy documents, compiler and incident records",
  ),
  shared(
    `${NM}@opensesame/api-client`,
    "origin fence urls.ts uses, and the DPoP key pairing uses",
  ),
  optional(
    `${NM}@opensesame/audit`,
    "activity.log",
    "redaction for the sealed activity log",
  ),
  optional(
    `${NM}age-encryption`,
    "backup.cloud-secrets",
    "age recipients, SOPS engine, age-webauthn adapter",
  ),
  optional(
    `${NM}@opensesame/static-auth`,
    "identity.site-broker",
    "local protocol types and the built SDK files the sign-in broker ships",
  ),

  // --- shared infrastructure -------------------------------------------------
  shared(
    `${NM}@opensesame/sdk-browser`,
    "PKCE, JWT envelope, base64 helpers used by sign-in, IAM and drops",
  ),
  shared(
    `${NM}@opensesame/qr`,
    "QR SVG encoder used by drops, pairing and second steps",
  ),
  shared(`${NM}@opensesame/os-domain`, "domain models and boundary guards"),
  shared(
    `${NM}@opensesame/ceremony-kit`,
    "ceremony link parsers, clients and models: the core boot reads links, identity.ceremonies runs them (ADR 0140)",
  ),
  shared(
    `${NM}@opensesame/vault-item-types`,
    "item type definitions for both planes",
  ),
  shared(
    `${NM}@opensesame/capability-registry`,
    "operation ids and parity views",
  ),
  shared(
    `${NM}@opensesame/capability-composition`,
    "the composition contracts and resolver",
  ),
  shared(`${NM}@noble/ciphers`, "AES for vault sealing"),
  shared(`${NM}zod`, "schema parsing"),
  shared(
    `${NM}yaml`,
    "settings YAML profile (core) and the SOPS codec share it; not exclusive",
  ),

  // --- core --------------------------------------------------------------------
  core(`${NM}react`, "shell.navigation", "UI runtime"),
  core(`${NM}react-dom`, "shell.navigation", "UI runtime"),
  core(`${NM}react-router`, "shell.navigation", "routing"),
  core(`${NM}tinykeys`, "shell.navigation", "keymap chords"),
  core(
    `${NM}@openfeature/web-sdk`,
    "settings.core",
    "local read-only feature provider (S17)",
  ),
  core(
    `${NM}@openfeature/core`,
    "settings.core",
    "OpenFeature core types (S17)",
  ),
  core(
    `${NM}virtual:pwa-register`,
    "install.pwa",
    "vite-plugin-pwa registration",
  ),
];
