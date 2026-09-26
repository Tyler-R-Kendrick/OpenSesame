import { describe, expect, it } from "vitest";
import {
  buildClaimLink,
  fragmentCarriesBearer,
  isClaimToken,
  readClaimLink,
} from "./claim-link.js";
import { buildCeremonyUrl } from "./interaction-url.js";

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

describe("complete claim link", () => {
  const TOKEN = "osc_clm_AbC-_1.s3cr3t-_";

  it("appends the bearer as a fragment to the built claim route", () => {
    const route = buildCeremonyUrl("https://app.example/OpenSesame/", "claim");
    const link = buildClaimLink(route, TOKEN);
    expect(link).toBe(`https://app.example/OpenSesame/claim#token=${TOKEN}`);
    const parsed = new URL(link);
    // Nothing a server sees carries the bearer: no query, and a path that
    // is only the route.
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/OpenSesame/claim");
    expect(readClaimLink(parsed.hash)).toEqual({ kind: "claim", token: TOKEN });
  });

  it("works on a loopback dev origin", () => {
    const route = buildCeremonyUrl("http://localhost:5180", "claim");
    expect(buildClaimLink(route, TOKEN)).toBe(
      `http://localhost:5180/claim#token=${TOKEN}`,
    );
  });

  it("leaves the builder's refusal intact: a bearer never enters through it", () => {
    expect(() =>
      buildCeremonyUrl(`https://app.example/#token=${TOKEN}`, "claim"),
    ).toThrow();
  });

  it("adversarial: refuses a bearer that is not claim-shaped, without echoing it", () => {
    const route = "https://app.example/claim";
    for (const bad of [
      "",
      "osc_dlg_a.b",
      "osc_clm_a",
      `${TOKEN}&key=k`,
      `${TOKEN}#x`,
      "osc_clm_a.b c",
    ]) {
      expect(() => buildClaimLink(route, bad), bad).toThrow(
        "A claim link needs a claim bearer.",
      );
    }
  });

  it("adversarial: refuses anything but a bare claim route", () => {
    for (const route of [
      "not a url",
      "https://app.example/",
      "https://app.example/device",
      "https://app.example/claim/",
      "https://app.example/claimx",
      "https://app.example/claim?x=1",
      "https://app.example/claim?",
      "https://app.example/claim#",
      "https://app.example/claim#key=k",
      "https://u:p@app.example/claim",
    ]) {
      expect(() => buildClaimLink(route, TOKEN), route).toThrow(
        "A claim link needs a claim route URL.",
      );
    }
  });
});
