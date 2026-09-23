import { isString } from "@opensesame/os-domain";
/**
 * Platform capability → connector bindings.
 *
 * OpenSesame's brokered capabilities are organized as families (ADR 0065):
 * encryption key vault (local storage), git history/persistence (backup and
 * file storage), cloud secret storage, password managers, identity,
 * certificates, and the three MFA delivery families (authenticator / email /
 * SMS). Settings binds each capability to a Host catalog connector.
 * Defaults: WebCrypto on this device for encryption; GitHub for encrypted
 * secret history; vault-self for authenticator MFA; Resend / Twilio for
 * email / SMS MFA; the first listed connector everywhere else.
 */

export type CapabilityId =
  | "encryption"
  | "history"
  | "cloud_secrets"
  | "password_managers"
  | "identity"
  | "certificates"
  | "mfa_authenticator"
  | "mfa_email"
  | "mfa_sms";

export type HistoryBackupGroup = "git" | "postgres";

/** One selected history backup road (multi-select on the backups step). */
export type HistoryBackupSelection = {
  providerId: string;
  group: HistoryBackupGroup;
  connectionId?: string;
  remote?: string;
  claimState?: "provisional" | "claimed";
  provisionalAccountId?: string;
};

export type CapabilityConnectorBinding = {
  providerId: string;
  /** Host connection id when the connector needs (or has completed) auth. */
  connectionId?: string;
  /**
   * Host consent readiness. For encryption/root protection, a nonempty
   * `connectionId` alone is not authorized (KP-14) — callers must record
   * `pending` while consent is resumable and `authorized` only after active
   * consent. Other capabilities treat a bare `connectionId` as authorized
   * when this field is omitted (legacy).
   */
  authorization?: "missing" | "pending" | "authorized" | "expired";
  /** For history: git remote URL (e.g. https://github.com/org/store.git). */
  remote?: string;
  /** Multi-select history backups on git remotes. */
  selections?: HistoryBackupSelection[];
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
      "Where vault and sealed-store keys are wrapped. Password wraps use WebCrypto on this device; passkeys protect via WebAuthn PRF under Unlock methods / Vault key protection — not as a connector. age recipients and cloud KMS are optional external protectors; YubiKey PIV is advanced hardware.",
    connectorIds: [
      "webcrypto",
      "sealed-local",
      "age",
      "yubikey",
      "aws-kms",
      "azure-key-vault-keys",
      "gcp-kms",
    ],
    requiresAuth: (providerId) =>
      providerId !== "webcrypto" &&
      providerId !== "sealed-local" &&
      providerId !== "age",
  },
  {
    id: "history",
    title: "History & persistence",
    summary: "Optional persistence for encrypted secrets on git remotes.",
    connectorIds: [
      "github",
      "password-store",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "git",
    ],
    requiresAuth: (providerId) =>
      providerId === "github" ||
      providerId === "gitlab" ||
      providerId === "bitbucket" ||
      providerId === "codeberg" ||
      providerId === "origin",
    authScopes: (providerId) => {
      if (providerId === "github") {
        // Classic OAuth App path. GitHub Apps omit scope= on Authorize so the
        // App's Administration/Contents/Workflows permissions apply instead.
        return ["read:user", "repo", "workflow"];
      }
      if (providerId === "gitlab") return ["read_user", "api"];
      if (providerId === "bitbucket") {
        return ["account", "repository", "repository:write"];
      }
      // Forgejo/Codeberg OAuth scopes are not enforced by the forge yet.
      if (providerId === "codeberg") return [];
      if (providerId === "origin") {
        return ["repository:contents:read", "repository:contents:write"];
      }
      return undefined;
    },
  },
  {
    id: "cloud_secrets",
    title: "Cloud secret storage",
    summary:
      "Where brokered credentials live upstream. Agents only ever hold ConnectionRefs, never the credential itself.",
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
      "Upstream IdPs brokered for sign-in. Providers are descriptors the sign-in service validates; token exchange stays platform-owned (ADR 0055).",
    connectorIds: ["auth0", "workos", "clerk", "better-auth"],
    requiresAuth: () => true,
  },
  {
    id: "certificates",
    title: "Certificates",
    summary:
      "Certificate authorities OpenSesame can issue from. Trust class per issuer is platform-assigned and never falls back without consent (ADR 0052/0061).",
    connectorIds: ["letsencrypt", "zerossl", "cloudflare-origin-ca"],
    requiresAuth: (providerId) => providerId === "cloudflare-origin-ca",
  },
  {
    id: "mfa_authenticator",
    title: "Authenticator app",
    summary:
      "Where the TOTP second step lives. This vault can hold its own entry and supply the code (ADR 0113); a password-manager bridge keeps the seed in a manager you already run.",
    connectorIds: [
      "vault-self",
      "bitwarden",
      "vaultwarden",
      "1password",
      "proton-pass",
    ],
    requiresAuth: (providerId) => providerId !== "vault-self",
  },
  {
    id: "mfa_email",
    title: "Email code",
    summary:
      "Who delivers a one-time email code when a sign-in service is connected. Connect an email provider; enrollment still happens from Settings › Security once a vault exists.",
    connectorIds: ["resend", "sendgrid", "postmark", "brevo"],
    requiresAuth: () => true,
  },
  {
    id: "mfa_sms",
    title: "Text message",
    summary:
      "Who delivers a one-time SMS code when a sign-in service is connected. A number can move SIMs — a fallback, never the first second step (ADR 0091).",
    connectorIds: ["twilio", "messagebird", "vonage", "plivo"],
    requiresAuth: () => true,
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
    mfa_authenticator: { providerId: "vault-self" },
    mfa_email: { providerId: "resend" },
    mfa_sms: { providerId: "twilio" },
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
    if (
      incoming.authorization === "missing" ||
      incoming.authorization === "pending" ||
      incoming.authorization === "authorized" ||
      incoming.authorization === "expired"
    ) {
      next.authorization = incoming.authorization;
    }
    if (isString(incoming.remote) && incoming.remote.trim()) {
      next.remote = incoming.remote.trim();
    }
    if (def.id === "history" && Array.isArray(incoming.selections)) {
      const selections: HistoryBackupSelection[] = [];
      for (const raw of incoming.selections) {
        if (
          !isString(raw.providerId) ||
          !def.connectorIds.includes(raw.providerId)
        ) {
          continue;
        }
        const group: HistoryBackupGroup =
          raw.group === "postgres" ? "postgres" : "git";
        const row: HistoryBackupSelection = {
          providerId: raw.providerId,
          group,
        };
        if (isString(raw.connectionId) && raw.connectionId.trim()) {
          row.connectionId = raw.connectionId.trim();
        }
        if (isString(raw.remote) && raw.remote.trim()) {
          row.remote = raw.remote.trim();
        }
        if (raw.claimState === "provisional" || raw.claimState === "claimed") {
          row.claimState = raw.claimState;
        }
        if (
          isString(raw.provisionalAccountId) &&
          raw.provisionalAccountId.trim()
        ) {
          row.provisionalAccountId = raw.provisionalAccountId.trim();
        }
        selections.push(row);
      }
      // Keep `[]` so toggling the last history remote off sticks (otherwise
      // persist drops `selections` and load re-defaults to github).
      next.selections = selections;
    }
    out[def.id] = next;
  }
  // Legacy fido2 was a mistaken encryption connector id. Passkeys protect
  // via WebAuthn PRF under Unlock methods / Vault key protection.
  if (out.encryption?.providerId === "fido2") {
    out.encryption = { providerId: "webcrypto" };
  }
  return out;
}

export function connectorLabel(providerId: string): string {
  switch (providerId) {
    case "webcrypto":
      return "WebCrypto (this device)";
    case "sealed-local":
      return "Sealed local (this device)";
    case "yubikey":
      return "YubiKey PIV (advanced)";
    case "age":
      return "age recipient (recovery)";
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
    case "bitbucket":
      return "Bitbucket";
    case "codeberg":
      return "Codeberg";
    case "origin":
      return "Cursor Origin";
    case "git":
      return "Git (any remote)";
    case "letsencrypt":
      return "Let's Encrypt";
    case "zerossl":
      return "ZeroSSL";
    case "cloudflare-origin-ca":
      return "Cloudflare Origin CA";
    case "1password":
      return "1Password";
    case "bitwarden":
      return "Bitwarden";
    case "vaultwarden":
      return "Vaultwarden";
    case "proton-pass":
      return "Proton Pass";
    case "doppler":
      return "Doppler";
    case "aws-secrets-manager":
      return "AWS Secrets Manager";
    case "gcp-secret-manager":
      return "Google Cloud Secret Manager";
    case "azure-key-vault-secrets":
      return "Azure Key Vault";
    case "bitwarden-secrets-manager":
      return "Bitwarden Secrets Manager";
    case "auth0":
      return "Auth0";
    case "workos":
      return "WorkOS";
    case "clerk":
      return "Clerk";
    case "better-auth":
      return "Better Auth";
    case "vault":
      return "HashiCorp Vault";
    case "openbao":
      return "OpenBao";
    case "vault-self":
      return "This vault";
    case "resend":
      return "Resend";
    case "sendgrid":
      return "SendGrid";
    case "postmark":
      return "Postmark";
    case "brevo":
      return "Brevo";
    case "twilio":
      return "Twilio";
    case "messagebird":
      return "MessageBird";
    case "vonage":
      return "Vonage";
    case "plivo":
      return "Plivo";
    default:
      return providerId;
  }
}

/**
 * Encryption key SOPs configured under Settings, not Connections brokers.
 * Age is typage on this device; WebCrypto / sealed-local are built-ins.
 */
const SETTINGS_ENCRYPTION_KEYS: ReadonlySet<string> = new Set([
  "webcrypto",
  "sealed-local",
  "age",
]);

/** True when the id is a key vault SOP, not a Connections catalog connector. */
export function isSettingsEncryptionKey(providerId: string): boolean {
  return SETTINGS_ENCRYPTION_KEYS.has(providerId);
}
