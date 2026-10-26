/** Captured configured OIDC, one original popup/carrier and genuine local admission. */
import { env } from "../../host.js";
import type {
  IdentityConnectionDraft,
  IdentityConnectionTest,
} from "../../lib/identity-connections-schema.js";
import type { NativeIdentityOwner } from "../../lib/identity-native-owner.js";
import {
  configuredOidcClientOptions,
  configuredOidcOrganization,
  isNativeOidcConfiguration,
  nativeOidcCallbackUri,
} from "../../lib/identity-oidc-config.js";
import type { IdentityHTTPPort } from "../../lib/tailscale/browser-node-identity-port.js";
import { page } from "../../ports.js";
import type { NativeAuthPopup } from "../native-auth-session.js";
import {
  type NativeOidcAdmissionRuntime,
  createNativeOidcAdmissionRuntime,
} from "./admission.js";
import type { OidcOwner } from "./claims.js";
import { type ConfiguredOidc, prepareConfiguredOidc } from "./transaction.js";

let admission: NativeOidcAdmissionRuntime | null = null;
let admittedOwner: NativeIdentityOwner | null = null;
function config(draft: IdentityConnectionDraft): ConfiguredOidc {
  if (!isNativeOidcConfiguration(draft))
    throw new Error("Use the existing public OIDC flow for this connection");
  if (draft.oidcClientType === "confidential" && !draft.clientSecret)
    throw new Error("Enter the confidential OIDC client secret");
  return Object.freeze({
    issuer: draft.issuer,
    clientId: draft.clientId,
    clientSecret: draft.clientSecret,
    scope: draft.scope,
    organization: configuredOidcOrganization(draft),
    ...configuredOidcClientOptions(draft),
  });
}
function redirectUri(): string {
  return nativeOidcCallbackUri(page().location.origin, env().BASE_URL);
}
export async function testConfiguredNativeOidc(
  draft: IdentityConnectionDraft,
  owner: OidcOwner,
  transport: IdentityHTTPPort,
): Promise<IdentityConnectionTest> {
  owner.assertCurrent();
  transport.assertCurrent();
  const prepared = await prepareConfiguredOidc(
    config(draft),
    redirectUri(),
    transport,
    owner,
  );
  owner.assertCurrent();
  transport.assertCurrent();
  return {
    message: prepared.manualEndpoints
      ? "The configured OIDC signing-key endpoint is reachable. Sign in to verify the client, account and organization."
      : "OIDC discovery supports the configured client authentication. Sign in to verify your account and organization.",
  };
}
function onceRetirement(retire: () => Promise<void>) {
  let retiring: Promise<void> | null = null;
  return () => {
    if (retiring) return retiring;
    let begin = () => {};
    retiring = new Promise<void>((resolve, reject) => {
      begin = () => {
        void (async () => retire())().then(resolve, reject);
      };
    });
    begin();
    return retiring;
  };
}
/** Caught failures remain opaque: cleanup must preserve the original thrown value. */
type OidcProtocolFailure = Readonly<{ cause: unknown }>;
async function retireFailedProtocol(
  failure: OidcProtocolFailure,
  retire: () => Promise<void>,
): Promise<never> {
  const error = failure.cause;
  try {
    await retire();
  } catch (cleanup) {
    if (cleanup === error) throw error;
    throw new AggregateError(
      [error, cleanup],
      "OIDC failed and its original carrier retirement also failed",
      { cause: error },
    );
  }
  throw error;
}
export async function signInConfiguredNativeOidc(
  connectionId: string,
  input: IdentityConnectionDraft,
  owner: NativeIdentityOwner,
  popup: Pick<NativeAuthPopup, "wait" | "cancel">,
  transport: IdentityHTTPPort,
  retire: () => Promise<void>,
): Promise<void> {
  const draft = Object.freeze({ ...input });
  let runtime: NativeOidcAdmissionRuntime | null = null;
  let completed = false;
  let admissionStarted = false;
  let protocolRetired = false;
  const retireOriginal = onceRetirement(retire);
  const abort = () => {
    popup.cancel();
    if (admittedOwner === owner) {
      admittedOwner = null;
      runtime?.clear();
    }
  };
  const release = () => {
    owner.signal.removeEventListener("abort", abort);
    transport.signal.removeEventListener("abort", abort);
    if (admittedOwner === owner) admittedOwner = null;
    owner.release();
  };
  try {
    owner.assertPending();
    transport.assertCurrent();
    owner.prepareRuntime(() => {
      admission?.dispose();
      admission = createNativeOidcAdmissionRuntime();
    });
    runtime = admission;
    if (!runtime)
      throw new Error("Native OIDC session runtime was not installed");
    owner.signal.addEventListener("abort", abort, { once: true });
    transport.signal.addEventListener("abort", abort, { once: true });
    const attempt = await prepareConfiguredOidc(
      config(draft),
      redirectUri(),
      transport,
      { signal: owner.signal, assertCurrent: owner.assertPending },
    );
    owner.assertPending();
    transport.assertCurrent();
    const answer = await popup.wait({
      authorizationUrl: attempt.authorizationUrl,
      state: attempt.state,
      expiresAt: attempt.expiresAt,
      redirectUri: redirectUri(),
      signal: AbortSignal.any([owner.signal, transport.signal]),
    });
    owner.assertPending();
    transport.assertCurrent();
    const proof = await attempt.complete(answer);
    owner.assertPending();
    transport.assertCurrent();
    admissionStarted = true;
    await runtime.admit(proof, {
      connectionId,
      label: draft.name,
      assertSessionCurrent: (claims) =>
        owner.assertSessionCurrent(claims.issuer, claims.audience),
      retireProtocol: async () => {
        owner.assertPending();
        transport.assertCurrent();
        transport.signal.removeEventListener("abort", abort);
        await retireOriginal();
        owner.assertPending();
        protocolRetired = true;
      },
      releaseSession: release,
    });
    owner.assertSessionCurrent(draft.issuer, draft.clientId);
    if (!protocolRetired)
      throw new Error("Original OIDC protocol did not retire before admission");
    admittedOwner = owner;
    completed = true;
  } catch (error) {
    transport.signal.removeEventListener("abort", abort);
    await retireFailedProtocol({ cause: error }, retireOriginal);
  } finally {
    popup.cancel();
    if (!completed) {
      release();
      if (admissionStarted) runtime?.clear();
    }
  }
}
