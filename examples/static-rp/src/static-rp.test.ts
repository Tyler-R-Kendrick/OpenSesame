import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultOriginCallback,
  originProfileClientId,
} from "@opensesame/sdk-browser";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "../public");

describe("example-static-rp", () => {
  it("pins the origin-profile callback path (ADR 0050 F4/F7)", () => {
    expect(defaultOriginCallback("http://127.0.0.1:4101")).toBe(
      "http://127.0.0.1:4101/opensesame/callback",
    );
    expect(originProfileClientId("http://127.0.0.1:4101")).toBe(
      "origin:http://127.0.0.1:4101",
    );
    expect(originProfileClientId("http://127.0.0.1:4102")).not.toBe(
      originProfileClientId("http://127.0.0.1:4101"),
    );
  });

  it("is a genuine static site: index + callback, no RP token route", () => {
    const index = readFileSync(join(publicDir, "index.html"), "utf8");
    const callback = readFileSync(
      join(publicDir, "opensesame/callback.html"),
      "utf8",
    );
    const client = readFileSync(join(publicDir, "client.ts"), "utf8");
    const callbackEntry = readFileSync(join(publicDir, "callback.ts"), "utf8");
    expect(index).toContain('src="/index.ts"');
    expect(callback).toContain('src="/callback.ts"');
    expect(client).toContain('from "@opensesame/static-auth"');
    expect(client).toContain("createHostedClient({");
    expect(client).toContain('profile: "hosted_identity"');
    expect(index).toContain('id="sign-in"');
    expect(index).toContain('id="status"');
    expect(callbackEntry).toContain("sesame.complete()");
    expect(index).not.toContain("innerHTML");
    expect(callback).not.toContain("client_secret");
    expect(callbackEntry).not.toContain("client_secret");
    expect(client).not.toContain("client_secret");
  });
});
