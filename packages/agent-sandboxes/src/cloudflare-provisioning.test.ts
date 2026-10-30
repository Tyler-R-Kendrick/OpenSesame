import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CloudflareProvisioningOptions,
  provisionCloudflareTemporaryAccount,
} from "./cloudflare-provisioning.js";

const SEED = Buffer.alloc(32, 9).toString("base64url");

interface RecordedRequest {
  url: string;
  body: string;
}

interface FakeChallenge {
  k: number;
  g: number;
  seed?: string;
}

function fakeProvisioning(challenge: FakeChallenge) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/provisioning/previews/challenge"))
      return Response.json({
        success: true,
        result: {
          challengeToken: "challenge-1",
          seed: challenge.seed ?? SEED,
          k: challenge.k,
          g: challenge.g,
        },
        errors: [],
      });
    return Response.json(
      {
        success: true,
        result: {
          account: {
            id: "acct-temp",
            name: "Seed Amp",
            apiToken: "temp-token",
            expiresAt: "2026-10-30T01:32:58Z",
          },
          claim: {
            url: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
            expiresAt: "2026-10-30T01:32:58Z",
          },
        },
        errors: [],
      },
      { status: 201 },
    );
  };
  // SAFETY: checked at the fake-fetch boundary: the mock implements exactly the (url, init) call shapes the provisioning client sends.
  const options: CloudflareProvisioningOptions = {
    fetchImpl: fetchImpl as typeof fetch,
  };
  return { options, requests };
}

function expectedCheckpoints(k: number, g: number): string {
  let current = createHash("sha256")
    .update(Buffer.from(SEED, "base64url"))
    .digest();
  const checkpoints = [current];
  for (let segment = 0; segment < k; segment += 1) {
    for (let i = 0; i < g; i += 1)
      current = createHash("sha256").update(current).digest();
    checkpoints.push(current);
  }
  return Buffer.concat(checkpoints).toString("base64");
}

describe("provisionCloudflareTemporaryAccount", () => {
  it("solves the proof of work and returns temporary credentials", async () => {
    const { options, requests } = fakeProvisioning({ k: 2, g: 3 });
    const account = await provisionCloudflareTemporaryAccount(options);
    expect(account).toEqual({
      accountId: "acct-temp",
      apiToken: "temp-token",
      claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
      accountExpiresAt: "2026-10-30T01:32:58Z",
      claimExpiresAt: "2026-10-30T01:32:58Z",
    });
    // SAFETY: checked at the fake-API boundary: the only sender is the provisioning client under test, which serializes exactly this body shape.
    const create = JSON.parse(requests[1]?.body ?? "{}") as {
      challengeToken: string;
      acceptTermsOfService: string;
      solution: { checkpoints: string };
    };
    expect(create.challengeToken).toBe("challenge-1");
    expect(create.acceptTermsOfService).toBe("yes");
    expect(create.solution.checkpoints).toBe(expectedCheckpoints(2, 3));
  });

  it("rejects an unbounded proof-of-work challenge", async () => {
    const { options, requests } = fakeProvisioning({ k: 100_000, g: 1000 });
    await expect(provisionCloudflareTemporaryAccount(options)).rejects.toThrow(
      "proof of work",
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects a malformed seed", async () => {
    const { options } = fakeProvisioning({ k: 1, g: 1, seed: "AA" });
    await expect(provisionCloudflareTemporaryAccount(options)).rejects.toThrow(
      "proof of work",
    );
  });
});
