/**
 * Boat configuration ceremony (auth.md): the claim a person completes
 * when they connect Boat in Settings › Integrations › Password reset.
 *
 * Boat allocates sandboxes only to a claimed account with billing, so
 * connecting Boat is a ceremony, not a key paste: register with the
 * person's email, show them Boat's verification link and 6-digit code,
 * poll until the claim completes, then surface Stripe checkout for the
 * trial/plan and read the resulting billing state. The connection
 * seals the identity assertion Boat returns (the rotating recovery
 * credential); access tokens are minted from it on demand and are
 * never stored or shown.
 *
 * Every call takes the caller's fetch — in Pages, the lease-fenced
 * native provider transport, because boat.dev does not answer CORS
 * for the vault origin. Errors carry no token material.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { Connection } from "./connections.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  listDeviceConnections,
  saveDeviceConnectorConfigurationDurable,
} from "./device-connectors.js";

export const BOAT_ORIGIN = "https://boat.dev";
export const BOAT_PROVIDER_ID = "boat";

export interface BoatClaimStart {
  claimToken: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type BoatClaimPoll =
  | { status: "pending" }
  | { status: "claimed"; accessToken: string; identityAssertion: string };

export interface BoatAccount {
  login: string;
  email: string;
  accessTier: string;
  /** Null when sandboxes may be created. */
  blockedReason: string | null;
}

type FetchImpl = typeof fetch;

function field(value: BoundaryValue, key: string): BoundaryValue {
  return isJsonObject(value) ? value[key] : undefined;
}

function stringField(value: BoundaryValue, key: string): string | null {
  const found = field(value, key);
  return isString(found) && found.length > 0 ? found : null;
}

function numberField(value: BoundaryValue, key: string): number | null {
  const found = field(value, key);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

async function readJson(response: Response): Promise<BoundaryValue> {
  try {
    return (await response.json()) as BoundaryValue;
  } catch {
    return undefined;
  }
}

function claimUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Boat returned an invalid claim link.");
  }
  if (
    url.protocol !== "https:" ||
    url.host !== "boat.dev" ||
    url.pathname !== "/api/boat/agent/identity/claim"
  )
    throw new Error("Boat returned an invalid claim link.");
  return url.href;
}

function claimFrom(
  claimToken: string,
  claim: BoundaryValue,
): BoatClaimStart | null {
  const userCode = stringField(claim, "user_code");
  const verificationUri = stringField(claim, "verification_uri");
  const expiresIn = numberField(claim, "expires_in");
  const interval = numberField(claim, "interval");
  if (!userCode || !verificationUri || expiresIn === null || interval === null)
    return null;
  return {
    claimToken,
    userCode,
    verificationUri: claimUrl(verificationUri),
    expiresInSeconds: expiresIn,
    intervalSeconds: Math.max(1, interval),
  };
}

async function postJson(
  fetchImpl: FetchImpl,
  path: string,
  body: Record<string, string>,
): Promise<BoundaryValue> {
  const response = await fetchImpl(`${BOAT_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  });
  const parsed = await readJson(response);
  if (!response.ok)
    throw new Error(`Boat refused the request (HTTP ${response.status}).`);
  return parsed;
}

/**
 * Register with the person's email (`service_auth`) and start the
 * claim. The person finishes at `verificationUri` with `userCode`.
 */
export async function startBoatClaim(
  fetchImpl: FetchImpl,
  email: string,
): Promise<BoatClaimStart> {
  const address = email.trim();
  if (!address.includes("@") || address.length > 254)
    throw new Error("Enter the email address for the Boat account.");
  const registration = await postJson(fetchImpl, "/api/boat/agent/identity", {
    type: "service_auth",
    login_hint: address,
  });
  const claimToken = stringField(registration, "claim_token");
  if (!claimToken) throw new Error("Boat registration returned no claim.");
  const immediate = field(registration, "claim");
  const start = immediate ? claimFrom(claimToken, immediate) : null;
  if (start) return start;
  const claimed = await postJson(
    fetchImpl,
    "/api/boat/agent/identity/claim",
    { claim_token: claimToken, email: address },
  );
  const token = stringField(claimed, "claim_token") ?? claimToken;
  const restarted = claimFrom(token, claimed);
  if (!restarted) throw new Error("Boat did not start the claim ceremony.");
  return restarted;
}

/** One claim-grant poll; `pending` while the person is still claiming. */
export async function pollBoatClaim(
  fetchImpl: FetchImpl,
  claimToken: string,
): Promise<BoatClaimPoll> {
  const form = new URLSearchParams({
    grant_type: "urn:workos:agent-auth:grant-type:claim",
    claim_token: claimToken,
  });
  const response = await fetchImpl(`${BOAT_ORIGIN}/api/boat/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "error",
  });
  const parsed = await readJson(response);
  const error = stringField(parsed, "error");
  if (error === "authorization_pending" || error === "slow_down")
    return { status: "pending" };
  const accessToken = stringField(parsed, "access_token");
  const identityAssertion = stringField(parsed, "identity_assertion");
  if (!response.ok || !accessToken)
    throw new Error(
      error === "invalid_grant"
        ? "That Boat claim code has expired. Start the claim again."
        : `Boat refused the claim (${error ?? `HTTP ${response.status}`}).`,
    );
  if (!identityAssertion)
    throw new Error("Boat's claim grant carried no recovery assertion.");
  return { status: "claimed", accessToken, identityAssertion };
}

async function getAuthed(
  fetchImpl: FetchImpl,
  path: string,
  accessToken: string,
): Promise<BoundaryValue> {
  const response = await fetchImpl(`${BOAT_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  const parsed = await readJson(response);
  if (!response.ok)
    throw new Error(`Boat refused the request (HTTP ${response.status}).`);
  return parsed;
}

/** Who the claimed account is, and whether sandboxes may be created. */
export async function readBoatAccount(
  fetchImpl: FetchImpl,
  accessToken: string,
): Promise<BoatAccount> {
  const me = await getAuthed(fetchImpl, "/api/v1/me", accessToken);
  const limits = await getAuthed(fetchImpl, "/api/v1/limits", accessToken);
  const user = field(me, "user");
  return {
    login: stringField(user, "login") ?? "",
    email: stringField(user, "email") ?? "",
    accessTier: stringField(limits, "accessTier") ?? "",
    blockedReason: stringField(limits, "blockedReason"),
  };
}

/** Mint the Stripe checkout link that starts the trial/plan. */
export async function createBoatCheckout(
  fetchImpl: FetchImpl,
  accessToken: string,
): Promise<string> {
  const response = await fetchImpl(`${BOAT_ORIGIN}/api/boat/billing/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ plan: "box_20" }),
    redirect: "error",
  });
  const parsed = await readJson(response);
  const raw = stringField(parsed, "url");
  if (!response.ok || !raw)
    throw new Error(`Boat refused checkout (HTTP ${response.status}).`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Boat returned an invalid checkout link.");
  }
  if (url.protocol !== "https:" || url.host !== "checkout.stripe.com")
    throw new Error("Boat returned an invalid checkout link.");
  return url.href;
}

/** Exchange the sealed identity assertion for a short-lived access token. */
export async function exchangeBoatAssertion(
  fetchImpl: FetchImpl,
  identityAssertion: string,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: identityAssertion,
    resource: `${BOAT_ORIGIN}/api/v1/`,
  });
  const response = await fetchImpl(`${BOAT_ORIGIN}/api/boat/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "error",
  });
  const parsed = await readJson(response);
  const accessToken = stringField(parsed, "access_token");
  if (!response.ok || !accessToken)
    throw new Error("Boat refused the saved identity. Claim Boat again.");
  return accessToken;
}

/** The sealed identity assertion for one saved Boat connection. */
export function readBoatAssertion(connectionId: string): string | null {
  const assertion = readDeviceSecrets()[connectionId]?.identity_assertion;
  return assertion && assertion.length > 0 ? assertion : null;
}

/** The saved Boat connection on this device, when the ceremony finished. */
export function savedBoatConnection(
  connectionId?: string,
): Connection | null {
  const rows = listDeviceConnections().filter(
    (row) => row.providerId === BOAT_PROVIDER_ID && row.status !== "revoked",
  );
  if (connectionId)
    return rows.find((row) => row.connectionId === connectionId) ?? null;
  return rows.at(-1) ?? null;
}

/** Seal the claimed identity as this device's Boat connection. */
export async function saveBoatConnection(input: {
  email: string;
  login: string;
  identityAssertion: string;
  existingId?: string;
}): Promise<Connection> {
  return saveDeviceConnectorConfigurationDurable(
    () => ({
      providerId: BOAT_PROVIDER_ID,
      displayName: input.login || input.email,
      scopes: [],
      fields: {
        account_email: input.email,
        account_login: input.login,
      },
      secrets: { identity_assertion: input.identityAssertion },
    }),
    input.existingId,
  );
}
