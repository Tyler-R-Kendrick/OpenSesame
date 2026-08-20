#!/usr/bin/env node
import { overlapCast } from "@opensesame/os-domain";
/**
 * Headless device-login demo against the identity control plane.
 *
 *   OPENSESAME_ISSUER=http://127.0.0.1:8788 pnpm --filter @opensesame/example-headless start
 *
 * Set MOCK_DEVICE_FLOW=1 to exercise the client against an in-process mock
 * (no control-plane required).
 */
import { DeviceFlowClient } from "@opensesame/sdk-cli";

const issuer = process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";
const clientId = process.env.OPENSESAME_CLIENT_ID ?? "opensesame-cli";

export function createMockFetch(): typeof fetch {
  let polls = 0;
  return overlapCast(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          device_authorization_endpoint: `${issuer}/device`,
          jwks_uri: `${issuer}/jwks`,
        }),
      );
    }
    if (url.endsWith("/device") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          device_code: "DO_NOT_PRINT",
          user_code: "HEAD-LESS",
          verification_uri: "http://127.0.0.1:5173/device",
          expires_in: 600,
          interval: 1,
        }),
      );
    }
    if (url.endsWith("/token")) {
      polls += 1;
      if (polls < 2) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          {
            status: 400,
          },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "mock-access",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    }
    throw new Error(`unexpected ${url}`);
  });
}

export async function runHeadlessDeviceLogin(options?: {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ userCode: string; accessTokenPresent: boolean }> {
  const client = new DeviceFlowClient({
    issuer,
    clientId,
    fetchImpl:
      options?.fetchImpl ??
      (process.env.MOCK_DEVICE_FLOW === "1" ? createMockFetch() : fetch),
    sleep:
      options?.sleep ??
      (async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      }),
  });

  const start = await client.start();
  const instructions = client.formatInstructions(start);
  if (
    instructions.includes("DO_NOT_PRINT") ||
    /device_code/iu.test(instructions)
  ) {
    throw new Error("device_code leaked into user instructions");
  }
  process.stdout.write(`${instructions}\n\nWaiting for approval…\n`);
  const tokens = await client.pollUntilComplete();
  process.stdout.write("Device login complete (access token received).\n");
  return {
    userCode: start.userCode,
    accessTokenPresent: Boolean(tokens.access_token),
  };
}

const isMain =
  process.env.VITEST !== "true" &&
  (process.argv[1]?.endsWith("main.ts") ||
    process.argv[1]?.includes("example-headless"));

if (isMain) {
  runHeadlessDeviceLogin().catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
