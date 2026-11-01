import { pagesSiopIssuer } from "@opensesame/siop-v2";
import { describe, expect, it } from "vitest";
import { dynamicSiopIssuer } from "./siop-authority.js";

describe("siop-authority", () => {
  it("builds the dynamic issuer on the Pages identity/siop path", () => {
    expect(
      dynamicSiopIssuer("https://pages.example.test", "/OpenSesame/"),
    ).toBe("https://pages.example.test/OpenSesame/identity/siop");
    expect(dynamicSiopIssuer("https://pages.example.test", "/")).toBe(
      "https://pages.example.test/identity/siop",
    );
  });

  it("signs as the issuer the kit and the published metadata name (ADR 0161)", () => {
    // `siop-metadata.json` and a relying party's pinned issuer come from
    // `pagesSiopIssuer`; the token is signed as `dynamicSiopIssuer`. They are
    // one string for every origin and base path a deployment can have.
    for (const [pageOrigin, basePath] of [
      ["https://pages.example.test", "/OpenSesame/"],
      ["https://pages.example.test", "/"],
      ["https://opensesame-labs.github.io", "/OpenSesame/"],
      ["http://localhost:5180", "/OpenSesame/"],
    ] as const) {
      expect(dynamicSiopIssuer(pageOrigin, basePath)).toBe(
        pagesSiopIssuer({ origin: pageOrigin, basePath }),
      );
    }
  });
});
