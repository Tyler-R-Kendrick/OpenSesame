/**
 * What a provider that connects with the person's own key, from the browser,
 * has to say about itself (ADR 0198). One spec per provider family; the flows
 * that save, re-prove, read and forget a connection are written once in
 * `native-key-driver.ts` and are the same for every family.
 */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import type { NativeApiError } from "./native-api-http.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export type NativeKeyTarget = {
  /** The id the connection is stored under: an alias when the app was asked by one. */
  providerId: string;
  /** Public configuration: a region, a project, a store name. Never a secret. */
  parameters: Record<string, string>;
  /** Secret material, sealed at rest and never shown after it is saved. */
  credentials: Record<string, string>;
};

export type NativeKeyField = {
  id: string;
  label: string;
  kind: "text" | "url" | "choice" | "textarea";
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  choices?: readonly { id: string; label: string }[];
};

export type NativeKeyAction = {
  id: string;
  label: string;
  fields: readonly NativeKeyField[];
};

/** What the connection form draws for one provider id of the family. */
export type NativeKeyUi = {
  /** The provider's name, for the form and for errors: "AWS Secrets Manager". */
  name: string;
  /** The one sign-in method's label: "AWS access key". */
  methodLabel: string;
  instructions: string;
  fields: readonly NativeKeyField[];
  links: readonly { label: string; url: string }[];
  disconnectExplanation: string;
  /** Reads a person can ask for once verified, beyond re-checking access. */
  actions: readonly NativeKeyAction[];
};

export type NativeKeyItem = {
  id: string;
  label: string;
  /** Present only for a read the person asked for; shown once and never stored. */
  secretValue?: string;
};

export type NativeKeyResult = { label: string; items: NativeKeyItem[] };

/** What a proved key tells the connection record about itself. */
export type NativeKeyProof = {
  identity: { id: string; label: string; kind: string };
  targets: readonly { id: string; label: string; kind: string }[];
  /** What the grant row says: "AWS signing credentials". */
  grantLabel: string;
  /** The one public value that names where this key works, kept as the connection's target. */
  target: { key: string; id: string };
  /** What proving made that the connection must keep: an account a provider just opened, a key generated here. */
  update?: {
    parameters?: Record<string, string>;
    credentials?: Record<string, string>;
  };
};

export type NativeKeyOperation<T extends NativeKeyTarget> = {
  id: string;
  /** Exactly these input keys, no others: nothing a person was not offered. */
  inputKeys: readonly string[];
  run: (
    target: T,
    transport: NativeProviderTransport,
    input: Record<string, string>,
  ) => Promise<NativeKeyResult>;
};

export type NativeKeySpec<T extends NativeKeyTarget> = {
  /** The family's name, for errors: "AWS". */
  family: string;
  /** Prefix of the connection ids this family mints. */
  idPrefix: string;
  accepts: (providerId: string) => boolean;
  classification: {
    publicParameters: string[];
    privateCredentials: string[];
  };
  ui: (providerId: string) => NativeKeyUi;
  /**
   * Validate and normalize what the form sent; throws an Error with text safe to
   * show. May be async: a family whose key is made here (an ACME account) makes
   * it now, and it is kept only if the proof succeeds.
   */
  parse: (
    input: NativeApiConfigureInput,
    saved: NativeConnectorRecord | null,
  ) => T | Promise<T>;
  /** Binds a saved connection to exactly what it was verified for; a changed one is a new connection. */
  fingerprint: (target: T) => Promise<string>;
  /** The real call that proves the key. Throws a NativeApiError when the provider refuses it. */
  prove: (
    target: T,
    transport: NativeProviderTransport,
  ) => Promise<NativeKeyProof>;
  /** Reads, by operation id. `provider.read` is always the re-proof and needs no entry. */
  operations: readonly NativeKeyOperation<T>[];
  /** An error that ends the proof a saved key carried. */
  refused?: (error: NativeApiError) => boolean;
  /** Rebuild the target a saved connection stands for. */
  targetOf: (saved: NativeConnectorRecord) => T;
};
