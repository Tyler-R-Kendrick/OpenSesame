/**
 * The Pages binding of the interaction approval: which transport each call
 * rides, and the host authenticator's shaping of the WebAuthn request and
 * answer. The protocol itself is ceremony-kit's and tested there
 * (`interaction-approval.test.ts`).
 */
import { InteractionStepUpError } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { AuthenticatorPort } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import {
  hostInteractionAuthenticator,
  identityInteractionTransport,
  interactionApproval,
} from "./interactions.js";

const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
const DIGEST = "sha256:8f14e45fceea167a5a36dedd4bea2543";

function json(status: number, body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SUMMARY = {
  kind: "device_authorization",
  status: "pending",
  expiresAt: "2026-09-01T00:00:00.000Z",
  requiresApprover: true,
};
const DETAIL = {
  ...SUMMARY,
  id: "int_1",
  createdAt: "2026-08-31T23:55:00.000Z",
  requestDigest: DIGEST,
  authorizationDetails: [],
};

const SESSION = {
  principalId: "prn_1",
  accessToken: "at_secret",
  issuerOrigin: "https://id.example",
};

const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
afterEach(() => {
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

function withAuthenticator(port: AuthenticatorPort) {
  configureHost(createTestHost({ authenticator: port }));
}

/** An assertion as `sdk-browser` reads one: buffers, not base64. */
function credential(over: JsonObject = {}): Credential {
  const value = {
    id: "cred-1",
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
    },
    getClientExtensionResults: () => ({}),
    ...over,
  };
  const answer: Credential = overlapCast(value);
  return answer;
}

describe("identity transport", () => {
  it("resolves with no session and no cookie, and answers with the session", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    identitySeams.currentSession = () => SESSION;
    const anonymous = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(200, SUMMARY),
    );
    vi.stubGlobal("fetch", anonymous);
    const identityFetch = vi.fn(async () => json(200, DETAIL));
    identitySeams.identityFetch = identityFetch;

    const step = await interactionApproval(REF, {
      transport: identityInteractionTransport,
      authenticator: { available: () => false, assert: vi.fn() },
    }).load();

    const [url, init] = anonymous.mock.calls[0] ?? [];
    expect(url).toBe(`https://id.example/i/${REF}`);
    expect(init).toMatchObject({ method: "GET", credentials: "omit" });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(anonymous.mock.calls)).not.toContain("at_secret");
    // The approver's view: through `identityFetch`, which carries the
    // session itself, at a base-relative path.
    expect(identityFetch).toHaveBeenCalledWith(
      `/v1/interactions/${REF}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(step?.phase.kind).toBe("review");
  });

  it("asks for a sign-in when there is no Identity session", async () => {
    identitySeams.currentSession = () => null;
    expect(identityInteractionTransport.signedIn()).toBe(false);
    vi.stubGlobal("fetch", async () => json(200, SUMMARY));
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    const identityFetch = vi.fn();
    identitySeams.identityFetch = identityFetch;
    const step = await interactionApproval(REF).load();
    expect(step?.phase.kind).toBe("signin");
    expect(identityFetch).not.toHaveBeenCalled();
  });
});

describe("host authenticator", () => {
  it("is unavailable without a credentials container", () => {
    withAuthenticator({});
    expect(hostInteractionAuthenticator.available()).toBe(false);
  });

  it("runs the authority's options unaltered and returns the raw assertion", async () => {
    const get = vi.fn(async (_request?: CredentialRequestOptions) =>
      credential(),
    );
    withAuthenticator({
      credentials: { get, create: vi.fn() },
      publicKeyCredential: overlapPublicKeyCredential(),
    });
    expect(hostInteractionAuthenticator.available()).toBe(true);
    const assertion = await hostInteractionAuthenticator.assert({
      challenge: "aGk",
      rpId: "id.example",
      userVerification: "required",
    });
    expect(assertion).toEqual({
      credentialId: "cred-1",
      clientDataJSON: "AQ",
      authenticatorData: "Ag",
      signature: "Aw",
    });
    const [request] = get.mock.calls[0] ?? [];
    expect(request?.publicKey?.rpId).toBe("id.example");
    expect(request?.publicKey?.userVerification).toBe("required");
    // The challenge the authority bound, decoded from base64url and nothing
    // else: "aGk" is the bytes of "hi".
    expect(request?.publicKey?.challenge).toEqual(new Uint8Array([104, 105]));
  });

  const failures: ReadonlyArray<[string, () => Promise<Credential | null>]> = [
    ["cancelled", async () => null],
    [
      "cancelled",
      async () => {
        throw new DOMException("dismissed", "NotAllowedError");
      },
    ],
    ["invalid_credential", async () => credential({ type: "password" })],
    ["invalid_credential", async () => credential({ response: {} })],
  ];
  for (const [reason, answer] of failures) {
    it(`reports ${reason} and never an assertion`, async () => {
      withAuthenticator({ credentials: { get: answer, create: vi.fn() } });
      const failed = hostInteractionAuthenticator.assert({ challenge: "aGk" });
      await expect(failed).rejects.toBeInstanceOf(InteractionStepUpError);
      await expect(failed).rejects.toMatchObject({ reason });
    });
  }

  it("refuses options that are not WebAuthn request options, before the sheet", async () => {
    const get = vi.fn();
    withAuthenticator({ credentials: { get, create: vi.fn() } });
    await expect(
      hostInteractionAuthenticator.assert({ challenge: "not base64!" }),
    ).rejects.toMatchObject({ reason: "invalid_options" });
    expect(get).not.toHaveBeenCalled();
  });
});

/** Any constructor stands in for the interface: availability only. */
function overlapPublicKeyCredential(): typeof PublicKeyCredential {
  const api: typeof PublicKeyCredential = overlapCast(function Pkc() {});
  return api;
}
