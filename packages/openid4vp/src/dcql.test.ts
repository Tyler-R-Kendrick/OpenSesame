/**
 * The DCQL profile, stated and enforced (finding F09).
 *
 * `DCQL_PROFILE` is the constant an integrator is invited to quote, so these
 * tests hold it to what the code actually enforces: one credential query, the
 * two verifiable formats, a §6.1 id, a non-empty `vct_values`. The static
 * credential-format assertions live here too — they moved out of
 * `verify.test.ts` to sit beside the constants they check.
 */

import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DCQL_PROFILE,
  DCQL_PROFILE_ID,
  type DcqlCredentialQuery,
  type DcqlQuery,
  KNOWN_CREDENTIAL_FORMATS,
  VERIFIABLE_CREDENTIAL_FORMATS,
  assertDcqlProfile,
  isKnownCredentialFormat,
  isVerifiableCredentialFormat,
} from "./dcql.js";
import { Openid4vpError } from "./errors.js";

const VCT = "https://credentials.example/pid";

function refusalCode(run: () => void): string | null {
  try {
    run();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) return thrown.code;
    throw thrown;
  }
  return null;
}

describe("DCQL_PROFILE", () => {
  it("names exactly one supported query shape (T-20)", () => {
    expect(DCQL_PROFILE.id).toBe(DCQL_PROFILE_ID);
    expect(DCQL_PROFILE_ID).toBe("opensesame-openid4vp-dcql/1.0");
    expect(DCQL_PROFILE.credentialQueries).toEqual({ minimum: 1, maximum: 1 });
    expect(DCQL_PROFILE.formats).toEqual(VERIFIABLE_CREDENTIAL_FORMATS);
    // The honest half: the boundary is stated, not left to be discovered.
    expect(DCQL_PROFILE.notSupported).toContain(
      "more than one Credential Query (one response is one trust conclusion)",
    );
    expect(DCQL_PROFILE.notSupported).toContain("multiple:true (§6.1)");
  });
});

describe("assertDcqlProfile", () => {
  const query: DcqlQuery = {
    credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
  };

  it("returns the query ids for a conforming single-credential query", () => {
    const ids = assertDcqlProfile(query);
    expect([...ids]).toEqual(["pid"]);
  });

  it("refuses more than one credential query", () => {
    expect(
      refusalCode(() =>
        assertDcqlProfile({
          credentials: [
            { id: "pid", format: "dc+sd-jwt", vctValues: [VCT] },
            { id: "mdl", format: "dc+sd-jwt", vctValues: [VCT] },
          ],
        }),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses an id outside the §6.1 alphabet", () => {
    expect(
      refusalCode(() =>
        assertDcqlProfile({
          credentials: [
            { id: "not ok", format: "dc+sd-jwt", vctValues: [VCT] },
          ],
        }),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses an empty vct_values", () => {
    expect(
      refusalCode(() =>
        assertDcqlProfile({
          credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [] }],
        }),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses a recognized-but-unverifiable format by name", () => {
    // SAFETY: `mso_mdoc` is a KNOWN format this profile declines, so it is not a
    // `VerifiableCredentialFormat`; `overlapCast` reaches the format guard the
    // way an out-of-profile caller who wrote the identifier by hand would.
    const mdoc = overlapCast<
      { id: string; format: string; vctValues: string[] },
      DcqlCredentialQuery
    >({ id: "mdl", format: "mso_mdoc", vctValues: [VCT] });
    expect(refusalCode(() => assertDcqlProfile({ credentials: [mdoc] }))).toBe(
      "format_not_supported",
    );
  });
});

describe("credential format constants", () => {
  it("keeps mso_mdoc known but not verifiable", () => {
    // mdoc is a format identifier this package knows and declines, rather than
    // one it fails to recognize. The distinction is the whole reason
    // KNOWN_CREDENTIAL_FORMATS is a superset of VERIFIABLE_CREDENTIAL_FORMATS.
    expect(KNOWN_CREDENTIAL_FORMATS).toContain("mso_mdoc");
    expect(isKnownCredentialFormat("mso_mdoc")).toBe(true);
    expect(isVerifiableCredentialFormat("mso_mdoc")).toBe(false);
    expect(isVerifiableCredentialFormat("jwt_vc_json")).toBe(false);
    expect(isVerifiableCredentialFormat("ldp_vc")).toBe(false);
  });
});
