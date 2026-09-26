/**
 * Removing an Identity-account factor is proved first (ADR 0146): the call
 * gathers a fresh proof — an assertion over a challenge minted for that one
 * removal, or the authenticator's current code — and sends it on the delete.
 * A refused proof is a 403, and a 403 never ends the session.
 */
import { InteractionStepUpError } from "@opensesame/ceremony-kit";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY,
  jsonResponse,
  stubBasic,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import {
  ACCOUNT_FACTOR_WORDS,
  type AccountFactorTransport,
  type AccountPasskeyAuthenticator,
  removeAccountFactor,
} from "./account-factors.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  clearSession,
  connectProvisional,
  currentSession,
} from "./identity.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { saveSettings } from "./settings.js";

const PK = `pk_${"c".repeat(32)}`;
const OPTIONS: JsonObject = { challenge: "cmVtb3Zl", rpId: "id.example" };
const ASSERTION = {
  credentialId: "cred-1",
  clientDataJSON: "AQ",
  authenticatorData: "Ag",
  signature: "Aw",
};

function json(status: number, body: BoundaryValue): Response {
  return jsonResponse(body, status);
}

type Call = { path: string; init: RequestInit };

function transport(answers: Response[]): AccountFactorTransport & {
  calls: Call[];
} {
  const calls: Call[] = [];
  const answer = async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const next = answers.shift();
    if (!next) throw new TypeError("offline");
    return next;
  };
  return { calls, signedIn: () => true, fetch: answer, anonymous: answer };
}

function authenticator(
  assert: AccountPasskeyAuthenticator["assert"] = async () => ASSERTION,
  available = true,
) {
  return {
    available: () => available,
    create: async () => ({}),
    assert: vi.fn(assert),
  };
}

function bodyOf(call: Call | undefined): BoundaryValue {
  return JSON.parse(String(call?.init.body));
}

describe("removeAccountFactor with a passkey", () => {
  it("asks for a challenge minted for this removal, then sends the assertion on the delete", async () => {
    const t = transport([
      json(200, { ok: true, challenge: "cmVtb3Zl", options: OPTIONS }),
      json(200, { ok: true, id: PK, kind: "passkey" }),
    ]);
    const key = authenticator();
    await removeAccountFactor(
      PK,
      { kind: "passkey" },
      {
        transport: t,
        authenticator: key,
      },
    );
    expect(t.calls.map((call) => [call.init.method, call.path])).toEqual([
      ["POST", "/v1/mfa/passkey/authentication-options"],
      ["DELETE", `/v1/mfa/factors/${PK}`],
    ]);
    expect(bodyOf(t.calls[0])).toEqual({
      purpose: "factor.remove",
      factorId: PK,
    });
    // The service's options reach the browser unaltered.
    expect(key.assert).toHaveBeenCalledWith(OPTIONS);
    expect(bodyOf(t.calls[1])).toEqual({
      proof: { kind: "passkey", ...ASSERTION },
    });
  });

  it("sends nothing to delete when the sheet is dismissed", async () => {
    const t = transport([
      json(200, { ok: true, challenge: "cmVtb3Zl", options: OPTIONS }),
    ]);
    const key = authenticator(async () => {
      throw new InteractionStepUpError("cancelled");
    });
    await expect(
      removeAccountFactor(
        PK,
        { kind: "passkey" },
        {
          transport: t,
          authenticator: key,
        },
      ),
    ).rejects.toThrow(ACCOUNT_FACTOR_WORDS.step_up_cancelled);
    expect(t.calls).toHaveLength(1);
  });

  it("says a browser without passkeys cannot prove it, before any call", async () => {
    const t = transport([]);
    await expect(
      removeAccountFactor(
        PK,
        { kind: "passkey" },
        {
          transport: t,
          authenticator: authenticator(undefined, false),
        },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(t.calls).toEqual([]);
  });

  it("reads an unreadable challenge as such, and a refused one as refused", async () => {
    await expect(
      removeAccountFactor(
        PK,
        { kind: "passkey" },
        {
          transport: transport([json(200, { ok: true })]),
          authenticator: authenticator(),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      removeAccountFactor(
        PK,
        { kind: "passkey" },
        {
          transport: transport([
            json(403, { ok: false, error: "step_up_failed" }),
          ]),
          authenticator: authenticator(),
        },
      ),
    ).rejects.toMatchObject({ code: "step_up_failed" });
  });
});

describe("removeAccountFactor with a code", () => {
  it("sends the six digits as the proof, and refuses fewer before a call", async () => {
    const t = transport([json(200, { ok: true })]);
    await removeAccountFactor(
      "totp",
      { kind: "totp", code: "123 456" },
      { transport: t, authenticator: authenticator() },
    );
    expect(bodyOf(t.calls[0])).toEqual({
      proof: { kind: "totp", code: "123456" },
    });
    const none = transport([]);
    await expect(
      removeAccountFactor(
        "totp",
        { kind: "totp", code: "12" },
        { transport: none, authenticator: authenticator() },
      ),
    ).rejects.toMatchObject({ code: "wrong_code" });
    expect(none.calls).toEqual([]);
  });

  it("tells a refused proof, a missing one and a fence apart", async () => {
    const answer = async (status: number, error: string) =>
      removeAccountFactor(
        PK,
        { kind: "totp", code: "123456" },
        {
          transport: transport([json(status, { ok: false, error })]),
          authenticator: authenticator(),
        },
      ).catch((caught: unknown) => caught);
    expect(await answer(403, "step_up_failed")).toMatchObject({
      code: "step_up_failed",
      message: ACCOUNT_FACTOR_WORDS.step_up_failed,
    });
    expect(await answer(403, "step_up_required")).toMatchObject({
      code: "step_up_required",
    });
    expect(await answer(429, "too_many_attempts")).toMatchObject({
      code: "too_many_attempts",
    });
  });
});

describe("a refused proof and the session", () => {
  const eligible = localNetworkFetchSeams.eligible;
  beforeEach(() => {
    localNetworkFetchSeams.eligible = loopbackProfileEligible;
    clearSession();
    saveSettings({
      hostApi: "",
      identityApi: IDENTITY,
      daemonApi: "",
      capabilityConnectors: defaultCapabilityConnectors(),
    });
  });
  afterEach(() => {
    localNetworkFetchSeams.eligible = eligible;
    clearSession();
    vi.unstubAllGlobals();
  });

  async function signedInRemoving(status: number, error: string) {
    stubBasic((url, init) =>
      url === `${IDENTITY}/v1/mfa/factors/${PK}` && init?.method === "DELETE"
        ? jsonResponse({ ok: false, error }, status)
        : undefined,
    );
    await connectProvisional();
    expect(currentSession()).not.toBeNull();
    return removeAccountFactor(PK, { kind: "totp", code: "000000" }).catch(
      (caught: unknown) => caught,
    );
  }

  it("keeps the person signed in when the service refuses the proof", async () => {
    expect(await signedInRemoving(403, "step_up_failed")).toMatchObject({
      code: "step_up_failed",
    });
    expect(currentSession()).not.toBeNull();
  });

  it("ends it only when the service refuses the session itself", async () => {
    expect(await signedInRemoving(401, "unauthorized")).toMatchObject({
      code: "signed_out",
    });
    expect(currentSession()).toBeNull();
  });
});
