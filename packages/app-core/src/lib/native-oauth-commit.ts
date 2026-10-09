import type { NativeOAuthVerification } from "./native-browser-oauth-verify.js";
/** Activation consumes the exact retained credential only after provider verification. */
import type {
  NativeConfiguration,
  NativeFieldClassification,
  NativeGrant,
} from "./native-connector-schema.js";
import { NativeGrantSchema } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

function verifiedIntent(
  current: NativeConnectorRecord,
  intentId: string,
  expected: NativeGrant,
) {
  const intent = current.privateState.recovery.find(
    (entry) => entry.id === intentId,
  );
  const grant = intent?.grant;
  if (
    !intent ||
    !grant ||
    intent.fingerprint !== current.configuration.fingerprint ||
    intent.credentials?.phase !== "verify"
  )
    throw new NativeOAuthError("expired");
  if (
    JSON.stringify(NativeGrantSchema.parse(grant)) !==
    JSON.stringify(NativeGrantSchema.parse(expected))
  )
    throw new NativeOAuthError("expired");
  return { intent, grant };
}
export async function commitNativeOAuthGrant(
  id: string,
  intentId: string,
  verified: NativeOAuthVerification,
  classification: (
    configuration: NativeConfiguration,
  ) => NativeFieldClassification,
  transport: NativeProviderTransport,
  expected: { revision: number; grant: NativeGrant },
) {
  const record = requireNativeOAuthRecord(id);
  if (record.revision !== expected.revision)
    throw new NativeOAuthError("expired");
  transport.assertCurrent();
  return updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    classification(record.configuration),
    (current) => {
      transport.assertCurrent();
      const { intent, grant } = verifiedIntent(
        current,
        intentId,
        expected.grant,
      );
      const expectedIdentity = intent.credentials?.identity_id;
      if (
        expectedIdentity &&
        expectedIdentity !== verified.identity.id &&
        verified.identity.assurance !== "credential-valid"
      )
        throw new NativeOAuthError("provider");
      const old = current.privateState.grants[grant.actor];
      if (old) {
        const targetId = old.targetId ?? intent.targetId;
        current.privateState.recovery.push({
          id: `oauth-replace:${intent.id}`,
          kind: "revoke",
          providerId: old.providerId,
          actor: old.actor,
          fingerprint: old.fingerprint,
          targetId,
          grant: { ...old, targetId },
        });
      }
      const active: NativeGrant = {
        ...grant,
        targetId: verified.identity.id,
        scopes: verified.scopes,
      };
      current.privateState.grants[grant.actor] = active;
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      const verifiedAt = Math.max(
        Date.now(),
        (current.runtime.verifiedAt ?? 0) + 1,
      );
      current.privateState.verification = {
        fingerprint: current.configuration.fingerprint,
        verifiedAt,
        kind: "provider",
      };
      current.runtime = {
        verifiedAt,
        identity: verified.identity,
        targets: verified.targets,
        grants: [
          {
            actor: grant.actor,
            label: "Authorized user",
            permissionState:
              verified.scopes === null ? "provider-managed" : "known",
            grantedScopes: verified.scopes ?? [],
            expiresAt: grant.expiresAt,
            needsReauth: false,
          },
        ],
      };
      return current;
    },
  );
}
