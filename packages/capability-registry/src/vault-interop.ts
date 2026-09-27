import {
  ADR_AGENT_SURFACE_PARITY,
  ADR_PM_BRIDGING,
  NEVER_AGENT_SECRET,
} from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * IMPORT is an explicit, visible human action (ADR 0052 §6): a person picks
 * a file and confirms a preview. An agent that could import would write a
 * file's secrets into the vault under nobody's hand, and would have to carry
 * the plaintext export — or a KDBX master password — to do it.
 */
const EXPLICIT_HUMAN_IMPORT: CapabilityExclusion = {
  reason:
    "an import is an explicit, visible human action over a file the person picked; an agent would carry a plaintext export or its master password and write secrets under nobody's hand",
  adr: ADR_PM_BRIDGING,
};

/**
 * Sample data is the person's own look at the product: synthetic, badged,
 * loaded and removed by whoever is looking at it. An agent that could load
 * it would put credential-shaped items in a vault under nobody's hand, and
 * one that could remove it would be a delete an agent reached by a side road.
 */
const SAMPLE_DATA_IS_THE_PERSONS: CapabilityExclusion = {
  reason:
    "sample data is loaded and removed by the person looking at it; an agent would write credential-shaped items, or delete items, under nobody's hand",
  adr: ADR_AGENT_SURFACE_PARITY,
};

/**
 * Moving items into and out of the vault as files: the vault path strip's
 * Import key (`vault.interop-formats`) and Export key (`backup.local-
 * encrypted`), and the sealed-store bridge's path manifest (ADR 0037 §6) —
 * saved from Settings › Vaults and read back through the Import key. Each is
 * the person's own act on this device; none has an agent surface. The
 * manifest is plain text, so its export is excluded as a raw secret is.
 */
export const vaultInteropCapabilities: readonly Capability[] = [
  {
    id: "vault.import",
    title:
      "Import another manager's export, or restore an encrypted backup, into the vault",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/import/merge.ts:planMerge",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: EXPLICIT_HUMAN_IMPORT,
      mcp_client: EXPLICIT_HUMAN_IMPORT,
      webmcp: EXPLICIT_HUMAN_IMPORT,
    },
  },
  {
    id: "vault.export",
    title: "Export the vault as an encrypted backup file",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/offline-backup-file.ts:offlineBackupFile",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "vault.store_manifest.export",
    title:
      "Save the vault as a store path manifest for opensesame pass seal (plain text)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/store-sync.ts:vaultItemToEntry",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "vault.store_manifest.import",
    title: "Merge a store path manifest into the vault by store path",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/store-sync.ts:planManifestMerge",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: EXPLICIT_HUMAN_IMPORT,
      mcp_client: EXPLICIT_HUMAN_IMPORT,
      webmcp: EXPLICIT_HUMAN_IMPORT,
    },
  },
  {
    id: "vault.sample_data",
    title: "Load badged sample items into the vault, or remove them all",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/vault/sample.ts:buildSample",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SAMPLE_DATA_IS_THE_PERSONS,
      mcp_client: SAMPLE_DATA_IS_THE_PERSONS,
      webmcp: SAMPLE_DATA_IS_THE_PERSONS,
    },
  },
];
