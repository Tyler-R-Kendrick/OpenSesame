import { describe, expect, it } from "vitest";
import { crossOriginOpenerPolicy } from "./opener-policy.js";

describe("crossOriginOpenerPolicy", () => {
  it("keeps the exact local authorization popup able to see its opener", () => {
    expect(
      crossOriginOpenerPolicy("/OpenSesame/identity/authorize", "/OpenSesame/"),
    ).toBe("unsafe-none");
  });

  it("isolates neighboring identity routes and extra path suffixes", () => {
    expect(
      crossOriginOpenerPolicy("/OpenSesame/identity", "/OpenSesame/"),
    ).toBe("same-origin");
    expect(
      crossOriginOpenerPolicy(
        "/OpenSesame/identity/authorize-extra",
        "/OpenSesame/",
      ),
    ).toBe("same-origin");
    expect(crossOriginOpenerPolicy("/OpenSesame/vault", "/OpenSesame/")).toBe(
      "same-origin",
    );
  });
});
