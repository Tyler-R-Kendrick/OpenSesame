import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "../../crypto.js";
import {
  type PasskeyUnlockRecord,
  PrfCeremonyError,
  assertUsablePrfOutput,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremonyFor,
  hasUsablePrfOutput,
  listPasskeyUnlockRecords,
  normalizePasskeyUnlocks,
  withPasskeyUnlock,
  wrapVaultKeyWithPrf,
} from "../../unlock-methods.js";
import { protectorFromPrfMaterial } from "./webauthn-prf-ops.js";
import { webauthnPrfCapabilities } from "./webauthn-prf.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const wrapStub = { ivB64: "YQ==", ctB64: "YQ==" };

function record(id: string, salt = "YQ=="): PasskeyUnlockRecord {
  return {
    credentialIdB64: id,
    userIdB64: "dXNlcg==",
    prfSaltB64: salt,
    wrap: wrapStub,
  };
}

describe("multi-cred passkey unlock records", () => {
  it("migrates a legacy single passkey into a one-element list", () => {
    const legacy = record("YQ==");
    expect(listPasskeyUnlockRecords({ passkey: legacy })).toEqual([legacy]);
    expect(normalizePasskeyUnlocks({ passkey: legacy }).passkeys).toEqual([
      legacy,
    ]);
  });

  it("merges enroll without dropping an existing wrap (KP-23)", () => {
    const first = record("YQ==");
    const second = record("Yg==");
    const merged = withPasskeyUnlock({ passkey: first }, second);
    expect(
      listPasskeyUnlockRecords(merged).map((row) => row.credentialIdB64),
    ).toEqual(["YQ==", "Yg=="]);
    expect(merged.passkey?.credentialIdB64).toBe("YQ==");
  });
});

describe("KP-22 usable PRF output", () => {
  it("treats enabled-without-results as non-KEK", () => {
    expect(hasUsablePrfOutput(overlapCast({ prf: { enabled: true } }))).toBe(
      false,
    );
    expect(() => assertUsablePrfOutput(new ArrayBuffer(0))).toThrow(
      PrfCeremonyError,
    );
    expect(() => assertUsablePrfOutput(new ArrayBuffer(16))).toThrow(
      /at least 32 bytes/,
    );
  });

  it("refuses to wrap with a short PRF buffer", async () => {
    await expect(
      wrapVaultKeyWithPrf(
        randomBytes(32),
        new ArrayBuffer(8),
        randomBytes(16),
        randomBytes(16).buffer,
        randomBytes(16).buffer,
      ),
    ).rejects.toMatchObject({ code: "prf_output_too_short" });
  });
});

describe("PRF ceremony cancel and multi-cred selection", () => {
  type CeremonyResponse = {
    clientDataJSON: ArrayBuffer;
  };

  class TestPublicKeyCredential implements Credential {
    readonly type = "public-key";
    readonly id = "test";
    readonly rawId: ArrayBuffer;
    readonly extensions: AuthenticationExtensionsClientOutputs;
    readonly response: CeremonyResponse;

    constructor(
      rawId: ArrayBuffer,
      extensions: AuthenticationExtensionsClientOutputs = {},
      ceremonyType: "webauthn.create" | "webauthn.get" = "webauthn.get",
    ) {
      this.rawId = rawId;
      this.extensions = extensions;
      this.response = {
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({
            type: ceremonyType,
            origin: "http://localhost",
          }),
        ).buffer,
      };
    }

    getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
      return this.extensions;
    }
  }

  type CredentialOverrides = {
    create?: (options: CredentialCreationOptions) => Promise<Credential | null>;
    get?: (options: CredentialRequestOptions) => Promise<Credential | null>;
  };

  function stubCredentials(overrides: CredentialOverrides): void {
    vi.stubGlobal("PublicKeyCredential", TestPublicKeyCredential);
    vi.stubGlobal("navigator", { credentials: overrides });
  }

  it("types enabled-without-output on create (KP-22)", async () => {
    stubCredentials({
      create: async () =>
        new TestPublicKeyCredential(
          randomBytes(16).buffer,
          { prf: { enabled: true } },
          "webauthn.create",
        ),
    });
    const failure = await createPasskeyUnlockCeremony().catch(
      (error: BoundaryValue) => error,
    );
    expect(failure).toBeInstanceOf(PrfCeremonyError);
    if (!(failure instanceof PrfCeremonyError)) throw failure;
    expect(failure.code).toBe("prf_enabled_without_output");
  });

  it("types cancellation from NotAllowedError (KP-23)", async () => {
    stubCredentials({
      create: async () => {
        throw new DOMException("cancelled", "NotAllowedError");
      },
    });
    const failure = await createPasskeyUnlockCeremony().catch(
      (error: BoundaryValue) => error,
    );
    expect(failure).toBeInstanceOf(PrfCeremonyError);
    if (!(failure instanceof PrfCeremonyError)) throw failure;
    expect(failure.code).toBe("canceled");
  });

  it("selects the exact enrolled credential among many", async () => {
    const rawA = randomBytes(16);
    const rawB = randomBytes(16);
    const idA = btoa(String.fromCharCode(...rawA));
    const idB = btoa(String.fromCharCode(...rawB));
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    let seenAllow = 0;
    stubCredentials({
      get: async (options) => {
        seenAllow = options.publicKey?.allowCredentials?.length ?? 0;
        return new TestPublicKeyCredential(rawB.buffer, {
          prf: { results: { first: prfOutput } },
        });
      },
    });
    const selected = await getPasskeyUnlockCeremonyFor(
      [record(idA), record(idB)],
      { credentialIdB64: idB },
    );
    expect(selected.credentialIdB64).toBe(idB);
    expect(selected.record.credentialIdB64).toBe(idB);
    expect(selected.prfOutput).toBe(prfOutput);
    expect(seenAllow).toBe(1);
  });

  it("rejects the wrong credential answering the ceremony", async () => {
    const rawA = randomBytes(16);
    const rawB = randomBytes(16);
    const idA = btoa(String.fromCharCode(...rawA));
    stubCredentials({
      get: async () =>
        new TestPublicKeyCredential(rawB.buffer, {
          prf: { results: { first: overlapCast(randomBytes(32).buffer) } },
        }),
    });
    await expect(
      getPasskeyUnlockCeremonyFor([record(idA)], { credentialIdB64: idA }),
    ).rejects.toMatchObject({ code: "wrong_credential" });
  });
});

describe("webauthnPrfCapabilities honesty", () => {
  it("does not claim a KEK from enabled-only extension results", async () => {
    const report = await webauthnPrfCapabilities({
      hostname: "localhost",
      href: "http://localhost/",
      extensionResults: overlapCast({ prf: { enabled: true } }),
      clientCapabilities: { extensions: { prf: true } },
    });
    expect(report.details.usablePrfOutput).toBe(false);
    expect(report.details.prfExtensionAdvertised).toBe(true);
    expect(report.availability.reasonCode).toBe("prf_requires_ceremony");
  });

  it("marks usable output only when results.first has length", async () => {
    const first: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    const report = await webauthnPrfCapabilities({
      hostname: "localhost",
      href: "http://localhost/",
      extensionResults: overlapCast({ prf: { results: { first } } }),
      clientCapabilities: { extensions: { prf: true } },
    });
    expect(report.details.usablePrfOutput).toBe(true);
    expect(report.availability.reasonCode).toBe("prf_output_ready");
  });
});

describe("held PRF material", () => {
  it("wraps a root key without starting another ceremony", async () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const record = await protectorFromPrfMaterial({
      rootKey: root,
      prfOutput: prf.buffer,
      prfSalt: crypto.getRandomValues(new Uint8Array(32)),
      credentialId: crypto.getRandomValues(new Uint8Array(16)).buffer,
      userId: crypto.getRandomValues(new Uint8Array(16)).buffer,
      protectorId: "prf-held",
    });
    expect(record.kind).toBe("webauthn-prf");
    expect(record.legacy).toBe(false);
    expect(record.proofStatus).toBe("verified");
    expect(record.saltB64.length).toBeGreaterThan(0);
  });
});
