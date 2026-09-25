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
 * through the host's WebAuthn port. Every refusal becomes one sentence from
 * `ACCOUNT_FACTOR_WORDS`; a transport failure, a refused code and an
 * unreadable answer are told apart only where the person can act on it.
 *
 * Shown only where an Identity API is configured and a session is held
 * (`accountFactorsOffered`): with neither, the Security list draws no row and
 * says nothing (ADR 0090).
 */

import {
  type AccountFactor,
  type AccountFactorKind,
  type AccountFactorList,
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
import { credentials, publicKeyCredentialApi } from "../ports.js";
import {
  currentSession,
  identityFetch,
  isRemoteIdentityConfigured,
} from "./identity.js";

export type { AccountFactor, AccountFactorKind, AccountFactorList };

/** Every way a factor ceremony can end short, as the person is told it. */
export const ACCOUNT_FACTOR_WORDS = {
  signed_out: "Your session ended. Sign in again, then try once more.",
  unreachable: "Your sign-in service did not answer. Nothing changed.",
  invalid_response:
    "Your sign-in service answered with something this app cannot read. Nothing changed.",
  unavailable: "This browser cannot make a passkey.",
  cancelled: "No passkey was made. Nothing changed.",
  invalid_credential:
    "The passkey the browser made could not be read. Nothing was saved.",
  not_accepted:
    "Your sign-in service did not accept that passkey. Nothing was saved.",
  totp_unavailable: "Your sign-in service does not offer authenticator codes.",
  not_enrolled: "No authenticator setup is waiting. Start again.",
  wrong_code:
    "That code did not match. Wait for the next one, then enter it before it changes.",
  too_many_attempts:
    "Too many codes tried. Wait a few minutes, then start again.",
  rate_limited: "Too many tries. Wait a minute, then try again.",
  not_found: "That factor is already gone.",
  failed: "That did not work. Nothing changed.",
} as const;

export type AccountFactorRefusal = keyof typeof ACCOUNT_FACTOR_WORDS;

export class AccountFactorError extends Error {
  readonly code: AccountFactorRefusal;
  constructor(code: AccountFactorRefusal) {
    super(ACCOUNT_FACTOR_WORDS[code]);
    this.name = "AccountFactorError";
    this.code = code;
  }
}

/** The service's error codes, by what the person is told. */
const SERVICE_ERRORS: Readonly<Record<string, AccountFactorRefusal>> = {
  unauthorized: "signed_out",
  registration_verification_failed: "not_accepted",
  registration_attestation_required: "not_accepted",
  invalid_request: "not_accepted",
  totp_dev_only: "totp_unavailable",
  not_enrolled: "not_enrolled",
  too_many_attempts: "too_many_attempts",
  rate_limited: "rate_limited",
  not_found: "not_found",
};

export interface AccountFactorTransport {
  /** An Identity API call for the signed-in principal; `path` is base-relative. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** Whether a session is held to make it. */
  signedIn(): boolean;
}

export const identityAccountFactorTransport: AccountFactorTransport = {
  fetch: (path, init) => identityFetch(path, init),
  signedIn: () => currentSession() !== null,
};

export interface AccountPasskeyAuthenticator {
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

function refusalOf(status: number, body: BoundaryValue): AccountFactorError {
  const code =
    isJsonObject(body) && isString(body.error) ? body.error : undefined;
  if (code !== undefined && SERVICE_ERRORS[code]) {
    return new AccountFactorError(SERVICE_ERRORS[code]);
  }
  if (status === 401) return new AccountFactorError("signed_out");
  if (status === 429) return new AccountFactorError("rate_limited");
  return new AccountFactorError("failed");
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
 * browser's ceremony, the attestation back. Nothing is kept here.
 */
export async function enrollAccountPasskey(
  binding: AccountFactorBinding = PAGES_BINDING,
): Promise<void> {
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

/** Remove one of the account's factors by its handle. */
export async function removeAccountFactor(
  id: string,
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<void> {
  if (!isAccountFactorId(id)) throw new AccountFactorError("not_found");
  const { res, body } = await call(
    transport,
    `/v1/mfa/factors/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw refusalOf(res.status, body);
}

/**
 * Close an authenticator setup that never matched a code. The service wrote
 * the seed when it made it, so an abandoned setup is removed rather than left
 * as a factor nobody scanned; one already gone is not an error.
 */
export async function abandonAccountTotp(
  transport: AccountFactorTransport = identityAccountFactorTransport,
): Promise<void> {
  try {
    await removeAccountFactor(TOTP_FACTOR_ID, transport);
  } catch (error) {
    if (error instanceof AccountFactorError && error.code === "not_found") {
      return;
    }
    throw error;
  }
}
