/** Client-side E2EE helpers mirroring crates/human-vault (TypeScript). */
export const ENVELOPE_VERSION = 1;

export interface AssociatedData {
  envelope_version: number;
  item_id: string;
  organization_id: string;
  project_id: string;
  collection_id: string;
  key_id: string;
  revision: number;
}

/** Webpage API surface — typed broker request only (never getSecret). */
export interface BrokerRequest {
  connection: string;
  operation: string;
  resource: string;
  parametersDigest: string;
  audience: string;
  expiresInSeconds: number;
}
