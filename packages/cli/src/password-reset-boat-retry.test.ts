import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoatJsonValue,
  SandboxClaimRequiredError,
} from "@opensesame/agent-sandboxes";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadBoatProviderState,
  saveBoatProviderState,
  withBoatStateLock,
} from "./boat-provider-state.js";
import { createSandboxProvider } from "./password-reset-sandbox-provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function json(value: BoatJsonValue, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it("keeps the same provider until a failed rotated-state write is recovered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-provider-retry-"));
  const path = join(dir, ".boat-agent-state.json");
  let grantCalls = 0;
  try {
    saveBoatProviderState(dir, { identityAssertion: "old" });
    vi.stubEnv("BOAT_RELAY_AGENT_COMMAND", "agent");
    vi.stubEnv("BOAT_API_KEY", "");
    vi.stubEnv("BOAT_API_TOKEN", "");
    vi.stubEnv("BOAT_CLAIM_TOKEN", "");
    vi.stubEnv("BOAT_IDENTITY_ASSERTION", "");
    const fakeFetch: typeof fetch = async (input) => {
      const pathName = new URL(String(input)).pathname;
      if (pathName === "/api/boat/oauth2/token") {
        grantCalls += 1;
        if (grantCalls === 1) chmodSync(path, 0o644);
        return json({ access_token: "token", identity_assertion: "rotated" });
      }
      if (pathName === "/api/v1/sandboxes")
        return json(
          {
            ok: false,
            status: 402,
            code: "billing_required",
            error: { code: "billing_required", message: "billing" },
          },
          402,
        );
      if (pathName === "/api/boat/billing/checkout")
        return json({ url: "https://checkout.stripe.com/session" });
      throw new Error(`unexpected ${pathName}`);
    };
    vi.stubGlobal("fetch", fakeFetch);
    const provider = createSandboxProvider("boat", dir);
    const request = { origin: "https://accounts.example.test" };
    await expect(provider.allocate(request)).rejects.toThrow(
      /rotated identity could not be persisted/,
    );
    await expect(withBoatStateLock(dir, async () => {})).rejects.toThrow(
      /locked/,
    );
    expect(createSandboxProvider("boat", dir)).toBe(provider);
    chmodSync(path, 0o600);
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(grantCalls).toBe(1);
    expect(loadBoatProviderState(dir).identityAssertion).toBe("rotated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reloads state after a completed allocation attempt releases its lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-provider-reload-"));
  const assertions: string[] = [];
  try {
    saveBoatProviderState(dir, { identityAssertion: "first" });
    vi.stubEnv("BOAT_RELAY_AGENT_COMMAND", "agent");
    vi.stubEnv("BOAT_API_KEY", "");
    vi.stubEnv("BOAT_API_TOKEN", "");
    vi.stubEnv("BOAT_CLAIM_TOKEN", "");
    vi.stubEnv("BOAT_IDENTITY_ASSERTION", "");
    const fakeFetch: typeof fetch = async (input, init) => {
      const pathName = new URL(String(input)).pathname;
      if (pathName === "/api/boat/oauth2/token") {
        assertions.push(
          new URLSearchParams(String(init?.body)).get("assertion") ?? "",
        );
        return json({ access_token: "token" });
      }
      if (pathName === "/api/v1/sandboxes")
        return json(
          {
            ok: false,
            status: 402,
            code: "billing_required",
            error: { code: "billing_required", message: "billing" },
          },
          402,
        );
      if (pathName === "/api/boat/billing/checkout")
        return json({ url: "https://checkout.stripe.com/session" });
      throw new Error(`unexpected ${pathName}`);
    };
    vi.stubGlobal("fetch", fakeFetch);
    const provider = createSandboxProvider("boat", dir);
    const request = { origin: "https://accounts.example.test" };
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    saveBoatProviderState(dir, {
      identityAssertion: "updated-by-another-process",
    });
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(assertions).toEqual(["first", "updated-by-another-process"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
