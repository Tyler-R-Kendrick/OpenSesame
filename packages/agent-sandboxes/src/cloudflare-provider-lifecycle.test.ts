import type { BrowserDriver } from "@opensesame/cua-password-reset";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, type CdpSocket } from "./cdp-connection.js";
import {
  CloudflareBrowserRunClient,
  CloudflareSessionCleanupError,
} from "./cloudflare-client.js";
import {
  type CloudflareProviderOptions,
  CloudflareSandboxProvider,
} from "./cloudflare-provider.js";
import type { CloudflareTemporaryAccount } from "./cloudflare-provisioning.js";
import { SandboxClaimRequiredError } from "./types.js";

const TEMPORARY_ACCOUNT: CloudflareTemporaryAccount = {
  accountId: "acct-temp",
  apiToken: "temp-token",
  claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
  accountExpiresAt: "2999-01-01T00:00:00Z",
  claimExpiresAt: "2999-01-01T00:00:00Z",
};

async function captureError<T>(run: () => Promise<T>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected the operation to reject");
}

function fakeClient(deleteStatus = 200) {
  const calls: string[] = [];
  const client = new CloudflareBrowserRunClient({
    accountId: "acct-1",
    apiToken: "token-1",
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ sessionId: "sess-9" }), {
        status: init?.method === "DELETE" ? deleteStatus : 200,
      });
    },
  });
  return { client, calls };
}

/** A real CdpConnection over an in-memory socket that records close. */
function fakeConnection() {
  const close = vi.fn();
  const socket: CdpSocket = {
    send: () => undefined,
    close,
    onMessage: () => undefined,
    onClose: () => undefined,
  };
  return { connection: new CdpConnection(socket), close };
}

function fakeDriver(close: () => Promise<void>): BrowserDriver {
  return {
    open: async () => undefined,
    snapshot: async () => {
      throw new Error("not used in lifecycle tests");
    },
    click: async () => undefined,
    fill: async () => undefined,
    fillSecret: async () => undefined,
    close,
  };
}

// The CDP safety gate is suspended on main (#2249) and covered by
// cloudflare-provider.test.ts; these lifecycle tests lift it through
// the provider seam so provisioning/cleanup behavior stays covered.
const unsafeGateLifted: Pick<CloudflareProviderOptions, "requireSafeBrowser"> =
  { requireSafeBrowser: () => undefined };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Cloudflare provider lifecycle", () => {
  it("closes an open socket and deletes the session when driver initialization fails", async () => {
    const { client, calls } = fakeClient();
    const { connection, close } = fakeConnection();
    const provider = new CloudflareSandboxProvider({
      client,
      ...unsafeGateLifted,
      connectCdp: async () => connection,
      connectDriver: async () => {
        throw new Error("driver refused");
      },
    });
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("driver refused");
    expect(close).toHaveBeenCalledOnce();
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });

  it("bounds initialization and closes the socket before session deletion", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const { connection, close } = fakeConnection();
    const provider = new CloudflareSandboxProvider({
      client,
      ...unsafeGateLifted,
      connectCdp: async () => connection,
      connectDriver: () => new Promise<BrowserDriver>(() => undefined),
    });
    const pending = provider.allocate({
      origin: "https://accounts.example.test",
    });
    const rejected = expect(pending).rejects.toThrow(
      "initialization timed out",
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });

  it("returns the validated session ID when cleanup fails", async () => {
    const { client } = fakeClient(500);
    const { connection, close } = fakeConnection();
    const provider = new CloudflareSandboxProvider({
      client,
      ...unsafeGateLifted,
      connectCdp: async () => connection,
      connectDriver: async () => {
        throw new Error("driver refused");
      },
    });
    const failure = await captureError(() =>
      provider.allocate({ origin: "https://accounts.example.test" }),
    );
    expect(failure).toBeInstanceOf(CloudflareSessionCleanupError);
    expect(failure).toMatchObject({ sessionId: "sess-9" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("provisions a temporary account and surfaces its claim URL on auth rejection", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("BROWSER_RUN_API_TOKEN", "");
    const persisted: CloudflareTemporaryAccount[] = [];
    const provider = new CloudflareSandboxProvider({
      ...unsafeGateLifted,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 401 },
        ),
      provisionTemporaryAccount: async () => TEMPORARY_ACCOUNT,
      onTemporaryAccount: (account) => {
        persisted.push(account);
      },
    });
    const failure = await captureError(() =>
      provider.allocate({ origin: "https://accounts.example.test" }),
    );
    expect(failure).toBeInstanceOf(SandboxClaimRequiredError);
    // SAFETY: checked immediately above with toBeInstanceOf on the same value.
    const claim = failure as SandboxClaimRequiredError;
    expect(claim.verificationUri).toBe(TEMPORARY_ACCOUNT.claimUrl);
    expect(persisted).toEqual([TEMPORARY_ACCOUNT]);
  });

  it("retains a freshly provisioned account across allocations", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("BROWSER_RUN_API_TOKEN", "");
    const provision = vi.fn(async () => TEMPORARY_ACCOUNT);
    const onTemporaryAccount = vi.fn();
    const provider = new CloudflareSandboxProvider({
      ...unsafeGateLifted,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 401 },
        ),
      provisionTemporaryAccount: provision,
      onTemporaryAccount,
    });
    await captureError(() =>
      provider.allocate({ origin: "https://accounts.example.test" }),
    );
    await captureError(() =>
      provider.allocate({ origin: "https://accounts.example.test" }),
    );
    expect(provision).toHaveBeenCalledOnce();
    expect(onTemporaryAccount).toHaveBeenCalledOnce();
  });

  it("attempts session deletion even if closing the browser throws", async () => {
    const { client, calls } = fakeClient();
    const { connection } = fakeConnection();
    const provider = new CloudflareSandboxProvider({
      client,
      ...unsafeGateLifted,
      connectCdp: async () => connection,
      connectDriver: async () =>
        fakeDriver(async () => {
          throw new Error("close failed");
        }),
    });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
    });
    await expect(sandbox.close()).rejects.toThrow("close failed");
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });
});
