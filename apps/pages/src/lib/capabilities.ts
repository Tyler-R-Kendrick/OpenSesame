import { isString } from "@opensesame/os-domain";
/**
 * Platform capability → connector bindings.
 *
 * OpenSesame's brokered capabilities are organized as families (ADR 0065):
 * encryption key vault (local storage), git history/persistence (backup and
 * file storage), cloud secret storage, password managers, identity, and
 * certificates. Settings binds each capability to a Host catalog connector.
 * Defaults: WebCrypto on this device for encryption; GitHub for encrypted
 * secret history; the first listed connector everywhere else.
 */

export type CapabilityId =
  | "encryption"
  | "history"
  | "cloud_secrets"
  | "password_managers"
  | "identity"
  | "certificates";

export type CapabilityConnectorBinding = {
  providerId: string;
  /** Host connection id when the connector needs (or has completed) auth. */
  connectionId?: string;
  /** For history: git remote URL (e.g. https://github.com/org/store.git). */
  remote?: string;
};

export type CapabilityConnectorMap = {
  [K in CapabilityId]: CapabilityConnectorBinding;
};

export type CapabilityDef = {
  id: CapabilityId;
  title: string;
  summary: string;
  /** Catalog provider ids allowed for this capability. First is the default. */
  connectorIds: readonly string[];
  /** When true, the selected connector must be Host-authorized (OAuth/key). */
  requiresAuth: (providerId: string) => boolean;
  /** Scopes to request when authorizing an OAuth connector for this capability. */
  authScopes?: (providerId: string) => string[] | undefined;
};

export const CAPABILITIES: readonly CapabilityDef[] = [
  {
    id: "encryption",
    title: "Encryption key vault",
    summary:
      "Where vault and sealed-store keys are wrapped. WebCrypto on this device is the built-in key vault; cloud KMS connectors are optional.",
    connectorIds: [
      "webcrypto",
      "sealed-local",
      "age",
      "yubikey",
      "fido2",
      "aws-kms",
      "azure-key-vault-keys",
      "gcp-kms",
    ],
    requiresAuth: (providerId) =>
      providerId !== "webcrypto" && providerId !== "sealed-local",
  },
  {
    id: "history",
    title: "History & persistence",
    summary:
      "Optional git persistence for encrypted secrets. The vault already lives on this device; connect GitHub to push and pull ciphertext without revealing plaintext.",
    connectorIds: ["github", "password-store", "gitlab"],
    requiresAuth: (providerId) =>
      providerId === "github" || providerId === "gitlab",
    authScopes: (providerId) => {
      if (providerId === "github") {
        // Classic OAuth App path. GitHub Apps omit scope= on Authorize so the
        // App's Administration/Contents/Workflows permissions apply instead.
        return ["read:user", "repo", "workflow"];
      }
      if (providerId === "gitlab") return ["read_user", "api"];
      return undefined;
    },
  },
  {
    id: "cloud_secrets",
    title: "Cloud secret storage",
    summary:
      "Where brokered credentials live upstream. The Host invokes these providers with host-injected credentials; agents only ever hold ConnectionRefs.",
    connectorIds: [
      "doppler",
      "vault",
      "openbao",
      "aws-secrets-manager",
      "gcp-secret-manager",
      "azure-key-vault-secrets",
      "bitwarden-secrets-manager",
    ],
    requiresAuth: () => true,
  },
  {
    id: "password_managers",
    title: "Password managers",
    summary:
      "Human-plane bridges to an existing password manager. Reveal stays human-gated on this device (ADR 0052); agents never get a reveal path.",
    connectorIds: ["1password", "bitwarden", "vaultwarden", "proton-pass"],
    requiresAuth: () => true,
  },
  {
    id: "identity",
    title: "Identity providers",
    summary:
      "Upstream IdPs brokered for sign-in. Providers are descriptors the Identity plane validates; token exchange stays platform-owned (ADR 0055).",
    connectorIds: ["auth0", "workos", "clerk", "better-auth"],
    requiresAuth: () => true,
  },
  {
    id: "certificates",
    title: "Certificates",
    summary:
      "Certificate authorities the Host can issue from. Trust class per issuer is platform-assigned and never falls back without consent (ADR 0052/0061).",
    connectorIds: ["letsencrypt", "zerossl", "cloudflare-origin-ca"],
    requiresAuth: (providerId) => providerId === "cloudflare-origin-ca",
  },
] as const;

export function defaultCapabilityConnectors(): CapabilityConnectorMap {
  return {
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
    cloud_secrets: { providerId: "doppler" },
    password_managers: { providerId: "1password" },
    identity: { providerId: "auth0" },
    certificates: { providerId: "letsencrypt" },
  };
}

export function capabilityDef(id: CapabilityId): CapabilityDef {
  const found = CAPABILITIES.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown capability ${id}`);
  return found;
}

export function normalizeCapabilityConnectors(
  raw:
    | Partial<Record<CapabilityId, Partial<CapabilityConnectorBinding>>>
    | null
    | undefined,
): CapabilityConnectorMap {
  const defaults = defaultCapabilityConnectors();
  const out = { ...defaults };
  for (const def of CAPABILITIES) {
    const incoming = raw?.[def.id];
    if (!incoming) continue;
    const providerId =
      isString(incoming.providerId) &&
      def.connectorIds.includes(incoming.providerId)
        ? incoming.providerId
        : defaults[def.id].providerId;
    const next: CapabilityConnectorBinding = { providerId };
    if (isString(incoming.connectionId) && incoming.connectionId.trim()) {
      next.connectionId = incoming.connectionId.trim();
    }
    if (isString(incoming.remote) && incoming.remote.trim()) {
      next.remote = incoming.remote.trim();
    }
    out[def.id] = next;
  }
  return out;
}

export function connectorLabel(providerId: string): string {
  switch (providerId) {
    case "webcrypto":
      return "WebCrypto (this device)";
    case "sealed-local":
      return "Sealed local (Host)";
    case "yubikey":
      return "YubiKey";
    case "fido2":
      return "FIDO2 security key";
    case "age":
      return "age (this device)";
    case "password-store":
      return "Local git password-store";
    case "aws-kms":
      return "AWS KMS";
    case "azure-key-vault-keys":
      return "Azure Key Vault";
    case "gcp-kms":
      return "Google Cloud KMS";
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "letsencrypt":
      return "Let's Encrypt";
    case "zerossl":
      return "ZeroSSL";
    case "cloudflare-origin-ca":
      return "Cloudflare Origin CA";
    case "1password":
      return "1Password";
    case "vault":
      return "HashiCorp Vault";
    case "openbao":
      return "OpenBao";
    default:
      return providerId;
  }
}
