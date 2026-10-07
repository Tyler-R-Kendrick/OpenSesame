/** Portable connection contracts, independent of routing and session state. */
export type ProviderCategory =
  | "identity"
  | "backup_recovery"
  | "encryption"
  | "password_managers"
  | "agent_harnesses"
  | "networking"
  | "wallet"
  | "cloud_secret_storage"
  | "local_storage"
  | "developer"
  | "productivity"
  | "communication"
  | "storage"
  | "crm"
  | "testing"
  | "certificates"
  | "custom";
export type AuthKind =
  | "oauth2_authorization_code"
  | "api_key"
  | "configuration";

export type ConfigurationField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
};

export type ScopeDef = {
  name: string;
  description: string;
  sensitive: boolean;
  default: boolean;
};

export type Egress = {
  scheme: string;
  authorities: string[];
  pathPrefixes: string[];
};

export type Provider = {
  id: string;
  displayName: string;
  category: ProviderCategory;
  docsUrl: string;
  authKind: AuthKind;
  supportsRefresh: boolean;
  /** Deployment has a client id and secret for this provider. */
  configured: boolean;
  /** Host can supply every connection field without asking the user. */
  autoConfigurable: boolean;
  /** Exact environment variables the deployment is missing. Empty when configured. */
  missingConfig: string[];
  /** Host OAuth callback URL for this provider, when applicable. */
  callbackUrl: string | null;
  scopes: ScopeDef[];
  egress: Egress;
  operations: string[];
  configurationFields?: ConfigurationField[];
};

export type ConnectionStatus =
  | "pending"
  | "active"
  | "needs_reauth"
  | "expired"
  | "revoked"
  | "error";

export type BindingTargetKind =
  | "organization"
  | "project"
  | "agent"
  | "group"
  | "device"
  | "identity";

export type Binding = {
  id: string;
  targetKind: BindingTargetKind;
  targetId: string;
  targetLabel: string | null;
  createdAt: string;
};

export type Connection = {
  connectionId: string;
  connectionRef: string;
  logicalName: string;
  displayName: string;
  providerId: string;
  /** Tenant integration that sealed this connection's OAuth/App credentials. */
  integrationId: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  organizationId: string;
  projectId: string | null;
  ownerKind: string;
  shareability: "private" | "delegable" | "organization_wide";
  requestedScopes: string[];
  grantedScopes: string[];
  accountLabel: string | null;
  expiresAt: string | null;
  refreshable: boolean;
  lastRefreshedAt: string | null;
  maxInvokeLevel: number;
  egress: Egress;
  bindings: Binding[];
  createdAt: string;
  updatedAt: string;
};
