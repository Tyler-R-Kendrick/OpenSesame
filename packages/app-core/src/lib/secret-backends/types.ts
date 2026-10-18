/** The browser's common secret-store port. A session contains no credential material. */
export type SecretBackendMode =
  | "local"
  | "file-import"
  | "credential-management"
  | "proton-pass"
  | "onepassword-sdk"
  | "onepassword-connect"
  | "bitwarden-api"
  | "bitwarden-secrets"
  | "infisical"
  | "passwordstate";

export type SecretBackendDraft = {
  providerId: string;
  name: string;
  mode: SecretBackendMode;
  baseUrl: string;
  identityUrl: string;
  /** Public provider application/version header; absent on legacy connections. */
  appVersion?: string;
  token: string;
  /** Client-only inventory encryption material, distinct from HTTP authentication. */
  encryptionKey?: string;
  /** Public identity bound to the configured encrypted inventory. */
  remoteStoreId?: string;
  vaultId: string;
  projectId: string;
  organizationId: string;
  environment: string;
  secretPath: string;
  clientId: string;
  clientSecret: string;
  passwordListId: string;
  fileFormat: string;
  accountEmail?: string;
  deviceIdentifier?: string;
};

/** File contents and decryption passwords exist for one explicit operation only. */
export type SecretBackendConfiguration = SecretBackendDraft & {
  file?: File;
  filePassword?: string;
  /** Native account unlock is never persisted with a connection. */
  masterPassword?: string;
};

export type SecretBackendCapabilities = {
  itemKinds?: readonly ("note" | "login" | "secret")[];
  itemFields?: readonly ("username" | "url" | "notes" | "secret")[];
  vaultBackup?: {
    kind: "note" | "login" | "secret";
    field: "notes" | "secret";
    maxBytes?: number;
  };
  list: boolean;
  get: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  import: boolean;
};

export type SecretBackendSession = Readonly<{
  id: string;
  backendId: string;
  authenticatedAt: string;
  /** Ends when this exact provider session is removed or terminates. */
  signal?: AbortSignal;
}>;

export type SecretBackendItemSummary = {
  id: string;
  name: string;
  kind: "note" | "login" | "secret";
};

export type SecretBackendItemInput = {
  name: string;
  notes: string;
  secret: string;
  kind?: SecretBackendItemSummary["kind"];
  username?: string;
  url?: string;
  fields?: Record<string, string>;
};

export type SecretBackendItem = SecretBackendItemSummary & {
  notes: string;
  secret: string;
  username?: string;
  url?: string;
  fields?: Record<string, string>;
};

export type SecretBackendImportReport = {
  imported: number;
  skipped: number;
  warnings: string[];
};

export interface SecretBackend {
  readonly id: string;
  readonly name: string;
  /** This instance's captured capability/owner lifetime, separate from provider sessions. */
  readonly signal?: AbortSignal;
  readonly capabilities: SecretBackendCapabilities;
  authenticate(
    config: SecretBackendConfiguration,
  ): Promise<SecretBackendSession>;
  /** Only an explicit initialization action may create a missing remote store. */
  initialize?(
    config: SecretBackendConfiguration,
  ): Promise<SecretBackendSession>;
  getNotes(name: string, session: SecretBackendSession): Promise<string>;
  getItem(
    name: string,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem>;
  listItems(session: SecretBackendSession): Promise<SecretBackendItemSummary[]>;
  createItem?(
    item: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem>;
  updateItem?(
    id: string,
    item: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem>;
  deleteItem?(id: string, session: SecretBackendSession): Promise<void>;
  importToLocal?(
    session: SecretBackendSession,
  ): Promise<SecretBackendImportReport>;
  disconnect(session: SecretBackendSession): Promise<void>;
}

export type SecretBackendFetch = typeof globalThis.fetch;

export class SecretBackendError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "authentication"
      | "network"
      | "response"
      | "not-found"
      | "ambiguous"
      | "unsupported"
      | "locked"
      | "stale",
    message: string,
  ) {
    super(message);
    this.name = "SecretBackendError";
  }
}
