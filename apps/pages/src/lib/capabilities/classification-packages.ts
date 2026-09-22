/**
 * Exclusive external and workspace packages. A package listed as optional
 * may only be reached through that capability's module; the forbidden-
 * reachability gate (S07) fails a build where the entry chunk imports it.
 */

import { core, optional, shared } from "./classification-rule.js";

const NM = "node_modules/";

export const PACKAGE_RULES = [
  // --- exclusive to one optional capability ----------------------------------
  optional(`${NM}@azure/msal-browser`, "identity.ambient-sso", "MSAL: only lib/ambient-auth/entra.ts and auth/redirect-bridge.ts"),
  optional(`${NM}@vercel/connect`, "connectors.external", "only lib/vercel-connect.ts"),
  optional(`${NM}simple-icons`, "connectors.external", "connector marks (sections/connections/connector-marks.ts)"),
  optional(`${NM}@ag-ui/client`, "support.remote-ai", "AG-UI transport (tutorial/agents/ag-ui)"),
  optional(`${NM}ai`, "support.local-ai", "AI SDK generateObject over the Prompt API (command-bar/interpret.ts)"),
  optional(`${NM}@ai-sdk/provider`, "support.local-ai", "LanguageModelV2 types (command-bar/prompt-model.ts)"),
  optional(`${NM}driver.js`, "support.guided-help", "guide renderer (tutorial/rendering/driver-renderer.ts)"),
  optional(`${NM}@opensesame/support-agent`, "support.guided-help", "support port and system-instruction builder"),
  optional(`${NM}@opensesame/guide-lang`, "support.guided-help", "GuideLang parser"),
  optional(`${NM}@opensesame/guide-runtime`, "support.guided-help", "GuideLang runtime"),
  optional(`${NM}kdbxweb`, "vault.interop-formats", "KDBX reader (vault/import/formats/kdbx.ts)"),
  optional(`${NM}hash-wasm`, "vault.interop-formats", "Argon2 for KDBX key derivation"),
  optional(`${NM}@opensesame/wallet-budget`, "wallet.spending", "conserved ledger"),
  optional(`${NM}@opensesame/wallet-consent`, "wallet.spending", "spending consent proofs"),
  optional(`${NM}@opensesame/siop-v2`, "identity.siop", "SIOPv2 request/response"),
  optional(`${NM}@opensesame/webmcp`, "agents.webmcp", "document.modelContext registrar"),
  optional(`${NM}@opensesame/contracts`, "connectors.external", "Host connection schemas; also identity-management (enterprise)"),
  optional(`${NM}@opensesame/api-client`, "access.authority", "DPoP key pair for browser pairing; urls.ts uses its origin fence (shared)"),
  optional(`${NM}@opensesame/audit`, "activity.log", "redaction for the sealed activity log"),
  optional(`${NM}@opensesame/auth-upstream`, "identity.local-iam", "browser helpers for local passkeys"),
  optional(`${NM}age-encryption`, "backup.cloud-secrets", "age recipients, SOPS engine, age-webauthn adapter"),
  optional(`${NM}yaml`, "backup.cloud-secrets", "SOPS YAML codec; also configuration/yaml-* (settings.core) — MIXED"),
  optional(`${NM}@opensesame/static-auth`, "identity.local-iam", "local protocol types; the built SDK files are identity.site-broker"),

  // --- shared infrastructure -------------------------------------------------
  shared(`${NM}@opensesame/sdk-browser`, "PKCE, JWT envelope, base64 helpers used by sign-in, IAM and drops"),
  shared(`${NM}@opensesame/qr`, "QR SVG encoder used by drops, pairing and second steps"),
  shared(`${NM}@opensesame/os-domain`, "domain models and boundary guards"),
  shared(`${NM}@opensesame/vault-item-types`, "item type definitions for both planes"),
  shared(`${NM}@opensesame/capability-registry`, "operation ids and parity views"),
  shared(`${NM}@opensesame/capability-composition`, "the composition contracts and resolver"),
  shared(`${NM}@noble/ciphers`, "AES for vault sealing"),
  shared(`${NM}zod`, "schema parsing"),

  // --- core --------------------------------------------------------------------
  core(`${NM}react`, "shell.navigation", "UI runtime"),
  core(`${NM}react-dom`, "shell.navigation", "UI runtime"),
  core(`${NM}react-router`, "shell.navigation", "routing"),
  core(`${NM}tinykeys`, "shell.navigation", "keymap chords"),
  core(`${NM}@openfeature/web-sdk`, "settings.core", "local read-only feature provider (S17)"),
  core(`${NM}@openfeature/core`, "settings.core", "OpenFeature core types (S17)"),
  core(`${NM}virtual:pwa-register`, "install.pwa", "vite-plugin-pwa registration"),
];
