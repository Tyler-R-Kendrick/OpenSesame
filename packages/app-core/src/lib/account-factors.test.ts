/**
 * The Identity account's factors in Pages: which calls each step makes, what
 * reaches the caller, and the sentence every refusal becomes.
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
  ACCOUNT_FACTOR_WORDS,
  type AccountFactorTransport,
  abandonAccountTotp,
  accountFactorsOffered,
  beginAccountTotp,
  confirmAccountTotp,
  enrollAccountPasskey,
  hostAccountPasskeyAuthenticator,
  identityAccountFactorTransport,
  listAccountFactors,
  removeAccountFactor,
} from "./account-factors.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";

const PK = `pk_${"b".repeat(32)}`;

function json(status: number, body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { path: string; init: RequestInit };

function transport(
  answers: Response[],
  signedIn = true,
): AccountFactorTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    signedIn: () => signedIn,
    fetch: async (path, init) => {
      calls.push({ path, init });
      const next = answers.shift();
      if (!next) throw new TypeError("offline");
      return next;
    },
  };
}

const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
afterEach(() => {
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
  configureHost(createTestHost());
});

describe("when the rows are offered", () => {
  const SESSION = {
    principalId: "prn_1",
    accessToken: "at",
    issuerOrigin: "https://id.example",
  };

  it("needs a configured Identity API and a session", () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    identitySeams.currentSession = () => SESSION;
    expect(accountFactorsOffered()).toBe(false);

    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    identitySeams.currentSession = () => null;
    expect(accountFactorsOffered()).toBe(false);

    identitySeams.currentSession = () => SESSION;
    expect(accountFactorsOffered()).toBe(true);
  });

  it("rides identityFetch", async () => {
    identitySeams.currentSession = () => SESSION;
    const identityFetch = vi.fn(async () =>
      json(200, { ok: true, factors: [], enrollable: ["passkey"] }),
    );
    identitySeams.identityFetch = identityFetch;
    await expect(
      listAccountFactors(identityAccountFactorTransport),
    ).resolves.toEqual({ factors: [], enrollable: ["passkey"] });
    expect(identityFetch).toHaveBeenCalledWith("/v1/mfa/factors", {
      method: "GET",
    });
  });
});

describe("listAccountFactors", () => {
  it("returns only the parsed, display-safe list", async () => {
    const t = transport([
      json(200, {
        ok: true,
        factors: [
          { id: PK, kind: "passkey", publicKey: "AAAA" },
          { id: "totp", kind: "totp", secret: "x" },
        ],
        enrollable: ["passkey", "totp"],
      }),
    ]);
    const list = await listAccountFactors(t);
    expect(list.factors).toEqual([
      { id: PK, kind: "passkey" },
      { id: "totp", kind: "totp" },
    ]);
  });

  it("names each refusal in one sentence", async () => {
    await expect(listAccountFactors(transport([], false))).rejects.toThrow(
      ACCOUNT_FACTOR_WORDS.signed_out,
    );
    await expect(listAccountFactors(transport([]))).rejects.toThrow(
      ACCOUNT_FACTOR_WORDS.unreachable,
    );
    await expect(
      listAccountFactors(transport([json(401, { error: "unauthorized" })])),
    ).rejects.toMatchObject({ code: "signed_out" });
    await expect(
      listAccountFactors(transport([json(200, { factors: [{ id: "raw" }] })])),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      listAccountFactors(transport([new Response("<html>", { status: 502 })])),
    ).rejects.toMatchObject({ code: "failed" });
  });
});

/** An attestation as `sdk-browser` reads one: buffers, not base64. */
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

const OPTIONS: JsonObject = {
  rp: { name: "OpenSesame", id: "id.example" },
  user: { id: "dXNlcg", name: "prn_1", displayName: "prn_1" },
  challenge: "Y2hhbGxlbmdl",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

function withAuthenticator(port: AuthenticatorPort) {
  configureHost(createTestHost({ authenticator: port }));
}

function publicKeyCredentialApi(): typeof PublicKeyCredential {
  return overlapCast(function Pkc() {});
}

describe("enrollAccountPasskey", () => {
  it("runs the service's options unaltered and posts the attestation", async () => {
    const create = vi.fn(async (_options?: CredentialCreationOptions) =>
      attestation(),
    );
    withAuthenticator({
      credentials: { create, get: vi.fn() },
      publicKeyCredential: publicKeyCredentialApi(),
    });
    const t = transport([
      json(200, { ok: true, challenge: "Y2hhbGxlbmdl", options: OPTIONS }),
      json(200, { ok: true, credentialId: "cred-1" }),
    ]);
    await enrollAccountPasskey({
      transport: t,
      authenticator: hostAccountPasskeyAuthenticator,
    });

    expect(t.calls.map((call) => call.path)).toEqual([
      "/v1/mfa/passkey/registration-options",
      "/v1/mfa/passkey/register",
    ]);
    const publicKey = create.mock.calls[0]?.[0]?.publicKey;
    expect(publicKey?.rp).toEqual({ name: "OpenSesame", id: "id.example" });
    expect(new Uint8Array(overlapCast(publicKey?.challenge))).toEqual(
      new TextEncoder().encode("challenge"),
    );
    const sent = JSON.parse(String(t.calls[1]?.init.body));
    expect(sent).toEqual({
      response: {
        id: "cred-1",
        rawId: "AQ",
        type: "public-key",
        response: {
          clientDataJSON: "AQ",
          attestationObject: "Ag",
          transports: [],
        },
        clientExtensionResults: {},
      },
    });
  });

  it("stops before any call without an authenticator", async () => {
    withAuthenticator({});
    const t = transport([]);
    await expect(
      enrollAccountPasskey({
        transport: t,
        authenticator: hostAccountPasskeyAuthenticator,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(t.calls).toEqual([]);
  });

  it("sends nothing after a dismissed sheet", async () => {
    withAuthenticator({
      credentials: {
        create: vi.fn(async () => {
          throw new DOMException("no", "NotAllowedError");
        }),
        get: vi.fn(),
      },
      publicKeyCredential: publicKeyCredentialApi(),
    });
    const t = transport([json(200, { ok: true, options: OPTIONS })]);
    await expect(
      enrollAccountPasskey({
        transport: t,
        authenticator: hostAccountPasskeyAuthenticator,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(t.calls).toHaveLength(1);
  });

  it("refuses options that are not creation options, before the sheet", async () => {
    const create = vi.fn();
    withAuthenticator({
      credentials: { create, get: vi.fn() },
      publicKeyCredential: publicKeyCredentialApi(),
    });
    await expect(
      enrollAccountPasskey({
        transport: transport([json(200, { options: { challenge: "!" } })]),
        authenticator: hostAccountPasskeyAuthenticator,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(create).not.toHaveBeenCalled();
  });

  it("says a refused attestation was not saved", async () => {
    const authenticator = {
      available: () => true,
      create: async () => ({ id: "x" }),
    };
    await expect(
      enrollAccountPasskey({
        transport: transport([
          json(200, { options: OPTIONS }),
          json(401, { error: "registration_verification_failed" }),
        ]),
        authenticator,
      }),
    ).rejects.toThrow(ACCOUNT_FACTOR_WORDS.not_accepted);
  });
});

describe("authenticator app", () => {
  it("returns only the otpauth link, never the base64 seed", async () => {
    const t = transport([
      json(200, {
        ok: true,
        secret: "c2VlZA==",
        otpauthUrl: "otpauth://totp/OpenSesame:prn_1?secret=ONSWKZA&issuer=x",
      }),
    ]);
    await expect(beginAccountTotp(t)).resolves.toBe(
      "otpauth://totp/OpenSesame:prn_1?secret=ONSWKZA&issuer=x",
    );
    expect(t.calls[0]).toMatchObject({
      path: "/v1/mfa/totp/enroll",
      init: { method: "POST" },
    });
  });

  it("says where the service offers no authenticator codes", async () => {
    await expect(
      beginAccountTotp(transport([json(403, { error: "totp_dev_only" })])),
    ).rejects.toThrow(ACCOUNT_FACTOR_WORDS.totp_unavailable);
    await expect(
      beginAccountTotp(transport([json(200, { otpauthUrl: "https://x" })])),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("tells a wrong code from an ended session", async () => {
    const t = transport([json(200, { ok: true })]);
    await confirmAccountTotp("123 456", t);
    expect(JSON.parse(String(t.calls[0]?.init.body))).toEqual({
      code: "123456",
    });

    await expect(
      confirmAccountTotp("123456", transport([json(401, { ok: false })])),
    ).rejects.toMatchObject({ code: "wrong_code" });
    await expect(
      confirmAccountTotp(
        "123456",
        transport([json(401, { error: "unauthorized" })]),
      ),
    ).rejects.toMatchObject({ code: "signed_out" });
    await expect(
      confirmAccountTotp(
        "123456",
        transport([json(429, { ok: false, error: "too_many_attempts" })]),
      ),
    ).rejects.toMatchObject({ code: "too_many_attempts" });
    const none = transport([]);
    await expect(confirmAccountTotp("12", none)).rejects.toMatchObject({
      code: "wrong_code",
    });
    expect(none.calls).toEqual([]);
  });

  it("removes an abandoned setup, and one already gone is fine", async () => {
    const t = transport([json(200, { ok: true })]);
    await abandonAccountTotp(t);
    expect(t.calls[0]).toMatchObject({
      path: "/v1/mfa/factors/totp",
      init: { method: "DELETE" },
    });
    await expect(
      abandonAccountTotp(transport([json(404, { error: "not_found" })])),
    ).resolves.toBeUndefined();
  });
});

describe("removeAccountFactor", () => {
  it("deletes by handle, and refuses anything else before a call", async () => {
    const t = transport([json(200, { ok: true })]);
    await removeAccountFactor(PK, t);
    expect(t.calls[0]?.path).toBe(`/v1/mfa/factors/${PK}`);

    const none = transport([]);
    await expect(
      removeAccountFactor("../principals", none),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(none.calls).toEqual([]);

    await expect(
      removeAccountFactor(PK, transport([json(404, { error: "not_found" })])),
    ).rejects.toThrow(ACCOUNT_FACTOR_WORDS.not_found);
  });
});
