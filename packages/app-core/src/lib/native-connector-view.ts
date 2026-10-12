/** Public projections expose verified facts, never the sealed authority record. */
import type {
  NativeConfiguration,
  NativePrivateState,
  NativeRuntime,
} from "./native-connector-schema.js";

export type NativeConnectorStatus =
  | "configuration"
  | "authorizing"
  | "connected"
  | "reauthorize"
  | "cleanup";
export interface NativeConnectorView {
  providerId: string;
  connectionId: string;
  revision: number;
  fingerprint: string;
  configuration: NativeConfiguration;
  status: NativeConnectorStatus;
  identity: NativeRuntime["identity"];
  targets: NativeRuntime["targets"];
  grants: NativeRuntime["grants"];
  verifiedAt: number | null;
  recovery: { id: string; kind: string; label: string; detail: string }[];
}

function authorized(
  configuration: NativeConfiguration,
  runtime: NativeRuntime,
  privateState: NativePrivateState,
): boolean {
  const verification = privateState.verification;
  if (
    runtime.verifiedAt === null ||
    !verification ||
    verification.fingerprint !== configuration.fingerprint ||
    verification.verifiedAt !== runtime.verifiedAt ||
    verification.kind !==
      (configuration.method === "native-local" ? "browser-local" : "provider")
  )
    return false;
  if (
    ["api-key", "oauth", "oidc"].includes(configuration.method) &&
    runtime.grants.length === 0
  )
    return false;
  if (
    Object.keys(privateState.grants).length !== runtime.grants.length ||
    Object.entries(configuration.requestedScopes).some(
      ([actor, scopes]) =>
        scopes.length > 0 &&
        !runtime.grants.some((grant) => grant.actor === actor),
    )
  )
    return false;
  if (
    !Object.values(configuration.targetIds).every((id) =>
      runtime.targets.some((target) => target.id === id),
    )
  )
    return false;
  return runtime.grants.every((metadata) => {
    const grant = privateState.grants[metadata.actor];
    return (
      !!grant &&
      grant.providerId === configuration.providerId &&
      grant.fingerprint === configuration.fingerprint &&
      grant.actor === metadata.actor &&
      grant.kind === configuration.method &&
      grant.expiresAt === metadata.expiresAt &&
      (metadata.permissionState === "known" ||
        metadata.grantedScopes.length === 0) &&
      (grant.scopes === null
        ? metadata.permissionState !== "known"
        : metadata.permissionState !== "known" ||
          (grant.scopes.length === metadata.grantedScopes.length &&
            grant.scopes.every((scope) =>
              metadata.grantedScopes.includes(scope),
            )))
    );
  });
}

function requiresReauthorization(
  configuration: NativeConfiguration,
  runtime: NativeRuntime,
): boolean {
  return runtime.grants.some(
    (grant) =>
      grant.needsReauth ||
      (grant.expiresAt !== null && grant.expiresAt <= Date.now()) ||
      (grant.permissionState === "known" &&
        (configuration.requestedScopes[grant.actor] ?? []).some(
          (scope) => !grant.grantedScopes.includes(scope),
        )),
  );
}

export function nativeConnectorView(
  connectionId: string,
  revision: number,
  configuration: NativeConfiguration,
  runtime: NativeRuntime,
  privateState: NativePrivateState,
): NativeConnectorView {
  let status: NativeConnectorStatus = "configuration";
  if (activeDeviceConsent(configuration, privateState)) status = "authorizing";
  else if (privateState.recovery.length > 0) status = "cleanup";
  else if (requiresReauthorization(configuration, runtime))
    status = "reauthorize";
  else if (Object.keys(privateState.pending).length > 0)
    status = Object.values(privateState.pending).some(
      (pending) => pending.expiresAt <= Date.now(),
    )
      ? "reauthorize"
      : "authorizing";
  else if (authorized(configuration, runtime, privateState))
    status = "connected";
  return {
    providerId: configuration.providerId,
    connectionId,
    revision,
    fingerprint: configuration.fingerprint,
    configuration: structuredClone(configuration),
    status,
    identity: structuredClone(runtime.identity),
    targets: structuredClone(runtime.targets),
    grants: structuredClone(runtime.grants),
    verifiedAt: runtime.verifiedAt,
    recovery: privateState.recovery.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: "Provider cleanup required",
      detail:
        "Retry provider cleanup before changing or removing this connection.",
    })),
  };
}

function activeDeviceConsent(
  configuration: NativeConfiguration,
  privateState: NativePrivateState,
): boolean {
  const pending = privateState.pending.user;
  const [intent] = privateState.recovery;
  return (
    configuration.providerId === "twitch" &&
    configuration.method === "oauth" &&
    Object.keys(privateState.pending).length === 1 &&
    !!pending &&
    pending.fingerprint === configuration.fingerprint &&
    pending.expiresAt > Date.now() &&
    privateState.recovery.length === 1 &&
    intent?.id === `oauth:${pending.state}` &&
    intent.fingerprint === pending.fingerprint &&
    intent.kind === "revoke" &&
    intent.credentials?.phase === "device-poll"
  );
}
