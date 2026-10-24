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
import { env } from "../host.js";
import { maybePage } from "../ports.js";
import { getConnection } from "./connections.js";
import { recordReceipt } from "./device-receipts.js";
import { loadSession } from "./federation.js";
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

/** A social sign-in that stands in for the local passkey at SIOP consent. */
export type SiopSocialProof = Readonly<{
  source: "identity" | "connection";
  providerId: string;
  label: string;
  personId: string;
  at: number;
  /** The trusted upstream that completed, for an identity provider. */
  upstreamId?: string;
  /** The configured connection that is active, for a connection provider. */
  connectionId?: string;
}>;

const SOCIAL_PROOF_LIFETIME_MS = 10 * 60_000;

async function assertSocialActor(tomb: string, principalId: string) {
  const { currentLocalIdentityActor } = await import("./local-sessions.js");
  const actor = await currentLocalIdentityActor(tomb);
  // The social leg proves the upstream account, never which local person the
  // caller selected. The person must also hold the live local session this tab
  // is acting under; a custodian role is not a substitute for that person.
  if (!actor || actor.principalId !== principalId) refused();
}

async function assertSocialProof(
  tomb: string,
  proof: SiopSocialProof,
  principalId: string,
  seams: SiopAuthoritySeams,
): Promise<void> {
  if (proof.personId !== principalId) refused();
  await assertSocialActor(tomb, principalId);
  if (
    !Number.isFinite(proof.at) ||
    proof.at > Date.now() ||
    Date.now() - proof.at > SOCIAL_PROOF_LIFETIME_MS
  )
    refused();
  if (proof.source === "identity") {
    const session = (seams.socialSession ?? loadSession)();
    if (
      !session ||
      session.upstreamId !== proof.upstreamId ||
      session.expiresAt <= Date.now()
    )
      refused();
    return;
  }
  if (!proof.connectionId) refused();
  const connection = await (seams.socialConnection ?? getConnection)(
    proof.connectionId,
  );
  if (
    !connection ||
    connection.status !== "active" ||
    connection.providerId !== proof.providerId
  )
    refused();
}

export type SiopAuthoritySeams = {
  ensureKey?: typeof ensureSiopKeyInDirectoryFence;
  importSigner?: typeof importSiopSigningKey;
  requireAdmission?: typeof requireLocalApplicationAdmission;
  buildToken?: typeof buildSelfIssuedIdToken;
  nowSeconds?: () => number;
  /** Test and host seams for the social proof checks. */
  socialSession?: () => { upstreamId: string; expiresAt: number } | null;
  socialConnection?: (id: string) => Promise<{
    providerId: string;
    status: string;
  } | null>;
};

function refused(
  message = "This Self-Issued sign-in is unavailable. Start again from the application.",
): never {
  throw new LocalDirectoryError(message);
}

/** Dynamic Self-Issued issuer on this Pages origin (`…/identity/siop`). */
export function dynamicSiopIssuer(
  origin = maybePage()?.location.origin ?? "",
  base = env().BASE_URL || "/",
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

function assertPasskey(session: LocalSession): void {
  if (session.authentication !== "passkey") refused();
}

/**
 * Final admission + pairwise key mint. The caller supplies the proof that the
 * human is present: a passkey session, or a social sign-in checked by
 * `assertSocialProof`.
 */
async function mintSiopAuthorization(
  tomb: string,
  principalId: string,
  request: NormalizedAuthorizationRequest,
  assertActive: () => void | Promise<void>,
  seams: SiopAuthoritySeams,
): Promise<{ redirectUrl: string; identity: SiopPublicIdentity }> {
  const ensureKey = seams.ensureKey ?? ensureSiopKeyInDirectoryFence;
  const importSigner = seams.importSigner ?? importSiopSigningKey;
  const requireAdmission =
    seams.requireAdmission ?? requireLocalApplicationAdmission;
  const buildToken = seams.buildToken ?? buildSelfIssuedIdToken;
  const nowSeconds = seams.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const profile = siopIssuerProfile();
  const scopes = ["openid"];
  await requireAdmission(
    tomb,
    principalId,
    request.clientId,
    request.redirectUri,
    scopes,
  );
  await assertActive();
  const publicIdentity = await ensureKey(tomb, principalId, request.clientId);
  await assertActive();
  const signer = await importSigner(tomb, principalId, request.clientId);
  await assertActive();
  // Revalidate registration + membership immediately before mint.
  await requireAdmission(
    tomb,
    principalId,
    request.clientId,
    request.redirectUri,
    scopes,
  );
  await assertActive();
  if (
    publicIdentity.subjectId !== principalId ||
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
  await assertActive();
  const fragment = serializeFragmentSuccess({
    idToken,
    state: request.state,
  });
  return {
    redirectUrl: attachFragment(request.redirectUri, fragment),
    identity: publicIdentity,
  };
}

/** Passkey session required (`signInLocalIdentity` at the consent gate). */
export async function approveSiopAuthorization(
  tomb: string,
  session: LocalSession,
  request: NormalizedAuthorizationRequest,
  seams: SiopAuthoritySeams = {},
): Promise<{ redirectUrl: string; identity: SiopPublicIdentity }> {
  assertPasskey(session);
  const approved = await withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) =>
      mintSiopAuthorization(
        tomb,
        identity.principalId,
        request,
        assertActive,
        seams,
      ),
  );
  await recordReceipt(tomb, "siop.approved", {
    applicationId: request.clientId,
    subject: approved.identity.subjectId,
  });
  return approved;
}

/**
 * A social sign-in that stands in for the passkey at consent. The proof is
 * checked against the live upstream session or an active connection, and the
 * local application admission is still checked before any token is minted.
 */
export async function approveSiopAuthorizationWithSocial(
  tomb: string,
  proof: SiopSocialProof,
  request: NormalizedAuthorizationRequest,
  seams: SiopAuthoritySeams = {},
): Promise<{ redirectUrl: string; identity: SiopPublicIdentity }> {
  const assertActive = () =>
    assertSocialProof(tomb, proof, proof.personId, seams);
  await assertActive();
  const approved = await mintSiopAuthorization(
    tomb,
    proof.personId,
    request,
    assertActive,
    seams,
  );
  await recordReceipt(tomb, "siop.approved", {
    applicationId: request.clientId,
    subject: approved.identity.subjectId,
  });
  return approved;
}

/** Say in the receipts that the person refused, before the page leaves. */
export function recordSiopDenial(
  tomb: string,
  request: NormalizedAuthorizationRequest,
): Promise<void> {
  return recordReceipt(tomb, "siop.denied", {
    applicationId: request.clientId,
  });
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
