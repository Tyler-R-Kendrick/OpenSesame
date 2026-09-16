/**
 * Browser-native SIOPv2 authority — bind a Self-Issued request to a local
 * application, gate on passkey identity, mint a fragment redirect.
 */

import { isString } from "@opensesame/os-domain";
import {
  type NormalizedAuthorizationRequest,
  type SiopIssuerProfile,
  attachFragment,
  buildSelfIssuedIdToken,
  parseAuthorizationRequest,
  serializeFragmentError,
  serializeFragmentSuccess,
} from "@opensesame/siop-v2";
import {
  type LocalApplication,
  readLocalApplications,
  requireLocalApplicationAdmission,
} from "./local-applications.js";
import { LocalDirectoryError } from "./local-directory.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";
import {
  type SiopPublicIdentity,
  ensureSiopKeyInDirectoryFence,
  importSiopSigningKey,
} from "./siop-keys.js";

export type SiopBoundRequest = {
  request: NormalizedAuthorizationRequest;
  application: LocalApplication;
};

export type SiopAuthoritySeams = {
  ensureKey?: typeof ensureSiopKeyInDirectoryFence;
  importSigner?: typeof importSiopSigningKey;
  requireAdmission?: typeof requireLocalApplicationAdmission;
  buildToken?: typeof buildSelfIssuedIdToken;
  nowSeconds?: () => number;
};

function refused(
  message = "This Self-Issued sign-in is unavailable. Start again from the application.",
): never {
  throw new LocalDirectoryError(message);
}

/** Dynamic Self-Issued issuer on this Pages origin (`…/identity/siop`). */
export function dynamicSiopIssuer(
  origin = globalThis.location?.origin ?? "",
  base = import.meta.env.BASE_URL || "/",
): string {
  if (!isString(origin) || origin.length === 0)
    refused("Pages origin is unavailable.");
  try {
    return new URL("identity/siop", new URL(base, origin)).href.replace(
      /\/$/,
      "",
    );
  } catch {
    refused("Pages origin is unavailable.");
  }
}

export function siopIssuerProfile(issuer = dynamicSiopIssuer()) {
  const profile = { kind: "dynamic", issuer } satisfies Extract<
    SiopIssuerProfile,
    { kind: "dynamic" }
  >;
  return profile;
}

export function parsePagesSiopRequest(
  raw: string,
): NormalizedAuthorizationRequest {
  return parseAuthorizationRequest(raw);
}

/** Exact redirect + client_id = local applicationId. */
export async function bindSiopRequest(
  tomb: string,
  request: NormalizedAuthorizationRequest,
): Promise<SiopBoundRequest> {
  const registrations = await readLocalApplications(tomb);
  const application = registrations.applications.find(
    (row) =>
      row.applicationId === request.clientId &&
      row.redirectUris.includes(request.redirectUri),
  );
  if (!application) refused();
  if (!application.scopes.includes("openid")) refused();
  return { request, application };
}

export async function inspectSiopConsent(
  tomb: string,
  raw: string,
): Promise<SiopBoundRequest> {
  return bindSiopRequest(tomb, parsePagesSiopRequest(raw));
}

function assertPasskey(session: LocalSession): void {
  if (session.authentication !== "passkey") refused();
}

/**
 * Final admission + pairwise key mint. Returns the fragment redirect URL.
 * Passkey session required (`signInLocalIdentity` at the consent gate).
 */
export async function approveSiopAuthorization(
  tomb: string,
  session: LocalSession,
  request: NormalizedAuthorizationRequest,
  seams: SiopAuthoritySeams = {},
): Promise<{ redirectUrl: string; identity: SiopPublicIdentity }> {
  assertPasskey(session);
  const ensureKey = seams.ensureKey ?? ensureSiopKeyInDirectoryFence;
  const importSigner = seams.importSigner ?? importSiopSigningKey;
  const requireAdmission =
    seams.requireAdmission ?? requireLocalApplicationAdmission;
  const buildToken = seams.buildToken ?? buildSelfIssuedIdToken;
  const nowSeconds = seams.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const profile = siopIssuerProfile();

  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const scopes = ["openid"];
      await requireAdmission(
        tomb,
        identity.principalId,
        request.clientId,
        request.redirectUri,
        scopes,
      );
      assertActive();
      const publicIdentity = await ensureKey(
        tomb,
        identity.principalId,
        request.clientId,
      );
      assertActive();
      const signer = await importSigner(
        tomb,
        identity.principalId,
        request.clientId,
      );
      assertActive();
      // Revalidate registration + membership immediately before mint.
      await requireAdmission(
        tomb,
        identity.principalId,
        request.clientId,
        request.redirectUri,
        scopes,
      );
      assertActive();
      if (
        publicIdentity.subjectId !== identity.principalId ||
        publicIdentity.applicationId !== request.clientId
      )
        refused();
      const idToken = await buildToken({
        profile,
        audience: request.clientId,
        nonce: request.nonce,
        publicJwk: publicIdentity.publicJwk,
        signingKey: signer,
        nowSeconds: nowSeconds(),
      });
      assertActive();
      const fragment = serializeFragmentSuccess({
        idToken,
        state: request.state,
      });
      return {
        redirectUrl: attachFragment(request.redirectUri, fragment),
        identity: publicIdentity,
      };
    },
  );
}

export function denySiopAuthorization(
  request: NormalizedAuthorizationRequest,
): string {
  return attachFragment(
    request.redirectUri,
    serializeFragmentError({
      error: "access_denied",
      errorDescription: "The end-user denied the request",
      state: request.state,
    }),
  );
}
