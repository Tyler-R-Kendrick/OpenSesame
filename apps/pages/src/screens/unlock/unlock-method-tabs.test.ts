import { headerHolding as header } from "@opensesame/app-core/lib/vault/protection/held-wraps.test-support.js";
import { describe, expect, it } from "vitest";
import {
  fallbackUnlockMethod,
  unlockMethodTabs,
} from "./unlock-method-tabs.js";

describe("the tabs a first run seals with (ADR 0180)", () => {
  it("offers a passkey and a PIN, and never a password", () => {
    expect(
      unlockMethodTabs({ firstRun: true, header: null, passkeyOk: true }),
    ).toEqual(["passkey", "pin"]);
  });

  it("offers the PIN alone where the browser cannot make a passkey", () => {
    expect(
      unlockMethodTabs({ firstRun: true, header: null, passkeyOk: false }),
    ).toEqual(["pin"]);
  });

  it("opens on the passkey when it can be made, and on the PIN when it cannot", () => {
    const tabs = (passkeyOk: boolean) =>
      unlockMethodTabs({ firstRun: true, header: null, passkeyOk });
    expect(
      fallbackUnlockMethod({
        firstRun: true,
        header: null,
        passkeyOk: true,
        methods: tabs(true),
      }),
    ).toBe("passkey");
    expect(
      fallbackUnlockMethod({
        firstRun: true,
        header: null,
        passkeyOk: false,
        methods: tabs(false),
      }),
    ).toBe("pin");
  });
});

describe("the tabs a vault that already exists opens with", () => {
  it("still draws Password for a vault that holds a password wrap", () => {
    const tabs = unlockMethodTabs({
      firstRun: false,
      header: header({ password: true }),
      passkeyOk: true,
    });
    expect(tabs).toEqual(["password"]);
  });

  it("draws exactly the wraps the header holds, a password beside a passkey included", () => {
    expect(
      unlockMethodTabs({
        firstRun: false,
        header: header({ passkey: true, pin: true }),
        passkeyOk: true,
      }),
    ).toEqual(["passkey", "pin"]);
    expect(
      unlockMethodTabs({
        firstRun: false,
        header: header({ passkey: true, password: true }),
        passkeyOk: true,
      }),
    ).toEqual(expect.arrayContaining(["passkey", "password"]));
  });

  it("draws no Password for a vault that holds none", () => {
    expect(
      unlockMethodTabs({
        firstRun: false,
        header: header({ passkey: true }),
        passkeyOk: true,
      }),
    ).not.toContain("password");
  });
});
