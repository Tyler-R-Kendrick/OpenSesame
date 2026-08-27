import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticationClient } from "./authentication-service.js";

function passkey(kind: "registration" | "authentication"): PublicKeyCredential {
  const response =
    kind === "registration"
      ? {
          clientDataJSON: new Uint8Array([1]).buffer,
          attestationObject: new Uint8Array([2]).buffer,
          getTransports: () => ["internal"],
        }
      : {
          clientDataJSON: new Uint8Array([1]).buffer,
          authenticatorData: new Uint8Array([2]).buffer,
          signature: new Uint8Array([3]).buffer,
          userHandle: new Uint8Array([4]).buffer,
        };
  return overlapCast({
    id: "credential-1",
    rawId: new Uint8Array([9]).buffer,
    type: "public-key",
    response,
    getClientExtensionResults: () => ({}),
  });
}

describe("authentication client", () => {
  it("runs registration and conditional sign-in through the shared serializer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          rp: { id: "example.com", name: "Example" },
          user: { id: "aA", name: "ada", displayName: "Ada" },
          challenge: "aGk",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ challenge: "aGk", rpId: "example.com" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token: "ost_result",
          expiresAt: "2026-08-26T12:02:00.000Z",
        }),
      );
    const credentials = {
      create: vi.fn(async () => passkey("registration")),
      get: vi.fn(async () => passkey("authentication")),
    };
    const client = createAuthenticationClient({
      apiBase: "https://identity.example",
      applicationId: "authapp_1",
      fetchImpl,
      credentials,
    });

    await client.register("ort_register", "Laptop");
    await expect(client.signin({ mode: "autofill" })).resolves.toEqual({
      token: "ost_result",
      expiresAt: "2026-08-26T12:02:00.000Z",
    });
    expect(credentials.get).toHaveBeenCalledWith(
      expect.objectContaining({ mediation: "conditional" }),
    );
    const registrationBody = JSON.parse(
      String(overlapCast(fetchImpl.mock.calls[1]?.[1]).body),
    );
    expect(registrationBody).toMatchObject({
      applicationId: "authapp_1",
      name: "Laptop",
      response: { id: "credential-1", type: "public-key" },
    });
    const authenticationBody = JSON.parse(
      String(overlapCast(fetchImpl.mock.calls[3]?.[1]).body),
    );
    expect(authenticationBody.response.response.userHandle).toBe("BA");
  });
});
