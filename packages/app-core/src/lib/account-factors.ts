/**
 * The Identity account's own authenticators (ADR 0140 D10; plan step 11b):
 * list them, add a passkey or an authenticator app, remove one.
 *
 * These are the second steps the sign-in service asks of the person who is
 * signed in — "who is signed in" in ADR 0091's two ledgers — and never the
 * keys that open a vault on this device ("which key"). Nothing here reads,
 * writes or wraps a vault key, and nothing the service returns is kept beyond
 * the ceremony that asked for it: the TOTP setup link lives in the caller's
 * memory until a code matches or the sheet closes.
 *
 * The calls ride `identityFetch` (its bearer, base and timeouts). A passkey
 * is made over the service's own creation options, parsed and never altered,
 * through the host's WebAuthn port, and then tried once (plan step 11c): the
 * one assertion the Identity API accepts without a session, answered with no
 * bearer. A try that does not finish leaves the passkey registered and says
 * so, rather than calling it failed. Removing a factor is proved first (ADR
 * 0146): a passkey assertion over a challenge minted for that one removal,
 * or the authenticator's current code, sent on the delete itself. Every
 * refusal becomes one sentence from `ACCOUNT_FACTOR_WORDS`
 * (`./account-factor-words.ts`).
 *
 * Shown only where an Identity API is configured and a session is held
 * (`accountFactorsOffered`): with neither, the Security list draws no row and
 * says nothing (ADR 0090).
 */

import { InteractionStepUpError } from "@opensesame/ceremony-kit";
import {
  ACCOUNT_FACTOR_REMOVE_PURPOSE,
  type AccountFactor,
  type AccountFactorKind,
  type AccountFactorList,
  type AccountFactorProof,
  type AccountFactorStepUpRequest,
  type BoundaryValue,
  type JsonObject,
  TOTP_FACTOR_ID,
  isAccountFactorId,
  isJsonObject,
  isString,
  overlapCast,
  parseAccountFactorList,
} from "@opensesame/os-domain";
import {
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  registrationResponseJson,
} from "@opensesame/sdk-browser";
import { parseTotp, totpCode } from "@opensesame/vault-core";
import { credentials, publicKeyCredentialApi } from "../ports.js";
import { AccountFactorError, refusalOf } from "./account-factor-words.js";
import {
  type AccountPasskeyEnrolment,
  type PasskeyAsserter,
  tryAccountPasskey,
} from "./account-passkey-check.js";
import { identityPlaneRequest } from "./device-identity.js";
import {
  currentSession,
  identityFetch,
  isRemoteIdentityConfigured,
} from "./identity.js";
import { hostInteractionAuthenticator } from "./interactions.js";

export type { AccountFactor, AccountFactorKind, AccountFactorList };
export {
  ACCOUNT_PASSKEY_UNCHECKED_WORDS,
  type AccountPasskeyEnrolment,
  type PasskeyCheckMiss,
} from "./account-passkey-check.js";

export {
  ACCOUNT_FACTOR_WORDS,
  AccountFactorError,
  type AccountFactorRefusal,
} from "./account-factor-words.js";

export interface AccountFactorTransport {
  /** An Identity API call for the signed-in principal; `path` is base-relative. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The same plane with no session and no cookie: the passkey assertion. */
  anonymous(path: string, init: RequestInit): Promise<Response>;
  /** Whether a session is held to make it. */
  signedIn(): boolean;
}

export const identityAccountFactorTransport: AccountFactorTransport = {
  fetch: (path, init) => identityFetch(path, init),
  anonymous: (path, init) =>
    identityPlaneRequest(path, {
      ...init,
      headers: { "content-type": "application/json" },
      credentials: "omit",
    }),
  signedIn: () => currentSession() !== null,
};

export interface AccountPasskeyAuthenticator extends PasskeyAsserter {
  available(): boolean;
  /** Make a credential over the service's options; answer its JSON form. */
  create(options: BoundaryValue): Promise<JsonObject>;
}

/** The host's platform authenticator, over the service's options unaltered. */
export const hostAccountPasskeyAuthenticator: AccountPasskeyAuthenticator = {
  available: () =>
    publicKeyCredentialApi() !== undefined && credentials() !== undefined,
  async create(options) {
    const parsed = parsePublicKeyCredentialCreationOptionsJson(options);
    if (!parsed) throw new AccountFactorError("invalid_response");
    const container = credentials();
    if (!container) throw new AccountFactorError("unavailable");
    let created: Credential | null;
    try {
      created = await container.create(creationOptionsFromJson(parsed));
    } catch {
      // A dismissed sheet, a timeout and a refused origin are the same fact
      // here: there is no credential, and nothing is sent after this.
      throw new AccountFactorError("cancelled");
    }
    if (!created) throw new AccountFactorError("cancelled");
    if (!isPublicKeyCredential(created)) {
      throw new AccountFactorError("invalid_credential");
    }
    try {
      return overlapCast(registrationResponseJson(created));
    } catch {
      throw new AccountFactorError("invalid_credential");
    }
  },
  // The one WebAuthn assertion wrapper Pages has (`interactions.ts`).
  assert: (options) => hostInteractionAuthenticator.assert(options),
};

export interface AccountFactorBinding {
  transport: AccountFactorTransport;
  authenticator: AccountPasskeyAuthenticator;
}

const PAGES_BINDING: AccountFactorBinding = {
  transport: identityAccountFactorTransport,
  authenticator: hostAccountPasskeyAuthenticator,
};

/** Rows are drawn only with an Identity API configured and a session held. */
export function accountFactorsOffered(
  transport: AccountFactorTransport = identityAccountFactorTransport,
): boolean {
  return isRemoteIdentityConfigured() && transport.signedIn();
}

async function bodyOf(res: Response): Promise<BoundaryValue> {
  try {
    return overlapCast(await res.json());
  } catch {
    return null;
  }
}

async function call(
  transport: AccountFactorTransport,
  path: string,
  init: RequestInit,
): Promise<{ res: Response; body: BoundaryValue }> {
  if (!transport.signedIn()) throw new AccountFactorError("signed_out");
  let res: Response;
  try {
    res = await transport.fetch(path, init);
  } catch {
    throw new AccountFactorError("unreachable");
  }
  return { res, body: await bodyOf(res) };
}

/** `GET /v1/mfa/factors`: the account's factors and what may be added. */
export async function listAccountFactors(
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<AccountFactorList> {
  const { res, body } = await call(transport, "/v1/mfa/factors", {
    method: "GET",
  });
  if (!res.ok) throw refusalOf(res.status, body);
  const parsed = parseAccountFactorList(body);
  if (!parsed) throw new AccountFactorError("invalid_response");
  return parsed;
}

/**
 * Add a passkey to the account: the service's creation options, the
 * browser's ceremony, the attestation back — then one try of it
 * (`tryAccountPasskey`). Nothing is kept here, and nothing is rolled back.
 */
export async function enrollAccountPasskey(
  binding: AccountFactorBinding = PAGES_BINDING,
): Promise<AccountPasskeyEnrolment> {
  if (!binding.authenticator.available()) {
    throw new AccountFactorError("unavailable");
  }
  const options = await call(
    binding.transport,
    "/v1/mfa/passkey/registration-options",
    { method: "POST" },
  );
  if (!options.res.ok) throw refusalOf(options.res.status, options.body);
  if (!isJsonObject(options.body)) {
    throw new AccountFactorError("invalid_response");
  }
  const response = await binding.authenticator.create(options.body.options);
  const registered = await call(binding.transport, "/v1/mfa/passkey/register", {
    method: "POST",
    body: JSON.stringify({ response }),
  });
  if (!registered.res.ok) {
    throw refusalOf(registered.res.status, registered.body);
  }
  const miss = await tryAccountPasskey(binding);
  return miss === null
    ? { kind: "verified" }
    : { kind: "registered_unverified", reason: miss };
}

/**
 * Start an authenticator app: the service makes the seed and answers the
 * `otpauth:` link to scan. Only the link is returned; the caller holds it in
 * memory and drops it with the sheet.
 */
export async function beginAccountTotp(
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<string> {
  const { res, body } = await call(transport, "/v1/mfa/totp/enroll", {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) throw refusalOf(res.status, body);
  const link = isJsonObject(body) ? body.otpauthUrl : undefined;
  if (!isString(link) || !link.startsWith("otpauth://totp/")) {
    throw new AccountFactorError("invalid_response");
  }
  return link;
}

/** Confirm the scan with a code from the app. */
export async function confirmAccountTotp(
  code: string,
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<void> {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) throw new AccountFactorError("wrong_code");
  const { res, body } = await call(transport, "/v1/mfa/totp/verify", {
    method: "POST",
    body: JSON.stringify({ code: digits }),
  });
  if (res.ok) return;
  // A plain 401 with `ok: false` is a code that did not match; a 401 with
  // `unauthorized` is a session that ended.
  if (
    res.status === 401 &&
    isJsonObject(body) &&
    body.ok === false &&
    body.error === undefined
  ) {
    throw new AccountFactorError("wrong_code");
  }
  throw refusalOf(res.status, body);
}

/** How the person proves it is them before a factor goes (ADR 0146). */
export type AccountFactorStepUp =
  | { kind: "passkey" }
  | { kind: "totp"; code: string };

async function gatherRemovalProof(
  id: string,
  stepUp: AccountFactorStepUp,
  binding: AccountFactorBinding,
): Promise<AccountFactorProof> {
  if (stepUp.kind === "totp") {
    const code = stepUp.code.replace(/\D/g, "");
    if (code.length !== 6) throw new AccountFactorError("wrong_code");
    return { kind: "totp", code };
  }
  if (!binding.authenticator.available()) {
    throw new AccountFactorError("unavailable");
  }
  const request: AccountFactorStepUpRequest = {
    purpose: ACCOUNT_FACTOR_REMOVE_PURPOSE,
    factorId: id,
  };
  const minted = await call(
    binding.transport,
    "/v1/mfa/passkey/authentication-options",
    { method: "POST", body: JSON.stringify(request) },
  );
  if (!minted.res.ok) throw refusalOf(minted.res.status, minted.body);
  const options = isJsonObject(minted.body) ? minted.body.options : null;
  if (!isJsonObject(options)) throw new AccountFactorError("invalid_response");
  try {
    return {
      kind: "passkey",
      ...(await binding.authenticator.assert(options)),
    };
  } catch (error) {
    // A dismissed sheet and a timeout are one fact: there is no proof, and
    // nothing is sent after this.
    const dismissed =
      error instanceof InteractionStepUpError && error.reason === "cancelled";
    throw new AccountFactorError(dismissed ? "step_up_cancelled" : "failed");
  }
}

/**
 * Remove one of the account's factors by its handle, proved first (ADR
 * 0146): the service strips nothing on the strength of the session alone.
 * The proof is gathered here — an assertion over a challenge the service
 * minted for removing this one factor, or the authenticator's current code
 * — and sent on the delete itself. A refused proof answers 403, which the
 * session plane does not read as a dead session.
 */
export async function removeAccountFactor(
  id: string,
  stepUp: AccountFactorStepUp,
  binding: AccountFactorBinding = PAGES_BINDING,
): Promise<void> {
  if (!isAccountFactorId(id)) throw new AccountFactorError("not_found");
  const proof = await gatherRemovalProof(id, stepUp, binding);
  const { res, body } = await call(
    binding.transport,
    `/v1/mfa/factors/${encodeURIComponent(id)}`,
    { method: "DELETE", body: JSON.stringify({ proof }) },
  );
  if (!res.ok) throw refusalOf(res.status, body);
}

/**
 * Close an authenticator setup that never matched a code. The service wrote
 * the seed when it made it, so an abandoned setup is removed rather than left
 * as a factor nobody scanned; one already gone is not an error. The setup
 * link is still in memory, so the seed proves its own removal with the
 * code it computes now.
 */
export async function abandonAccountTotp(
  link: string,
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<void> {
  try {
    const code = await totpCode(parseTotp(link));
    await removeAccountFactor(
      TOTP_FACTOR_ID,
      { kind: "totp", code },
      { transport, authenticator: hostAccountPasskeyAuthenticator },
    );
  } catch (error) {
    if (error instanceof AccountFactorError && error.code === "not_found") {
      return;
    }
    throw error;
  }
}
