/** Lazy browser SAML adapter: operator metadata, genuine protocol evidence, original saved owner and local admission. */
import { env } from "../../host.js";
import type {
  IdentityConnectionDraft,
  IdentityConnectionTest,
} from "../../lib/identity-connections-schema.js";
import type { NativeIdentityOwner } from "../../lib/identity-native-owner.js";
import { samlMetadataEndpoint } from "../../lib/identity-saml-config.js";
import type { NativeProviderTransport } from "../../lib/native-connector-transport.js";
import type { NativeAuthPopup } from "../native-auth-session.js";
import {
  type NativeSamlAdmissionRuntime,
  createNativeSamlAdmissionRuntime,
} from "./admission.js";
import { createSamlAuthnPost } from "./authn-request.js";
import { readSamlIdpMetadata } from "./metadata.js";
import {
  SAML_POST_BYTES,
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./post-wire.js";
import { type NativeSamlSignIn, beginNativeSamlSignIn } from "./sign-in.js";

let admission: NativeSamlAdmissionRuntime | null = null;
let admittedOwner: NativeIdentityOwner | null = null;
const TIME_POLICY = Object.freeze({
  clockSkewMs: 60000,
  maxAssertionAgeMs: 300000,
  maxAuthenticationAgeMs: 86400000,
  maxSessionDurationMs: 3600000,
});
function scopeUrl(): string {
  return new URL(env().BASE_URL || "/", location.origin).href;
}
function signing(draft: IdentityConnectionDraft) {
  return draft.samlSigningPrivateKeyPkcs8
    ? {
        privateKeyPkcs8: draft.samlSigningPrivateKeyPkcs8,
        certificate: draft.samlSigningCertificate,
      }
    : undefined;
}
/** Bounded metadata through the same captured approved native HTTP transport as other providers. */
export async function loadConfiguredSamlMetadata(
  draft: IdentityConnectionDraft,
  owner: SamlPostOwner,
  originalTransport?: NativeProviderTransport,
): Promise<string> {
  assertSamlPostOwner(owner);
  if (draft.samlMetadataXml) {
    if (draft.samlMetadataUrl)
      throw new Error("Choose exactly one SAML metadata source");
    return draft.samlMetadataXml;
  }
  const endpoint = draft.samlMetadataUrl;
  if (!samlMetadataEndpoint(endpoint))
    throw new Error("Enter a secure SAML metadata URL or metadata XML");
  const transport = originalTransport;
  if (!transport)
    throw new Error("Original SAML metadata route is unavailable");
  const current = () => {
    assertSamlPostOwner(owner);
    transport.assertCurrent();
  };
  const signal = AbortSignal.any([
    owner.signal,
    AbortSignal.timeout(15000),
    ...(transport.signal ? [transport.signal] : []),
  ]);
  const response = await transport.fetch(endpoint, {
    method: "GET",
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      Accept: "application/samlmetadata+xml, application/xml, text/xml",
    },
  });
  return readMetadataResponse(response, signal, current);
}
async function readMetadataResponse(
  response: Response,
  signal: AbortSignal,
  current: () => void,
): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    current();
    signal.throwIfAborted();
    if (!response.ok || response.redirected || !reader)
      throw new Error("Configured SAML metadata was not returned");
    for (;;) {
      const part = await reader.read();
      current();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > SAML_POST_BYTES)
        throw new Error("SAML metadata exceeds the XML byte limit");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
/** Checks actual X509 metadata and optional SP signing crypto; it cannot authenticate an account. */
export async function testNativeSamlConfiguration(
  input: IdentityConnectionDraft,
  owner: SamlPostOwner,
  originalTransport?: NativeProviderTransport,
): Promise<IdentityConnectionTest> {
  const draft = Object.freeze({ ...input });
  const metadata = await readSamlIdpMetadata(
    await loadConfiguredSamlMetadata(draft, owner, originalTransport),
    draft.samlEntityId,
    owner,
  );
  assertSamlPostOwner(owner);
  if (metadata.signedRequests && !draft.samlSigningPrivateKeyPkcs8)
    throw new Error(
      "This IdP requires signed requests; configure the SP private key and certificate",
    );
  const now = Date.now();
  await createSamlAuthnPost(
    {
      requestId: `_${crypto.randomUUID()}`,
      issuer: draft.samlEntityId,
      audience: draft.clientId,
      acsUrl: new URL("auth/native-saml", scopeUrl()).href,
      issuedAt: now,
      expiresAt: now + 300000,
      nameIdFormat: draft.samlNameIdFormat,
      authnContext: draft.samlAuthnContext,
      forceAuthentication: draft.samlForceAuthentication === "true",
    },
    metadata,
    owner,
    signing(draft),
  );
  assertSamlPostOwner(owner);
  return {
    message:
      "SAML metadata and request configuration verified. Complete sign-in to verify your account.",
  };
}
function prepareAttempt(
  draft: IdentityConnectionDraft,
  owner: NativeIdentityOwner,
  originalPopup: Pick<NativeAuthPopup, "showFormConsent" | "cancel">,
  originalTransport?: NativeProviderTransport,
): NativeSamlSignIn {
  const popup = originalPopup;
  owner.prepareRuntime(() => {
    admission?.dispose();
    admission = createNativeSamlAdmissionRuntime();
  });
  return beginNativeSamlSignIn({
    scopeUrl: scopeUrl(),
    issuer: draft.samlEntityId,
    audience: draft.clientId,
    metadataXml: draft.samlMetadataXml,
    loadMetadataXml: draft.samlMetadataXml
      ? undefined
      : () =>
          loadConfiguredSamlMetadata(
            draft,
            {
              signal: owner.signal,
              assertCurrent: owner.assertPending,
            },
            originalTransport,
          ),
    reservedPopup: popup,
    nameIdFormat: draft.samlNameIdFormat,
    authnContext: draft.samlAuthnContext,
    forceAuthentication: draft.samlForceAuthentication === "true",
    timePolicy: TIME_POLICY,
    signing: signing(draft),
    owner: { signal: owner.signal, assertCurrent: owner.assertPending },
  });
}
/** The facade passes its original click-reserved window and owner; the live draft cannot choose the target. */
export async function signInConfiguredNativeSaml(
  connectionId: string,
  input: IdentityConnectionDraft,
  owner: NativeIdentityOwner,
  originalPopup: Pick<NativeAuthPopup, "showFormConsent" | "cancel">,
  retireProtocol?: () => Promise<void>,
  originalTransport?: NativeProviderTransport,
): Promise<void> {
  const draft = Object.freeze({ ...input });
  let active: NativeSamlSignIn | null = null;
  let runtime: NativeSamlAdmissionRuntime | null = null;
  let completed = false;
  let admissionStarted = false;
  const abort = () => {
    active?.cancel();
    if (admittedOwner === owner) {
      admittedOwner = null;
      runtime?.clear();
    }
  };
  const release = () => {
    owner.signal.removeEventListener("abort", abort);
    if (admittedOwner === owner) admittedOwner = null;
    owner.release();
  };
  try {
    owner.assertPending();
    active = prepareAttempt(draft, owner, originalPopup, originalTransport);
    runtime = admission;
    if (!runtime)
      throw new Error("Native SAML session runtime was not installed");
    owner.signal.addEventListener("abort", abort, { once: true });
    const proof = await active.result;
    owner.assertPending();
    admissionStarted = true;
    await runtime.admit(proof, {
      connectionId,
      label: draft.name,
      assertSessionCurrent: (claims) =>
        owner.assertSessionCurrent(claims.issuer, claims.audience),
      retireProtocol: async () => {
        owner.assertPending();
        await retireProtocol?.();
        owner.assertPending();
      },
      releaseSession: release,
    });
    owner.assertSessionCurrent(draft.samlEntityId, draft.clientId);
    admittedOwner = owner;
    completed = true;
  } finally {
    if (!completed) {
      release();
      active?.cancel();
      if (admissionStarted) runtime?.clear();
    }
  }
}
