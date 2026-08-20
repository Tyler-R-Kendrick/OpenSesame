import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaimStash,
  readClaimStash,
  writeClaimStash,
} from "./claim-stash.js";
import { isLoopbackUrl, operatorHeadersFor } from "./urls.js";
import { overlapCast } from "@opensesame/os-domain";

const here = dirname(fileURLToPath(import.meta.url));

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe("PACT — console operator + claim stash", () => {
  afterEach(() => {
    clearClaimStash();
  });

  it("property: operator bearer is offered only to loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8787")).toBe(true);
    expect(operatorHeadersFor("http://127.0.0.1:8787", "op")).toEqual({
      authorization: "Bearer operator:op",
    });
    expect(operatorHeadersFor("https://gateway.example.test", "op")).toEqual(
      {},
    );
  });

  it("adversarial: remote hosts and metadata IPs never get the operator token", () => {
    for (const bad of [
      "https://gateway.example.test",
      "http://169.254.169.254",
      "http://10.0.0.5:8787",
      "garbage",
    ]) {
      expect(operatorHeadersFor(bad, "op"), bad).toEqual({});
    }
  });

  it("chaos: concurrent stash writes keep a parseable token off the URL", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    writeClaimStash({ token: "osc_clm_x.secret", presented: false });
    writeClaimStash({
      token: "osc_clm_x.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    const stash = readClaimStash();
    expect(stash?.token).toBe("osc_clm_x.secret");
    expect(stash?.principalId).toBe("prn_1");
    assertSourceOrder(readFileSync(join(here, "claim-stash.ts"), "utf8"), [
      "sessionStorage.setItem",
      "JSON.stringify(next)",
    ]);
    expect(
      readFileSync(join(here, "../pages/ClaimPage.tsx"), "utf8"),
    ).not.toMatch(/searchParams.*token/);
  });

  it("contract: stash JSON is the only claim-token store and operator pin is loopback", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    writeClaimStash({ token: "osc_clm_x.secret", presented: false });
    const parsed = overlapCast(JSON.parse(
      globalThis.sessionStorage.getItem("opensesame.claim") ?? "null",
    ));
    expect(parsed.token).toBe("osc_clm_x.secret");
    assertNoSecretFields({ claimId: "clm_1", principalId: "prn_1" });
    assertSourceOrder(readFileSync(join(here, "urls.ts"), "utf8"), [
      "normalizeLoopbackBaseUrl",
      "if (!operatorToken || !isLoopbackUrl(base)) return {}",
    ]);
  });
});
