/** Owner plane for a projected configuration resource (C-RESOURCE). */
export type OwnerPlane =
  | "client_local"
  | "device_bootstrap"
  | "identity"
  | "host";

export type PersistenceKind =
  | "durable"
  | "ephemeral"
  | "offline_draft"
  | "externally_managed"
  | "unavailable";

export type ResourceCapabilities = {
  read: boolean;
  edit: boolean;
  history: boolean;
  export: boolean;
  compare: boolean;
  test: boolean;
};

/** Immutable scoped identity. Display paths are aliases, never authority. */
export type ResourceDescriptor = {
  resourceKey: string;
  displayPath: string;
  ownerPlane: OwnerPlane;
  schemaId: string;
  schemaVersion: number;
  capabilities: ResourceCapabilities;
  revisionToken: string;
  sensitivity: "public" | "metadata" | "concealed" | "secret";
  persistence: PersistenceKind;
};

export type DiagnosticSeverity = "error" | "warning" | "info";

export type SourceRange = {
  start: number;
  end: number;
  line: number;
  column: number;
};

export type ConfigDiagnostic = {
  severity: DiagnosticSeverity;
  message: string;
  range?: SourceRange;
  code: string;
};

export type CommitStatus =
  | "applied_durable"
  | "applied_ephemeral"
  | "draft_saved"
  | "conflict"
  | "refused";

export type CommitResult = {
  status: CommitStatus;
  revisionToken?: string;
  message: string;
  originalSource?: string;
  localSource?: string;
  currentSource?: string;
};

export type SemanticChangeKind = "presentation" | "security";
