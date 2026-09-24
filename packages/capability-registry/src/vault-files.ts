import type { Capability } from "./index.js";

/**
 * Opening a vault file needs its master password, typed by a person at a
 * terminal; what it opens is the vault a password manager holds. No agent
 * surface may take the password as an argument or read the listing back.
 */
const PERSON_AT_TERMINAL: Capability["excluded"] = {
  mcp_host: {
    reason:
      "a vault file opens only with its master password typed at a terminal; agents hold ConnectionRefs, never vault passwords",
    adr: "0005-authority-handle-connectionref.md",
  },
  mcp_client: {
    reason:
      "a vault file opens only with its master password typed at a terminal; agents hold ConnectionRefs, never vault passwords",
    adr: "0005-authority-handle-connectionref.md",
  },
  webmcp: {
    reason:
      "the shared core's offline read path is exposed to the CLI for a person verifying their own backup, not to a page's agent tools",
    adr: "0133-shared-app-core.md",
  },
};

/**
 * The native binary opens the same files with the Rust reader checked against
 * the same vectors (`crates/human-vault` `pages_vault`, ADR 0139). Its rows
 * are the TypeScript rows on another binary: the PWA, extension and Android
 * gaps are recorded once, against `vault.file.verify` and `vault.file.list`.
 */
const SAME_CAPABILITY_ON_ANOTHER_BINARY = {
  reason:
    "the native binary's copy of a vault.file capability; this target's gap is recorded once, on the opensesame-id row",
  adr: "0139-one-definition-every-target.md",
};

const NATIVE: Capability["excluded"] = {
  ...PERSON_AT_TERMINAL,
  pwa: SAME_CAPABILITY_ON_ANOTHER_BINARY,
  extension: SAME_CAPABILITY_ON_ANOTHER_BINARY,
  android: SAME_CAPABILITY_ON_ANOTHER_BINARY,
};

export const vaultFileCapabilities: readonly Capability[] = [
  {
    id: "vault.file.verify",
    title: "Verify a vault export or offline backup opens",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id vault verify",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: PERSON_AT_TERMINAL,
  },
  {
    id: "vault.file.list",
    title: "List a vault file's items by path and kind, never values",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id vault ls",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: PERSON_AT_TERMINAL,
  },
  {
    id: "vault.file.native.verify",
    title:
      "Verify a Pages vault export or offline backup with the native binary",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame vault verify",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: NATIVE,
  },
  {
    id: "vault.file.native.list",
    title:
      "List a Pages vault file's items by path and kind with the native binary",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame vault ls",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: NATIVE,
  },
];
