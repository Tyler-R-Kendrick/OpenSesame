/**
 * MSAL's sessionStorage entries are the app's only when they name one of the
 * app's own Entra client ids: that store is shared by every same-origin page
 * the tab has shown, another site's MSAL among them.
 */

import { describe, expect, it } from "vitest";
import { msalKeyNamesClient } from "./storage-ownership-msal.js";
import { ownsWebStorageKey } from "./storage-ownership.js";

const OURS = "0f1e2d3c-aaaa-4bbb-8ccc-000000000001";
const THEIRS = "9a8b7c6d-dddd-4eee-8fff-000000000002";

describe("msalKeyNamesClient", () => {
  it.each([
    [`msal.${OURS}.request.params`, true],
    [`msal.${OURS}.interaction.status`, true],
    [`msal.3.token.keys.${OURS}`, true],
    [`msal.3|uid.utid|login.windows.net|idtoken|${OURS}|utid||`, true],
    [`server-telemetry-${OURS}`, true],
    [`server-telemetry|${OURS}`, true],
    [`appmetadata-login.windows.net-${OURS}`, true],
    [`appmetadata|login.windows.net|${OURS}`, true],
    [`throttling.${JSON.stringify({ clientId: OURS, authority: "a" })}`, true],
    // Upper case in the configuration still matches MSAL's lowercased keys.
    [`msal.3.token.keys.${OURS}`.toUpperCase(), true],
    // Another site's MSAL, and what names no client at all.
    [`msal.${THEIRS}.request.params`, false],
    [`msal.3.token.keys.${THEIRS}`, false],
    [`msal.3|uid.utid|login.windows.net|idtoken|${THEIRS}|utid||`, false],
    [`server-telemetry-${THEIRS}`, false],
    [`appmetadata-login.windows.net-${THEIRS}`, false],
    [`throttling.${JSON.stringify({ clientId: THEIRS })}`, false],
    ["throttling.not json", false],
    ["msal.3.account.keys", false],
    ["msal.3|uid.utid|login.windows.net|utid", false],
    ["msal.version", false],
    [`other.${OURS}`, false],
  ])("%s → %s", (key, owned) => {
    expect(msalKeyNamesClient(key, OURS.toUpperCase())).toBe(owned);
  });

  it("is never the app's without a client id to match", () => {
    expect(msalKeyNamesClient(`msal.${OURS}.request.params`, " ")).toBe(false);
    expect(ownsWebStorageKey(`msal.${OURS}.request.params`, "session")).toBe(
      false,
    );
  });

  it("is the app's in sessionStorage only, where the app configured MSAL", () => {
    const key = `msal.3.token.keys.${OURS}`;
    expect(ownsWebStorageKey(key, "session", [OURS])).toBe(true);
    expect(ownsWebStorageKey(key, "local", [OURS])).toBe(false);
  });
});
