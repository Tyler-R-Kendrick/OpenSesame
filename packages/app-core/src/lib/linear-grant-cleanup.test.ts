import { describe, expect, it, vi } from "vitest";
import { revokeLinearGrant } from "./linear-grant-cleanup.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
} from "./linear-runtime.test-support.js";

installLinearRuntimeTests();
const grant = {
  kind: "oauth",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 86_400_000,
  scopes: ["read"],
} as const;
const refreshed = {
  access_token: "fresh-access",
  refresh_token: "fresh-refresh",
  expires_in: 86400,
  token_type: "Bearer",
  scope: "read",
};

describe("Linear cleanup reconciliation after refresh rotation", () => {
  it("immediately revokes both rotated tokens if their durable journal fails without minting another grant", async () => {
    const fetcher = linearAnswers(
      { body: {}, status: 400 },
      { body: refreshed },
      { body: null },
      { body: null },
    );
    const failedJournal = vi.fn(async () => {
      throw new Error("Rotation write failed");
    });
    await expect(
      revokeLinearGrant(
        { ...grant, scopes: [...grant.scopes] },
        "client-1",
        failedJournal,
      ),
    ).rejects.toThrow("Rotation write failed");
    const bodies = fetcher.mock.calls.map(
      ([, init]) => new URLSearchParams(String(init?.body)),
    );
    expect(
      bodies
        .slice(2)
        .map((body) => [body.get("token"), body.get("token_type_hint")]),
    ).toEqual([
      ["fresh-refresh", "refresh_token"],
      ["fresh-access", "access_token"],
    ]);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/oauth/token"),
      ),
    ).toHaveLength(1);
  });

  it("still attempts rotated access revocation if refresh cleanup and journaling both fail and reports provider action required", async () => {
    const fetcher = linearAnswers(
      { body: {}, status: 400 },
      { body: refreshed },
      { body: {}, status: 503 },
      { body: null },
    );
    await expect(
      revokeLinearGrant(
        { ...grant, scopes: [...grant.scopes] },
        "client-1",
        async () => {
          throw new Error("Rotation write failed");
        },
      ),
    ).rejects.toThrow(
      "could not be saved or revoked; revoke this application in Linear Settings",
    );
    expect(
      new URLSearchParams(String(fetcher.mock.calls.at(-1)?.[1]?.body)).get(
        "token",
      ),
    ).toBe("fresh-access");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("proves already revoked access tokens invalid for both old and fresh grants", async () => {
    const fetcher = linearAnswers(
      { body: {}, status: 400 },
      { body: refreshed },
      { body: {}, status: 400 },
      { body: {}, status: 401 },
      { body: null },
      { body: {}, status: 400 },
      { body: {}, status: 401 },
    );
    const rotated = vi.fn();
    await revokeLinearGrant(
      { ...grant, scopes: [...grant.scopes] },
      "client-1",
      rotated,
    );
    expect(rotated).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
      }),
    );
    expect(fetcher.mock.calls[3]?.[0]).toBe("https://api.linear.app/graphql");
    expect(fetcher.mock.calls[6]?.[0]).toBe("https://api.linear.app/graphql");
    const last = new Headers(fetcher.mock.calls[6]?.[1]?.headers);
    expect(last.get("authorization")).toBe("Bearer fresh-access");
  });

  it("hands the rotated pair to its owner before a later cleanup failure", async () => {
    linearAnswers(
      { body: {}, status: 400 },
      { body: refreshed },
      { body: null },
      { body: {}, status: 503 },
    );
    const rotated = vi.fn();
    await expect(
      revokeLinearGrant(
        { ...grant, scopes: [...grant.scopes] },
        "client-1",
        rotated,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(rotated.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
  });

  it("refuses to treat an access revocation error as success while that token still authenticates", async () => {
    linearAnswers(
      { body: {}, status: 400 },
      { body: refreshed },
      { body: {}, status: 400 },
      { body: { data: linearAccount } },
    );
    const rotated = vi.fn();
    await expect(
      revokeLinearGrant(
        { ...grant, scopes: [...grant.scopes] },
        "client-1",
        rotated,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(rotated).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fresh-access" }),
    );
  });
});
