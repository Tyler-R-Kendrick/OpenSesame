/**
 * Cloudflare temporary-account provisioning: the account-less path to a
 * Browser Run account. Solves the proof-of-work challenge and creates a
 * temporary preview account, returning its credentials and claim URL.
 * https://developers.cloudflare.com/workers/platform/claim-deployments/
 *
 * Creating an account asserts acceptance of Cloudflare's Terms of
 * Service and Privacy Policy, so callers invoke this only under the
 * operator's instruction. Temporary credentials authorize supported
 * resources only; Browser Run itself requires the account to be
 * claimed, after which the operator supplies a normal API token.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export interface CloudflareTemporaryAccount {
  accountId: string;
  apiToken: string;
  claimUrl: string;
  accountExpiresAt: string;
  claimExpiresAt: string;
}

export interface CloudflareProvisioningOptions {
  fetchImpl?: typeof fetch;
  /** Defaults to the public Cloudflare API. */
  baseUrl?: string;
  /** Explicit test-only opt-in for a local fake API. */
  allowInsecureLoopbackForTesting?: boolean;
}

const challengeResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    challengeToken: z.string().min(1),
    seed: z.string().min(1),
    k: z.number(),
    g: z.number(),
  }),
});

const createResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    account: z.object({
      id: z.string().min(1),
      apiToken: z.string().min(1),
      expiresAt: z.string().min(1),
    }),
    claim: z.object({
      url: z.string().min(1),
      expiresAt: z.string().min(1),
    }),
  }),
});

const MAX_PROOF_OF_WORK_HASHES = 64_000_000;

function provisioningBaseUrl(options: CloudflareProvisioningOptions): string {
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? "https://api.cloudflare.com/client/v4");
  } catch {
    throw new Error("cloudflare: untrusted provisioning endpoint");
  }
  const production =
    base.protocol === "https:" &&
    base.hostname === "api.cloudflare.com" &&
    !base.port &&
    base.pathname.replace(/\/$/u, "") === "/client/v4";
  const testLoopback =
    options.allowInsecureLoopbackForTesting === true &&
    base.protocol === "http:" &&
    base.hostname === "127.0.0.1";
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(production || testLoopback)
  )
    throw new Error("cloudflare: untrusted provisioning endpoint");
  return base.href.replace(/\/$/u, "");
}

async function solveProofOfWork(challenge: {
  seed: string;
  k: number;
  g: number;
}): Promise<string> {
  const { k, g } = challenge;
  const seed = Buffer.from(challenge.seed, "base64url");
  if (
    !Number.isInteger(k) ||
    !Number.isInteger(g) ||
    k < 1 ||
    g < 1 ||
    k * g > MAX_PROOF_OF_WORK_HASHES ||
    seed.length !== 32
  )
    throw new Error("cloudflare: unacceptable proof of work challenge");
  let current = createHash("sha256").update(seed).digest();
  const checkpoints: Buffer[] = [current];
  for (let segment = 0; segment < k; segment += 1) {
    for (let i = 0; i < g; i += 1)
      current = createHash("sha256").update(current).digest();
    checkpoints.push(current);
    // The chain is CPU-intensive; yield so hosts stay responsive.
    if (segment % 100 === 99)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return Buffer.concat(checkpoints).toString("base64");
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("cloudflare: provisioning request failed");
  }
  if (!response.ok)
    throw new Error(
      `cloudflare: provisioning failed (HTTP ${response.status})`,
    );
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error("cloudflare: invalid provisioning response");
  }
}

export async function provisionCloudflareTemporaryAccount(
  options: CloudflareProvisioningOptions = {},
): Promise<CloudflareTemporaryAccount> {
  const baseUrl = provisioningBaseUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const challenge = await postJson(
    fetchImpl,
    `${baseUrl}/provisioning/previews/challenge`,
    "{}",
    challengeResponseSchema,
  );
  const checkpoints = await solveProofOfWork(challenge.result);
  const created = await postJson(
    fetchImpl,
    `${baseUrl}/provisioning/previews`,
    JSON.stringify({
      termsOfService: "https://www.cloudflare.com/terms/",
      privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
      acceptTermsOfService: "yes",
      challengeToken: challenge.result.challengeToken,
      solution: { checkpoints },
    }),
    createResponseSchema,
  );
  return {
    accountId: created.result.account.id,
    apiToken: created.result.account.apiToken,
    claimUrl: created.result.claim.url,
    accountExpiresAt: created.result.account.expiresAt,
    claimExpiresAt: created.result.claim.expiresAt,
  };
}
