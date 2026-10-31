import { describe, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { ProviderVerificationSchema } from "./connect-provider-auth-schema.js";
import {
  nativeApiHeaders,
  nativeApiVerificationRequest,
} from "./native-api-auth.js";
import { nativeApiTarget } from "./native-api-target.js";
import { nativeBrowserApiPolicy } from "./native-browser-policy.js";

/**
 * Higgsfield's own contract (docs.higgsfield.ai, read 2026-10-31):
 * - authentication.md and openapi.json: a key ID and a key secret, sent as
 *   `Authorization: Key {key_id}:{key_secret}`;
 * - api-reference/requests/get-request-status.md and concepts/errors.md: the
 *   one documented read is `GET /requests/{request_id}/status`, answering 401
 *   for missing or invalid credentials and 404 for a request the account does
 *   not hold;
 * - authentication.md: "Do not call the API directly from browser or mobile
 *   application code."
 */
const credentials = { api_key: "key-id-1", key_secret: "key-secret-1" };

function preset() {
  const method = connectPlan("higgsfield")?.methods.find(
    (entry) => entry.kind === "api-key",
  );
  if (method?.kind !== "api-key" || !method.preset)
    throw new Error("Higgsfield has no API-key contract");
  return method.preset;
}

describe("Higgsfield's API-key contract", () => {
  it("asks for the key ID and the key secret and sends them as one Key credential", () => {
    expect(preset().additionalCredentials.map((field) => field.name)).toEqual([
      "key_secret",
    ]);
    const headers = nativeApiHeaders(
      nativeApiTarget("higgsfield", {}),
      credentials,
    );
    expect(headers.get("authorization")).toBe("Key key-id-1:key-secret-1");
  });

  it("proves the pair by reading a request status no account holds", () => {
    const request = nativeApiVerificationRequest(
      nativeApiTarget("higgsfield", {}),
      credentials,
    );
    expect(request.method).toBe("GET");
    expect(String(request.url)).toBe(
      "https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status",
    );
    expect(request.body).toBeUndefined();
    // 404: the credentials were accepted and the request is not theirs.
    expect(request.validStatuses).toEqual([404]);
  });

  it("is not called straight from this site: the transport the policy names carries it", () => {
    expect(nativeBrowserApiPolicy("higgsfield")).toMatchObject({
      available: true,
      reason: null,
      advice: expect.stringContaining("native Tailscale HTTP transport"),
      evidenceUrls: ["https://docs.higgsfield.ai/docs/authentication.md"],
    });
  });
});

describe("a status that proves a credential", () => {
  const base = {
    method: "GET",
    url: "https://api.example.com/requests/x/status",
    accountField: null,
  };

  it("is a client error the provider documents, and nothing is read from its body", () => {
    expect(
      ProviderVerificationSchema.safeParse({ ...base, validStatuses: [404] })
        .success,
    ).toBe(true);
    for (const statuses of [[200], [500], [401.5]])
      expect(
        ProviderVerificationSchema.safeParse({
          ...base,
          validStatuses: statuses,
        }).success,
        String(statuses),
      ).toBe(false);
    for (const reads of [
      { accountField: "id" },
      { requiredFields: ["id"] },
      { success: [{ field: "ok", equals: true }] },
    ])
      expect(
        ProviderVerificationSchema.safeParse({
          ...base,
          ...reads,
          validStatuses: [404],
        }).success,
        JSON.stringify(reads),
      ).toBe(false);
  });
});
