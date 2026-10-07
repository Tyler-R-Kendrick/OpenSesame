/**
 * Unit coverage for post-match unlock continue (INV-03 / INV-05).
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { WrongPasswordError, createItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  continueAfterDuressMatch,
  duressContinueSeams,
  resolveDuressPresentation,
} from "../../../screens/unlock/unlock-duress-continue.js";
import { UNLOCK_PIN_MISS } from "../../../screens/unlock/unlock-duress-refuse.js";

import { kvDelete, kvGet } from "../../kv.js";
import { VaultStore } from "../../vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { clearActivePresentation } from "../compartment/presentation-runtime.js";
import { HOUR_MS, readHold } from "../hold/record.js";
import { encodePlan } from "../settings/modes/payload.js";
import { HOLD_KEY } from "../store/boot-keys.js";

function continueMatch(presentation: string, profileId = "p-test") {
  return {
    profileId,
    plaintext: {
      compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
      actionCapability: null,
      presentation,
    },
  };
}

describe("resolveDuressPresentation", () => {
  it("keeps every closed presentation class", () => {
    for (const value of [
      "normal",
      "restricted",
      "decoy",
      "locked",
      "unchanged",
    ] as const) {
      expect(resolveDuressPresentation(value)).toBe(value);
    }
  });

  it("maps unknown values to restricted", () => {
    expect(resolveDuressPresentation("not-a-real-class")).toBe("restricted");
    expect(resolveDuressPresentation("")).toBe("restricted");
  });
});

describe("unlock duress continue", () => {
  it("opens guest for decoy presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const cancelTotpChallenge = vi.fn();
    const match = continueMatch("decoy");
    const result = await continueAfterDuressMatch(
      { createGuest, cancelTotpChallenge },
      match,
      UNLOCK_PIN_MISS,
    );
    expect(result).toBe("duress_session");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(cancelTotpChallenge).toHaveBeenCalledOnce();
    expect([...match.plaintext.compartmentKey]).toEqual(Array(32).fill(0));
  });

  it("looks like a wrong secret for locked presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const match = continueMatch("locked");
    match.plaintext.compartmentKey.fill(7);
    await expect(
      continueAfterDuressMatch({ createGuest }, match, UNLOCK_PIN_MISS),
    ).rejects.toSatisfy(
      (err: BoundaryValue) =>
        err instanceof WrongPasswordError && err.message === UNLOCK_PIN_MISS,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect([...match.plaintext.compartmentKey]).toEqual(Array(32).fill(0));
  });

  it("mints admitted keys with default compartment ref and epoch", async () => {
    const { readActivePresentation, clearActivePresentation } = await import(
      "../compartment/presentation-runtime.js"
    );
    clearActivePresentation();
    const createGuest = vi.fn(async () => undefined);
    await continueAfterDuressMatch(
      { createGuest },
      continueMatch("decoy", "p-mint"),
      UNLOCK_PIN_MISS,
    );
    const active = readActivePresentation();
    expect(active?.profileId).toBe("p-mint");
    expect(active?.outcome.session.contextId).toMatch(/^duress:p-mint:/);
    expect(active?.outcome.session.admitted).toHaveLength(1);
    expect(active?.outcome.session.admitted[0]?.compartmentRef).toBe(
      "compartment:p-mint",
    );
    expect(active?.outcome.session.admitted[0]?.keyEpoch).toBe(1);
    expect(active?.outcome.session.suppressSensitiveLabels).toBe(true);
  });
});

it("sets presentation runtime for decoy and clears on locked", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  clearActivePresentation();
  const createGuest = vi.fn(async () => undefined);
  await continueAfterDuressMatch(
    { createGuest },
    continueMatch("decoy", "p-decoy"),
    UNLOCK_PIN_MISS,
  );
  const active = readActivePresentation();
  expect(active?.profileId).toBe("p-decoy");
  expect(active?.outcome.kind).toBe("locked");
  expect(active?.view.locked).toBe(true);

  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("locked"),
      UNLOCK_PIN_MISS,
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(readActivePresentation()).toBeNull();
});

it("treats unchanged like a wrong secret", async () => {
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("unchanged"),
      UNLOCK_PIN_MISS,
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(createGuest).not.toHaveBeenCalled();
});

it("opens guest for normal and restricted presentations", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  for (const presentation of ["normal", "restricted"] as const) {
    clearActivePresentation();
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch(presentation),
        UNLOCK_PIN_MISS,
      ),
    ).resolves.toBe("duress_session");
    expect(createGuest, presentation).toHaveBeenCalledOnce();
    expect(
      readActivePresentation()?.outcome.session.suppressSensitiveLabels,
      presentation,
    ).toBe(presentation !== "normal");
  }
});

it("unknown presentation maps to restricted guest continue", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  clearActivePresentation();
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("not-a-real-class"),
      UNLOCK_PIN_MISS,
    ),
  ).resolves.toBe("duress_session");
  expect(createGuest).toHaveBeenCalledOnce();
  expect(
    readActivePresentation()?.outcome.session.suppressSensitiveLabels,
  ).toBe(true);
});

const realStores = new Set<VaultStore>();
afterEach(async () => {
  vi.restoreAllMocks();
  clearActivePresentation();
  for (const store of realStores) store.lock();
  realStores.clear();
  await vfsFlush();
  kvDelete(HOLD_KEY);
});

it("records the owner's freeze before refusing, with the original effect host", async () => {
  kvDelete(HOLD_KEY);
  const store = new VaultStore();
  realStores.add(store);
  const effects = vi.spyOn(duressContinueSeams, "runEffects");
  const before = Date.now();
  await expect(
    continueAfterDuressMatch(
      store,
      {
        ...continueMatch("locked"),
        plaintext: {
          ...continueMatch("locked").plaintext,
          payload: encodePlan({ effect: "freeze", body: { hours: 1 } }),
        },
      },
      UNLOCK_PIN_MISS,
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  const hold = readHold();
  expect(hold?.setAt).toBeGreaterThanOrEqual(before);
  expect(hold?.until).toBe(hold ? hold.setAt + HOUR_MS : -1);
  expect(effects).toHaveBeenCalledOnce();
  expect(effects.mock.calls[0]?.[2].store).toBe(store);
  expect(store.getSnapshot().status).not.toBe("unlocked");
});

it("populates a fresh decoy while preserving the sealed guest and its PIN", async () => {
  for (const path of [HEADER_PATH, BODY_PATH])
    kvDelete(tombFileKey(GUEST_TOMB, path));
  const store = new VaultStore();
  realStores.add(store);
  await store.createGuest();
  await store.enrollPin("48291037");
  await store.saveItem(createItem("note", "Owner-only saved note"));
  await store.flushPendingWrites();
  store.lock();
  await vfsFlush();
  const header = kvGet(tombFileKey(GUEST_TOMB, HEADER_PATH));
  const body = kvGet(tombFileKey(GUEST_TOMB, BODY_PATH));
  expect(header).not.toBeNull();
  expect(body).not.toBeNull();
  const matched = continueMatch("decoy");
  await continueAfterDuressMatch(
    store,
    {
      ...matched,
      plaintext: {
        ...matched.plaintext,
        payload: encodePlan({
          effect: "decoy_items",
          body: {
            items: [
              {
                title: "Planted library account",
                secret: "synthetic-only-password",
              },
              {
                title: "Planted gym account",
                secret: "synthetic-only-password-two",
              },
              {
                title: "Planted media account",
                secret: "synthetic-only-password-three",
              },
            ],
          },
        }),
      },
    },
    UNLOCK_PIN_MISS,
  );
  expect(
    store
      .getSnapshot()
      .items.some((item) => item.name === "Planted library account"),
  ).toBe(true);
  expect(
    store
      .getSnapshot()
      .items.some((item) => item.name === "Owner-only saved note"),
  ).toBe(false);
  await store.flushPendingWrites();
  await vfsFlush();
  expect(kvGet(tombFileKey(GUEST_TOMB, HEADER_PATH))).toBe(header);
  expect(kvGet(tombFileKey(GUEST_TOMB, BODY_PATH))).toBe(body);
  store.lock();
  await store.unlockWithPin("48291037");
  expect(
    store
      .getSnapshot()
      .items.some((item) => item.name === "Owner-only saved note"),
  ).toBe(true);
  expect(
    store
      .getSnapshot()
      .items.some((item) => item.name === "Planted library account"),
  ).toBe(false);
});
