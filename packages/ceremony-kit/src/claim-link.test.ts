import { describe, expect, it } from "vitest";
import {
  fragmentCarriesBearer,
  isClaimToken,
  readClaimLink,
} from "./claim-link.js";

describe("claim link", () => {
  it("reads token and key together as a drop, and only together", () => {
    expect(readClaimLink("#token=osc_clm_a.b&key=k1_-")).toEqual({
      kind: "drop",
      token: "osc_clm_a.b",
      key: "k1_-",
    });
    expect(readClaimLink("#key=k1_-")).toBeNull();
    expect(readClaimLink("")).toBeNull();
  });

  it("reads a bearer alone as an ownership claim", () => {
    expect(readClaimLink("#token=osc_clm_hash.secret")).toEqual({
      kind: "claim",
      token: "osc_clm_hash.secret",
    });
    expect(readClaimLink("token=osc_clm_hash.secret")).toEqual({
      kind: "claim",
      token: "osc_clm_hash.secret",
    });
    expect(readClaimLink("#token=osc_clm_a.b&key=")).toEqual({
      kind: "claim",
      token: "osc_clm_a.b",
    });
  });

  it("adversarial: a bearer that is not claim-shaped is not a claim link", () => {
    for (const hash of [
      "#other=1",
      "#token=",
      "#token=osc_dlg_a.b",
      "#token=osc_clm_",
      "#token=osc_clm_a.",
      "#token=osc_clm_a b.c",
      "#token=osc_clm_nodot&key=k",
    ]) {
      expect(readClaimLink(hash), hash).toBeNull();
    }
  });

  it("scrubs any fragment that carries a bearer or a key, well formed or not", () => {
    expect(fragmentCarriesBearer("#token=osc_clm_a.b")).toBe(true);
    expect(fragmentCarriesBearer("#token=garbage")).toBe(true);
    expect(fragmentCarriesBearer("#key=k")).toBe(true);
    expect(fragmentCarriesBearer("#other=1")).toBe(false);
    expect(fragmentCarriesBearer("")).toBe(false);
  });

  it("recognises the server's bearer shape", () => {
    expect(isClaimToken("osc_clm_AbC-_1.s3cr3t-_")).toBe(true);
    expect(isClaimToken("osc_clm_x")).toBe(false);
    expect(isClaimToken(" osc_clm_a.b")).toBe(false);
  });
});
