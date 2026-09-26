// @vitest-environment jsdom
/**
 * The `/guest` and `/delegate` aliases (ADR 0140 §1, D5, D12): each leaves
 * the address whole at boot and adds no authority path of its own — a
 * delegation link's bearer is Join's invite, taken by Join's capture, and a
 * guest arrival is a note the guest road reads once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  aliasAt,
  captureAliasArrivalFromPage,
  noteGuestArrival,
  peekGuestArrival,
  resetAliasArrivalForTests,
  takeGuestArrival,
} from "./ceremony-aliases.js";
import {
  resetCapturedInviteForTests,
  takeCapturedInvite,
} from "./join/invite.js";

const TOKEN = `osc_dlg_offer1.${"a".repeat(40)}`; // gitleaks:allow -- synthetic invite-shaped test vector

const address = () => `${location.pathname}${location.search}${location.hash}`;

afterEach(() => {
  history.replaceState(null, "", "/");
  resetAliasArrivalForTests();
  resetCapturedInviteForTests();
  configureHost(createTestHost());
});

describe("aliasAt", () => {
  it("names the spec's alias paths under the deployment base only", () => {
    expect(aliasAt("/guest", "/")).toBe("guest");
    expect(aliasAt("/delegate/", "/")).toBe("delegate");
    expect(aliasAt("/OpenSesame/guest", "/OpenSesame/")).toBe("guest");
    expect(aliasAt("/guest", "/OpenSesame/")).toBeNull();
    expect(aliasAt("/guests", "/")).toBeNull();
    expect(aliasAt("/claim", "/")).toBeNull();
  });
});

describe("/delegate", () => {
  it("hands the bearer to Join's capture and leaves the base", () => {
    history.replaceState(null, "", `/delegate#token=${TOKEN}`);
    expect(captureAliasArrivalFromPage()).toBe("delegate");
    expect(address()).toBe("/");
    expect(takeCapturedInvite()).toEqual({
      kind: "invite",
      invite: { token: TOKEN, endpoint: null },
    });
  });

  it("scrubs a fragment that is not an invite, and holds nothing", () => {
    history.replaceState(null, "", "/delegate#token=not-a-bearer&x=1");
    expect(captureAliasArrivalFromPage()).toBe("delegate");
    expect(address()).toBe("/");
    expect(takeCapturedInvite()).toBeNull();
  });

  it("refuses a bearer that arrived in the query", () => {
    history.replaceState(null, "", `/delegate?token=${TOKEN}`);
    captureAliasArrivalFromPage();
    expect(location.href).not.toContain("osc_dlg_");
    expect(takeCapturedInvite()).toEqual({ kind: "leaked" });
  });

  it("mints nothing: no request leaves the page (ADR 0140 D5)", () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    history.replaceState(null, "", `/delegate#token=${TOKEN}`);
    captureAliasArrivalFromPage();
    vi.unstubAllGlobals();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("/guest", () => {
  it("notes the arrival once and leaves the base, query and all", () => {
    history.replaceState(null, "", "/guest?code=abc#x");
    expect(captureAliasArrivalFromPage()).toBe("guest");
    expect(address()).toBe("/");
    expect(peekGuestArrival()).toBe(true);
    expect(takeGuestArrival()).toBe(true);
    expect(takeGuestArrival()).toBe(false);
  });

  it("forgets the arrival once the person acts", () => {
    noteGuestArrival();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(peekGuestArrival()).toBe(false);
    noteGuestArrival();
    window.dispatchEvent(new Event("pointerdown"));
    expect(peekGuestArrival()).toBe(false);
  });

  it("reads nothing on any other path", () => {
    history.replaceState(null, "", "/claim#token=osc_clm_pub.secret"); // gitleaks:allow -- synthetic claim-shaped test vector
    expect(captureAliasArrivalFromPage()).toBeNull();
    expect(location.hash).toBe("#token=osc_clm_pub.secret");
    expect(peekGuestArrival()).toBe(false);
  });
});
