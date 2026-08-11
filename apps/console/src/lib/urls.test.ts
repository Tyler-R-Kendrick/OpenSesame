import { describe, expect, it } from "vitest";
import { isLoopbackUrl, operatorHeadersFor } from "./urls.js";

describe("console operator bearer", () => {
  it("recognises only this machine", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8787")).toBe(true);
    expect(isLoopbackUrl("https://gateway.example.test")).toBe(false);
    expect(isLoopbackUrl("http://169.254.169.254")).toBe(false);
    expect(isLoopbackUrl("garbage")).toBe(false);
  });

  it("does not follow a build-time secret out to a remote gateway", () => {
    expect(operatorHeadersFor("http://127.0.0.1:8787", "op")).toEqual({
      authorization: "Bearer operator:op",
    });
    expect(operatorHeadersFor("https://gateway.example.test", "op")).toEqual(
      {},
    );
  });
});
