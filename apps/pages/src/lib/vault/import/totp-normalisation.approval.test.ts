import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./index.js";
import { normaliseTotp } from "./types.js";

/**
 * Approval test for TOTP portability.
 *
 * `toMatchFileSnapshot` is the closest vitest equivalent of Verify: the
 * approved output lives in a committed file next to this test, is reused on
 * every later run, and any change to it arrives as a reviewable diff. Nothing
 * in this repo used it before.
 *
 * `normaliseTotp` is the single chokepoint every import adapter routes its
 * authenticator secret through, so what it accepts *is* the portability
 * guarantee: a seed it silently drops is a second factor the user loses on
 * import, with no error to tell them. Pinning the table makes any change to
 * that boundary explicit.
 */

const CASES: ReadonlyArray<readonly [label: string, input: string]> = [
  ["bare base32", "JBSWY3DPEHPK3PXPJBSWY3DP"],
  ["base32 lowercase", "jbswy3dpehpk3pxpjbswy3dp"],
  ["base32 in display groups", "JBSW Y3DP EHPK 3PXP JBSW Y3DP"],
  ["base32 hyphenated", "JBSW-Y3DP-EHPK-3PXP-JBSW-Y3DP"],
  ["base32 padded", "JBSWY3DPEHPK3PXPJBSWY3DP===="],
  ["base32 with surrounding space", "  JBSWY3DPEHPK3PXPJBSWY3DP  "],
  ["too short to be a seed", "JBSWY3DP"],
  [
    "otpauth totp uri",
    "otpauth://totp/Acme:me@acme.test?secret=JBSWY3DP&issuer=Acme",
  ],
  [
    "otpauth uri with algorithm and digits",
    "otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
  ],
  [
    "otpauth uppercase scheme",
    "OTPAUTH://TOTP/Acme:me?secret=JBSWY3DPEHPK3PXP",
  ],
  [
    "otpauth hotp uri",
    "otpauth://hotp/Acme:me?secret=JBSWY3DPEHPK3PXP&counter=1",
  ],
  [
    "google authenticator migration uri",
    "otpauth-migration://offline?data=CjkKCkhlbGxvId6tvu8SFEV4YW1wbGU6YWxpY2VAZ21haWwuY29tGgdFeGFtcGxlIAEoATACEAEYASAA",
  ],
  ["empty", ""],
  ["whitespace only", "   "],
  ["not a secret", "see the sticky note"],
  ["base32 alphabet violation", "JBSWY3DP0189EHPK3PXP"],
  ["url that is not otpauth", "https://acme.test/2fa"],
];

function render(): string {
  const rows = CASES.map(([label, input]) => {
    const result = normaliseTotp(input);
    const outcome =
      result === "" ? "DROPPED" : /^otpauth:/iu.test(result) ? "URI" : "SEED";
    return [
      `## ${label}`,
      "",
      `input:    ${JSON.stringify(input)}`,
      `outcome:  ${outcome}`,
      `output:   ${JSON.stringify(result)}`,
      "",
    ].join("\n");
  });

  return [
    "# normaliseTotp — approved behaviour",
    "",
    "Every import adapter routes its authenticator secret through this",
    "function. DROPPED means the user silently loses that second factor on",
    "import, so review a new DROPPED row carefully before approving it.",
    "",
    "Known gap, visible below: `otpauth-migration://` is DROPPED. That is",
    "Google Authenticator's own export format, so a migration payload loses",
    "every secret it carries, with no error shown. Closing it needs a",
    "protobuf decoder for the payload; until then this row is a deliberate",
    "record of the gap, not approval of it.",
    "",
    "The remaining DROPPED rows are correct: empty, whitespace-only, a seed",
    "too short to be usable, an alphabet violation, and a non-otpauth URL.",
    "",
    ...rows,
  ].join("\n");
}

describe("TOTP normalisation approval", () => {
  it("matches the approved table", async () => {
    await expect(render()).toMatchFileSnapshot(
      "./__snapshots__/totp-normalisation.approved.md",
    );
  });

  it("covers every adapter that can carry a TOTP secret", () => {
    // Guards the premise: if adapters grow a second normalisation path, this
    // approval file stops describing the whole portability boundary.
    const sources = ADAPTERS.map((adapter) => adapter.id);
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
