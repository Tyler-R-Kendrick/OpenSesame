// @vitest-environment jsdom
/**
 * The device route's address: `/device?user_code=`, the legacy shapes
 * `spec/config/ceremony-routes.json` lists, and what Pages must never read as
 * one — a sign-in callback's `?code=` at the base.
 */
import { LEGACY_LINKS } from "@opensesame/ceremony-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureDeviceLinkFromPage,
  devicePath,
  peekDeviceArrival,
  readDeviceLink,
  resetDeviceArrivalForTests,
  takeDeviceArrival,
  userCodeFromEntry,
} from "./device-link.js";

const BASE = "/OpenSesame/";
const ORIGIN = "https://tyler-r-kendrick.github.io";
const at = (path: string) => `${ORIGIN}${path}`;

afterEach(() => {
  history.replaceState(null, "", "/");
  resetDeviceArrivalForTests();
});

describe("readDeviceLink", () => {
  it("reads the canonical route under the base and replaces it bare", () => {
    expect(
      readDeviceLink(at("/OpenSesame/device?user_code=abcd-efgh"), BASE),
    ).toEqual({
      arrival: { kind: "code", userCode: "ABCD-EFGH" },
      address: "/OpenSesame/device",
    });
    expect(devicePath(BASE)).toBe("/OpenSesame/device");
    expect(devicePath("/")).toBe("/device");
  });

  it("takes a trailing slash and a claim id beside the code with it", () => {
    expect(
      readDeviceLink(
        at("/OpenSesame/device/?user_code=ABCD-EFGH&claim_id=clm_9#x"),
        BASE,
      ),
    ).toEqual({
      arrival: { kind: "code", userCode: "ABCD-EFGH" },
      address: "/OpenSesame/device",
    });
  });

  it("reads mobile-MFA's ?code= alias on the device route only", () => {
    expect(
      readDeviceLink(at("/OpenSesame/device?code=ABCD-EFGH"), BASE).arrival,
    ).toEqual({ kind: "code", userCode: "ABCD-EFGH" });
  });

  it("never reads a sign-in callback's ?code= at the base", () => {
    for (const href of [
      at("/OpenSesame/?code=abc123&state=xyz"),
      at("/OpenSesame/?code=ABCD-EFGH"),
      at("/OpenSesame/?user_code=ABCD-EFGH&code=abc"),
      at("/OpenSesame/?error=access_denied&user_code=ABCD-EFGH"),
    ]) {
      expect(readDeviceLink(href, BASE), href).toEqual({
        arrival: { kind: "none" },
        address: null,
      });
    }
  });

  it("opens the route from the legacy ?user_code= at the base", () => {
    expect(
      readDeviceLink(at("/OpenSesame/?user_code=ABCD-EFGH"), BASE),
    ).toEqual({
      arrival: { kind: "code", userCode: "ABCD-EFGH" },
      address: "/OpenSesame/device",
    });
    expect(
      readDeviceLink(at("/OpenSesame?user_code=WXYZ"), BASE).arrival,
    ).toEqual({ kind: "code", userCode: "WXYZ" });
  });

  it("reads the custom schemes the spec lists, and no other route on them", () => {
    expect(
      readDeviceLink("opensesame://invoke/mfa?user_code=ABCD-EFGH", BASE),
    ).toEqual({
      arrival: { kind: "code", userCode: "ABCD-EFGH" },
      address: "/OpenSesame/device",
    });
    expect(
      readDeviceLink(
        "opensesame-mfa://approve?user_code=abcd&claim_id=c1",
        BASE,
      ).arrival,
    ).toEqual({ kind: "code", userCode: "ABCD" });
    expect(
      readDeviceLink("opensesame://elsewhere?user_code=ABCD", BASE),
    ).toEqual({ arrival: { kind: "none" }, address: null });
    expect(LEGACY_LINKS.links.map((link) => link.scheme).sort()).toEqual([
      "http",
      "https",
      "opensesame",
      "opensesame-mfa",
    ]);
  });

  it("refuses credential material and a code that cannot be one, and scrubs both", () => {
    for (const href of [
      at("/OpenSesame/device?user_code=ABCD&access_token=leak"),
      at("/OpenSesame/device?user_code=ABCD#token=osc_clm_leak"),
      at("/OpenSesame/device?user_code=%3Cscript%3E"),
      at("/OpenSesame/?user_code=not%20a%20code"),
      "opensesame-mfa://approve?user_code=ABCD&id_token=leak",
    ]) {
      expect(readDeviceLink(href, BASE), href).toEqual({
        arrival: { kind: "refused" },
        address: "/OpenSesame/device",
      });
    }
  });

  it("leaves every other address alone", () => {
    for (const href of [
      at("/OpenSesame/vault?user_code=ABCD"),
      at("/OpenSesame/identity/device?user_code=ABCD"),
      at("/elsewhere/device?user_code=ABCD"),
      at("/OpenSesame/i/i_AbCdEfGh.0123456789abcdef?user_code=ABCD"),
      "not a url",
    ]) {
      expect(readDeviceLink(href, BASE), href).toEqual({
        arrival: { kind: "none" },
        address: null,
      });
    }
  });

  it("opens the bare route with nothing, and cleans a stray fragment", () => {
    expect(readDeviceLink(at("/OpenSesame/device"), BASE)).toEqual({
      arrival: { kind: "none" },
      address: null,
    });
    expect(readDeviceLink(at("/OpenSesame/device#x"), BASE)).toEqual({
      arrival: { kind: "none" },
      address: "/OpenSesame/device",
    });
  });
});

describe("userCodeFromEntry", () => {
  it("upper-cases a typed code and reads a pasted legacy link", () => {
    expect(userCodeFromEntry("  abcd-efgh ")).toBe("ABCD-EFGH");
    expect(
      userCodeFromEntry("opensesame-mfa://approve?user_code=wxyz-1234"),
    ).toBe("WXYZ-1234");
    expect(
      userCodeFromEntry("https://ceremonies.example/device?user_code=QRST"),
    ).toBe("QRST");
  });

  it("gives nothing for a pasted link carrying credential material", () => {
    expect(
      userCodeFromEntry("https://x.example/?user_code=ABCD&access_token=t"),
    ).toBe("");
  });
});

describe("captureDeviceLinkFromPage", () => {
  it("takes the code out of the address and holds it for the route", () => {
    history.replaceState(null, "", "/device?user_code=ABCD-EFGH");
    expect(captureDeviceLinkFromPage()).toEqual({
      kind: "code",
      userCode: "ABCD-EFGH",
    });
    expect(`${location.pathname}${location.search}`).toBe("/device");
    // A second read of the clean address keeps what is waiting.
    expect(captureDeviceLinkFromPage()).toEqual({ kind: "none" });
    expect(peekDeviceArrival()).toEqual({
      kind: "code",
      userCode: "ABCD-EFGH",
    });
    expect(takeDeviceArrival()).toEqual({
      kind: "code",
      userCode: "ABCD-EFGH",
    });
    expect(takeDeviceArrival()).toEqual({ kind: "none" });
  });

  it("leaves a sign-in callback where the router will find it", () => {
    history.replaceState(null, "", "/?code=abc&state=xyz");
    expect(captureDeviceLinkFromPage()).toEqual({ kind: "none" });
    expect(location.search).toBe("?code=abc&state=xyz");
  });
});
