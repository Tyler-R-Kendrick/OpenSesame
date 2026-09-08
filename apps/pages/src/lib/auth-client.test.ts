import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import compatibilityHash from "../../public/auth.js.sha384?raw";
import source from "../../public/auth.js?raw";
import immutable from "../../public/static-auth/1.0.2/opensesame-auth.min.js?raw";
import manifest from "../../public/static-auth/manifest.json";

describe("shipped authentication SDK", () => {
  it("pins the canonical hosted artifact and frozen loopback compatibility bytes separately", () => {
    expect(compatibilityHash.trim()).toBe(
      "sha384-3ja8qPvrKWHcFXbLAgIeUQVb3yVQO2kDbnomLIY1Jq/GR+Gnmf7WoUcvmFIbM8aq",
    );
    expect(
      `sha384-${createHash("sha384").update(source).digest("base64")}`,
    ).toBe(compatibilityHash.trim());
    expect(
      `sha384-${createHash("sha384").update(immutable).digest("base64")}`,
    ).toBe(manifest.sri);
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
  });
  it("has no default unverified success, session persistence, raw token events, or metadata-based verifier", async () => {
    const browser = {
      OpenSesame: {
        signIn: (_profile?: { profile: string }): Promise<{
          subject?: string;
        }> => Promise.resolve({}),
      },
      dispatchEvent: vi.fn(),
    };
    runInNewContext(source, {
      window: browser,
      CustomEvent,
      TextEncoder,
      TextDecoder,
      URL,
      crypto,
      atob,
      btoa,
    });
    await expect(browser.OpenSesame.signIn()).rejects.toThrow("signin_failed");
    expect(
      browser.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).toEqual(["opensesame:signin_error"]);
    expect(browser.OpenSesame).not.toHaveProperty("acceptSession");
    expect(browser.OpenSesame).not.toHaveProperty("derivePairwiseSubject");
    expect(browser.OpenSesame).not.toHaveProperty("getSession");
  });
});
