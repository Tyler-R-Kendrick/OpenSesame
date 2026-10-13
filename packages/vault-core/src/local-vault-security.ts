/** Portable owner-configured management contract. Identity tokens and metadata grant no vault authority. */
import type { JsonObject } from "@opensesame/os-domain";

export type LocalVaultPrimary =
  | { kind: "password" | "pin"; secret: string }
  | { kind: "passkey" }
  | {
      kind: "protector";
      method: "recovery" | "age" | "agePasskey";
      secret?: string;
    };
export type LocalVaultFactorRoute = "totp" | "email" | "sms" | "recovery";
export type LocalVaultFactor = {
  kind: "totp" | "remote" | "recovery";
  code: string;
};
export type LocalVaultCodeStatus = Readonly<{
  channel: "email" | "sms";
  expiresAt: string;
}>;
export type LocalVaultOperation<T extends object> = Readonly<{
  kind: "challenge";
  routes: readonly LocalVaultFactorRoute[];
  requestCode: (channel: "email" | "sms") => Promise<LocalVaultCodeStatus>;
  complete: (factor: LocalVaultFactor) => Promise<T>;
  /** Retires and drains this accepted operation only. */
  cancel: () => Promise<void>;
}>;
export type LocalVaultStarted<T extends object> =
  | Readonly<{ kind: "complete"; result: T }>
  | LocalVaultOperation<T>;
export type LocalRetiredResponse = "reject" | "synthetic_decoy";
export type LocalRetiredCommand =
  | { kind: "inspect" }
  | {
      kind: "change";
      change:
        | {
            type: "enroll";
            password: string;
            response: LocalRetiredResponse;
            retentionMs?: number;
          }
        | { type: "remove"; id: string }
        | { type: "clear-stale" | "clear-events" };
    };
export type LocalRetiredEvent =
  | {
      type: "retired_credential_observed";
      trapId: string;
      at: string;
      response: LocalRetiredResponse;
    }
  | {
      type: "synthetic_decoy_interaction";
      trapId: string;
      at: string;
      response: "synthetic_decoy";
      action:
        | "vault_read"
        | "vault_export"
        | "vault_write"
        | "authority_denied";
    };
export type LocalRetiredInspection = Readonly<{
  traps: readonly Readonly<{
    id: string;
    createdAt: string;
    expiresAt: string;
    response: LocalRetiredResponse;
  }>[];
  events: readonly LocalRetiredEvent[];
  stale: boolean;
}>;
export type LocalCanaryReceiver = Readonly<{
  endpoint: string;
  serviceId: string;
  browserOrigin: string;
  bindPort: number;
}>;
export type LocalCanaryCommand = Readonly<{
  receiver: LocalCanaryReceiver;
  action:
    | { kind: "pairing" | "inspect" }
    | {
        kind: "enroll";
        label: string;
        artifactKind: "mcp-config" | "connection-reference";
        retentionDays: number;
        ownerConsent: true;
      }
    | { kind: "remove" | "export"; id: string };
}>;
export type LocalCanaryRecord = Readonly<{
  id: string;
  connectionRef: string;
  generation: string;
  contextId: string;
  label: string;
  artifactKind: "mcp-config" | "connection-reference";
  createdAt: number;
  expiresAt: number;
}>;
export type LocalCanaryEvent = Readonly<{
  id: string;
  event: "canary_connected" | "canary_tool_invoked";
  sequence: number;
  occurredAt: number;
}>;
export type LocalCanaryPairing = Readonly<{
  v: 1;
  endpoint: string;
  serviceId: string;
  bindPort: number;
  origin: string;
  ownerKeyId: string;
  ownerPublicJwk: Readonly<{ kty: "EC"; crv: "P-256"; x: string; y: string }>;
}>;
export type LocalCanaryResult =
  | Readonly<{ kind: "pairing"; pairing: LocalCanaryPairing }>
  | Readonly<{ kind: "enrolled"; record: LocalCanaryRecord }>
  | Readonly<{
      kind: "inspection";
      records: readonly LocalCanaryRecord[];
      events: readonly LocalCanaryEvent[];
      inactiveIds: readonly string[];
    }>
  | Readonly<{ kind: "removed"; id: string }>
  | Readonly<{ kind: "configuration"; id: string; configuration: JsonObject }>;
/** Local-only disposal DATA: never Root, a factor verdict, or a remote serializable capability. */
export type LocalVaultRetirementReport = Readonly<{
  observedWorkFailures: readonly unknown[];
  drainFailures: readonly unknown[];
}>;
export type LocalExternalAuthenticatorDraft = Readonly<{ uri: string }>;
export type LocalExternalAuthenticatorPort = Readonly<{
  begin: (
    primary: LocalVaultPrimary,
    signal?: AbortSignal,
  ) => Promise<LocalVaultStarted<LocalExternalAuthenticatorDraft>>;
  confirm: (
    draft: LocalExternalAuthenticatorDraft,
    code: string,
  ) => Promise<void>;
  /** Exact caller-delivered receipt only; a copied/adopted Promise is refused by the Core registry. */
  retireOperation: (
    accepted: Promise<LocalVaultStarted<LocalExternalAuthenticatorDraft>>,
  ) => Promise<LocalVaultRetirementReport>;
  /** Exact private issued draft only; exposing its URI is not authentication or confirmation. */
  retireDraft: (
    draft: LocalExternalAuthenticatorDraft,
  ) => Promise<LocalVaultRetirementReport>;
}>;
/** Supplied by the real local owner. Never derive this port from an OIDC session or an agent request. */
export type LocalVaultSecurityPort = Readonly<{
  externalAuthenticator?: LocalExternalAuthenticatorPort;
  beginRetired: (
    primary: LocalVaultPrimary,
    command: LocalRetiredCommand,
    signal?: AbortSignal,
  ) => Promise<LocalVaultStarted<LocalRetiredInspection>>;
  beginCanary: (
    primary: LocalVaultPrimary,
    command: LocalCanaryCommand,
    signal?: AbortSignal,
  ) => Promise<LocalVaultStarted<LocalCanaryResult>>;
  isRetiredResultCurrent: (result: LocalRetiredInspection) => boolean;
  isCanaryResultCurrent: (result: LocalCanaryResult) => boolean;
}>;
