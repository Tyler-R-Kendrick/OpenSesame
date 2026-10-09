/**
 * Drops with no remote Identity API (ADR 0118): the sender's transport —
 * `createDropSession` / `pollDrop` through `identityFetch` — must land on the
 * device-native claim plane, so `shareOnce` works for a guest vault with no
 * sign-in service configured. The recipient side is `local-drop-claims`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "../capabilities.js";
import { resetDeviceIdentitySessionsForTests } from "../device-identity-host.js";
import { isDeviceIdentityMode } from "../device-identity.js";
import { clearSession } from "../identity.js";
import { saveSettings } from "../settings.js";
import { createDropSession, dropSeams, pollDrop, sealDrop } from "./drop.js";
import {
  localDropClaimSeams,
  presentLocalDropClaim,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";

const originals = { ...dropSeams };
const claimBaseOriginal = localDropClaimSeams.claimBase;

beforeEach(() => {
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: defaultCapabilityConnectors(),
  });
  clearSession();
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
  // The claim host a link names; node has no page origin to derive one from.
  dropSeams.claimBase = () => "http://localhost:5180/OpenSesame";
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

afterEach(() => {
  Object.assign(dropSeams, originals);
  localDropClaimSeams.claimBase = claimBaseOriginal;
  clearSession();
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
});

describe("drop transport on the device-native Identity plane", () => {
  it("creates and polls a drop claim with no remote service", async () => {
    expect(isDeviceIdentityMode()).toBe(true);
    const { manifest } = await sealDrop({
      kind: "text",
      name: "api-token",
      text: "s3cr3t",
    });
    const session = await createDropSession(manifest, 600_000);
    expect(session.bearerToken.startsWith(`osc_clm_${session.claimId}.`)).toBe(
      true,
    );
    expect(session.verifyUrl).toBe("http://localhost:5180/OpenSesame/claim");
    expect(session.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    await expect(pollDrop(session.claimId, session.bearerToken)).resolves.toBe(
      "pending",
    );

    // The recipient's one presentation burns it, on this same device plane.
    await presentLocalDropClaim(session.bearerToken, session.userCode);
    await expect(pollDrop(session.claimId, session.bearerToken)).resolves.toBe(
      "consumed",
    );
  });
});
