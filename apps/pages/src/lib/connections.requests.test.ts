import { beforeEach, describe, expect, it, vi } from "vitest";

const fetches = vi.hoisted(() => ({
  host: vi.fn(),
  identity: vi.fn(),
}));

vi.mock("./organization-identity.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./organization-identity.js")
  >();
  return {
    ...actual,
    hostFetch: fetches.host,
    identityFetch: fetches.identity,
  };
});

import { listMembers, listProviders, revokeConnection } from "./connections.js";

function json(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("connections request errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains same-site cookie recovery only for Identity 401s", async () => {
    fetches.identity.mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(listMembers("org_1")).rejects.toThrow(
      /sign in.*same-site.*sibling custom domains/iu,
    );

    fetches.host.mockResolvedValue(
      json({ error: "unauthorized", hint: "Host session expired." }, 401),
    );
    await expect(listProviders("org_1")).rejects.toThrow(
      "Host session expired.",
    );
  });

  it("rejects malformed Host errors without surfacing extra fields", async () => {
    fetches.host.mockResolvedValue(
      json(
        {
          error: "unauthorized",
          hint: "Use this leaked token: opaque-session:secret",
          access_token: "opaque-session:secret",
        },
        401,
      ),
    );

    await expect(listProviders("org_1")).rejects.toMatchObject({
      status: 401,
      message: "Request failed.",
    });
  });

  it.each(["ok", "failed", "unsupported"] as const)(
    "strictly parses the %s provider revocation outcome",
    async (providerRevocation) => {
      fetches.host.mockResolvedValue(
        json({ revoked: true, provider_revocation: providerRevocation }, 200),
      );

      await expect(revokeConnection("org_1", "connection_1")).resolves.toEqual({
        revoked: true,
        provider_revocation: providerRevocation,
      });
    },
  );

  it("rejects unknown fields in a revoke success response", async () => {
    fetches.host.mockResolvedValue(
      json(
        {
          revoked: true,
          provider_revocation: "ok",
          access_token: "must-not-cross",
        },
        200,
      ),
    );

    await expect(revokeConnection("org_1", "connection_1")).rejects.toThrow(
      /unrecognized_keys/iu,
    );
  });
});
