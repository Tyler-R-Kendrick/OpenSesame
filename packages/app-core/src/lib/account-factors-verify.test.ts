/**
 * A passkey added to the Identity account is tried once before the sheet
 * says it works (ADR 0140 plan step 11c, carried over from mobile-MFA's
 * register-then-assert). The registration is never rolled back: a check
 * that did not finish is a working credential this browser could not
 * exercise, and saying "failed" would send the person to add a second one.
 */
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { AuthenticatorPort } from "../ports.js";
import { createTestHost } from "../test-host.js";
import {
  ACCOUNT_PASSKEY_UNCHECKED_WORDS,
  type AccountFactorTransport,
  enrollAccountPasskey,
  hostAccountPasskeyAuthenticator,
} from "./account-factors.js";

function json(status: number, body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { plane: "session" | "anonymous"; path: string; init: RequestInit };

/** Answers in order across both planes; an exhausted list is offline. */
function transport(
  answers: Response[],
): AccountFactorTransport & { calls: Call[] } {
  const calls: Call[] = [];
  const answer = async (call: Call) => {
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new TypeError("offline");
    return next;
  };
  return {
    calls,
    signedIn: () => true,
    fetch: (path, init) => answer({ plane: "session", path, init }),
    anonymous: (path, init) => answer({ plane: "anonymous", path, init }),
  };
}

const CREATION: JsonObject = {
  rp: { name: "OpenSesame", id: "id.example" },
  user: { id: "dXNlcg", name: "prn_1", displayName: "prn_1" },
  challenge: "Y2hhbGxlbmdl",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

const REQUEST: JsonObject = {
  challenge: "YXNzZXJ0",
  allowCredentials: [{ id: "AQ", type: "public-key" }],
};

function attestation(): Credential {
  return overlapCast({
    id: "cred-1",
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
    },
    getClientExtensionResults: () => ({}),
  });
}

function assertion(): Credential {
  return overlapCast({
    id: "cred-1",
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response: {
      clientDataJSON: new Uint8Array([3]).buffer,
      authenticatorData: new Uint8Array([4]).buffer,
      signature: new Uint8Array([5]).buffer,
    },
    getClientExtensionResults: () => ({}),
  });
}

function withAuthenticator(
  get: (options?: CredentialRequestOptions) => Promise<Credential | null>,
) {
  const sheet = vi.fn(get);
  const port: AuthenticatorPort = {
    credentials: { create: vi.fn(async () => attestation()), get: sheet },
    publicKeyCredential: overlapCast(function Pkc() {}),
  };
  configureHost(createTestHost({ authenticator: port }));
  return { get: sheet };
}

/** Registration options, then the register call, both accepted. */
function registered(): Response[] {
  return [
    json(200, { ok: true, options: CREATION }),
    json(200, { ok: true, credentialId: "cred-1", principalId: "prn_1" }),
  ];
}

function enroll(t: AccountFactorTransport) {
  return enrollAccountPasskey({
    transport: t,
    authenticator: hostAccountPasskeyAuthenticator,
  });
}

afterEach(() => {
  configureHost(createTestHost());
});

describe("a passkey added to the account is tried once", () => {
  it("registers, then asserts it over the service's request options", async () => {
    const port = withAuthenticator(async () => assertion());
    const t = transport([
      ...registered(),
      json(200, { ok: true, challenge: "YXNzZXJ0", options: REQUEST }),
      json(200, { ok: true, principalId: "prn_1" }),
    ]);
    await expect(enroll(t)).resolves.toEqual({ kind: "verified" });

    expect(t.calls.map((call) => `${call.plane} ${call.path}`)).toEqual([
      "session /v1/mfa/passkey/registration-options",
      "session /v1/mfa/passkey/register",
      "session /v1/mfa/passkey/authentication-options",
      // No bearer: the assert route is anonymous, and a refused assertion
      // answers 401, which on the session plane would end the session.
      "anonymous /v1/mfa/passkey/assert",
    ]);
    const asked = port.get.mock.calls[0]?.[0];
    expect(new Uint8Array(overlapCast(asked?.publicKey?.challenge))).toEqual(
      new TextEncoder().encode("assert"),
    );
    expect(JSON.parse(String(t.calls[3]?.init.body))).toEqual({
      credentialId: "cred-1",
      clientDataJSON: "Aw",
      authenticatorData: "BA",
      signature: "BQ",
    });
  });

  it("keeps the registration when the check cannot start", async () => {
    const port = withAuthenticator(async () => assertion());
    const t = transport([...registered(), json(500, {})]);
    await expect(enroll(t)).resolves.toEqual({
      kind: "registered_unverified",
      reason: "assert_failed",
    });
    expect(port.get).not.toHaveBeenCalled();
    // Never rolled back: nothing after the options call.
    expect(t.calls.map((call) => call.path)).toEqual([
      "/v1/mfa/passkey/registration-options",
      "/v1/mfa/passkey/register",
      "/v1/mfa/passkey/authentication-options",
    ]);
  });

  it("keeps the registration when the assertion is cancelled", async () => {
    withAuthenticator(async () => {
      throw new DOMException("no", "NotAllowedError");
    });
    const t = transport([
      ...registered(),
      json(200, { ok: true, options: REQUEST }),
    ]);
    await expect(enroll(t)).resolves.toEqual({
      kind: "registered_unverified",
      reason: "cancelled",
    });
    expect(t.calls).toHaveLength(3);

    withAuthenticator(async () => null);
    const again = transport([
      ...registered(),
      json(200, { ok: true, options: REQUEST }),
    ]);
    await expect(enroll(again)).resolves.toMatchObject({
      reason: "cancelled",
    });
  });

  it("keeps the registration when the final assert call is refused or fails", async () => {
    withAuthenticator(async () => assertion());
    const refused = transport([
      ...registered(),
      json(200, { ok: true, options: REQUEST }),
      json(401, { ok: false }),
    ]);
    await expect(enroll(refused)).resolves.toEqual({
      kind: "registered_unverified",
      reason: "assert_refused",
    });
    expect(refused.calls.map((call) => call.path)).not.toContain(
      "/v1/mfa/factors",
    );

    const unreachable = transport([
      ...registered(),
      json(200, { ok: true, options: REQUEST }),
    ]);
    await expect(enroll(unreachable)).resolves.toMatchObject({
      reason: "assert_failed",
    });

    const limited = transport([
      ...registered(),
      json(200, { ok: true, options: REQUEST }),
      json(429, { ok: false, error: "rate_limited" }),
    ]);
    await expect(enroll(limited)).resolves.toMatchObject({
      reason: "assert_failed",
    });
  });

  it("words every miss so nobody adds a second passkey", () => {
    for (const words of Object.values(ACCOUNT_PASSKEY_UNCHECKED_WORDS)) {
      expect(words).toMatch(/^Passkey added to your account/);
      expect(words).toMatch(/another/);
    }
  });
});
