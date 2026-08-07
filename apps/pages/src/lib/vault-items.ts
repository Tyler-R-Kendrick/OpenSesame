import { kvGet, kvSet } from "./kv.js";

/** Vault catalog — metadata only. Never stores secrets or proof private keys. */

export type VaultItemType =
  | "connection"
  | "task"
  | "claim"
  | "device"
  | "note";

export type VaultItem = {
  id: string;
  type: VaultItemType;
  name: string;
  subtitle: string;
  updatedAt: string;
  /** Visible to agent peer view */
  agentUsable: boolean;
  /** Labeled demo / synthetic */
  synthetic?: boolean;
};

const KEY = "vaultItems.v1";

const seed: VaultItem[] = [
  {
    id: "conn-host-local",
    type: "connection",
    name: "Local Host API",
    subtitle: "ConnectionRef · invoke via Host, never raw credentials",
    updatedAt: new Date().toISOString(),
    agentUsable: true,
  },
  {
    id: "task-demo-ceiling",
    type: "task",
    name: "Demo task grant",
    subtitle: "Synthetic ceiling — inspect only; labeled demo",
    updatedAt: new Date().toISOString(),
    agentUsable: true,
    synthetic: true,
  },
  {
    id: "claim-pending",
    type: "claim",
    name: "Ownership claim",
    subtitle: "Present / complete via Identity — not CLI authorize",
    updatedAt: new Date().toISOString(),
    agentUsable: false,
  },
  {
    id: "device-cli",
    type: "device",
    name: "CLI device session",
    subtitle: "Short-lived authorize — does not transfer ownership",
    updatedAt: new Date().toISOString(),
    agentUsable: false,
  },
  {
    id: "note-sealed",
    type: "note",
    name: "Sealed sync envelope",
    subtitle: "OPFS ciphertext blob index — no plaintext vault JSON",
    updatedAt: new Date().toISOString(),
    agentUsable: true,
  },
];

export function typeLabel(type: VaultItemType): string {
  switch (type) {
    case "connection":
      return "Connection";
    case "task":
      return "Task grant";
    case "claim":
      return "Claim";
    case "device":
      return "Device";
    case "note":
      return "Secure note";
  }
}

export function loadVaultItems(): VaultItem[] {
  try {
    const raw = kvGet(KEY);
    if (!raw) {
      kvSet(KEY, JSON.stringify(seed));
      return [...seed];
    }
    const parsed = JSON.parse(raw) as VaultItem[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...seed];
  } catch {
    return [...seed];
  }
}

export function getVaultItem(id: string): VaultItem | undefined {
  return loadVaultItems().find((i) => i.id === id);
}

export function saveVaultItems(items: VaultItem[]): void {
  kvSet(KEY, JSON.stringify(items));
}
