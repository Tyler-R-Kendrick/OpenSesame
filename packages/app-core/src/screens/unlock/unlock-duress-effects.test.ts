/**
 * The seam in the unlock path: a matched code's plan runs before anything is
 * shown or refused, and its second phase runs once a decoy session exists.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePlan } from "../../lib/duress/settings/modes/payload.js";
import {
  continueAfterDuressMatch,
  duressContinueSeams,
} from "./unlock-duress-continue.js";
import { UNLOCK_PIN_MISS } from "./unlock-duress-refuse.js";

const calls: string[] = [];
const shipped = duressContinueSeams.runEffects;

function match(presentation: string, payload?: Uint8Array) {
  const slot = {
    compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
    actionCapability: null,
    presentation,
  };
  return {
    profileId: "p",
    plaintext: payload ? { ...slot, payload } : slot,
  };
}

beforeEach(() => {
  calls.length = 0;
  duressContinueSeams.runEffects = async (plan, phase) => {
    calls.push(`${phase}:${plan?.effect ?? "none"}`);
  };
});

afterEach(() => {
  duressContinueSeams.runEffects = shipped;
});

describe("continueAfterDuressMatch effects", () => {
  it("runs on_match before refusing a locked presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        match("locked", encodePlan({ effect: "freeze", body: {} })),
        UNLOCK_PIN_MISS,
      ),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(calls).toEqual(["on_match:freeze"]);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("runs on_match, then the session, then after_session for a decoy", async () => {
    const order: string[] = [];
    const createGuest = vi.fn(async () => {
      order.push("session");
    });
    await continueAfterDuressMatch(
      { createGuest },
      match("decoy", encodePlan({ effect: "decoy_items", body: {} })),
      UNLOCK_PIN_MISS,
    );
    expect(calls).toEqual([
      "on_match:decoy_items",
      "after_session:decoy_items",
    ]);
    expect(order).toEqual(["session"]);
  });

  it("reads no plan from a slot with no payload or one it cannot read", async () => {
    const createGuest = vi.fn(async () => undefined);
    await continueAfterDuressMatch(
      { createGuest },
      match("decoy"),
      UNLOCK_PIN_MISS,
    );
    await continueAfterDuressMatch(
      { createGuest },
      match("decoy", new TextEncoder().encode("garbage")),
      UNLOCK_PIN_MISS,
    );
    expect(calls).toEqual([
      "on_match:none",
      "after_session:none",
      "on_match:none",
      "after_session:none",
    ]);
  });
});
