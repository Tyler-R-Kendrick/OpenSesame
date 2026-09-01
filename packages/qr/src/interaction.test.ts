import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InteractionLinkError,
  buildInteractionUrl,
} from "@opensesame/ceremony-kit";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  QrEncodeError,
  encodeInteractionQr,
  encodeInteractionQrTerminal,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REF = `i_${"a".repeat(24)}.${"b".repeat(32)}`;
const LINK = buildInteractionUrl("https://ceremonies.example", REF);

describe("encodeInteractionQr", () => {
  it("encodes a canonical interaction link", () => {
    const svg = encodeInteractionQr(LINK, { pixelSize: 4, border: 2 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toBe(encodeInteractionQr(LINK, { pixelSize: 4, border: 2 }));
    expect(
      encodeInteractionQrTerminal(LINK).split("\n").length,
    ).toBeGreaterThan(4);
  });

  it("refuses credential material before any encoding happens", () => {
    // Structural, not incidental: the deny-list check is the first thing on
    // both paths, so no matrix ever exists for a link carrying a bearer.
    assertSourceOrder(readFileSync(join(here, "interaction.ts"), "utf8"), [
      "export function encodeInteractionQr",
      "assertInteractionPayload(url);",
      "return encodeQrSvg",
      "function assertInteractionPayload",
      "assertNoForbiddenParams(url);",
      "parseInteractionUrl(url) === null",
      "throw new QrEncodeError",
    ]);
    for (const hostile of [
      "https://ceremonies.example/i/x?token=osc_clm_abc.def",
      `${LINK}?access_token=ya29.SECRET`,
      `${LINK}#accessToken=ya29.SECRET`,
      `${LINK}?apiKey=k`,
    ]) {
      expect(() => encodeInteractionQr(hostile)).toThrow(InteractionLinkError);
      expect(() => encodeInteractionQrTerminal(hostile)).toThrow(
        InteractionLinkError,
      );
    }
  });

  it("refuses a payload that is not a canonical interaction link", () => {
    for (const wrong of [
      "https://ceremonies.example/device?user_code=ABCD-EFGH",
      "javascript:alert(1)",
      `http://evil.example/i/${REF}`,
      "",
    ]) {
      expect(() => encodeInteractionQr(wrong)).toThrow(QrEncodeError);
      expect(() => encodeInteractionQrTerminal(wrong)).toThrow(QrEncodeError);
    }
  });
});
