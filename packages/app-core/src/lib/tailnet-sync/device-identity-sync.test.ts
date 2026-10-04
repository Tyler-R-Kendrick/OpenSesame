/**
 * The device identity key through a tailnet drive (ADR 0160 §5, ADR 0144):
 * two devices syncing one vault are one principal; two that each minted a key
 * before they met converge on the older, the loser's sessions end, and the
 * person is told.
 */

/** @vitest-environment jsdom */
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  createItem,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineField } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { deviceVaultSeams } from "../device-identity-vault.js";
import { clearNotices, listNotices } from "../notices.js";
import { bodyPortOf } from "../vault/store-device-key.js";
import { adoptSnapshot } from "./adopt.js";
import { as, device } from "./devices.fixture.js";
import { memoryDrive } from "./drive.fixture.js";
import {
  PASSWORD,
  acting,
  connect,
  principalOf,
  sync,
  whoAmI,
} from "./identity-devices.fixture.js";

const carrier = { ...deviceKeyCarrier };
const view = deviceVaultSeams.view;
let clock = Date.parse("2026-09-01T00:00:00.000Z");

function tick(): void {
  clock += 60_000;
  vi.setSystemTime(clock);
}

/** A laptop with a vault; the phone is set up from the drive and opens it. */
async function pair(mintOnLaptopFirst: boolean) {
  const drive = memoryDrive();
  const laptop = device("laptop");
  const phone = device("phone");
  await as(laptop, async () => {
    await laptop.store.create(PASSWORD);
    await laptop.store.saveItem(createItem("note", "bank"));
  });
  if (mintOnLaptopFirst) await connect(laptop);
  await sync(laptop, drive);
  const snapshot = drive.snapshot;
  if (!snapshot) throw new Error("the laptop did not fill the drive");
  await as(phone, async () => {
    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    phone.store.rehydrate();
    await phone.store.unlock(PASSWORD);
  });
  return { drive, laptop, phone };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  clearNotices();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(deviceKeyCarrier, carrier);
  deviceVaultSeams.view = view;
  clearNotices();
});

describe("two devices syncing one vault", () => {
  it("are one principal: the key came with the vault", async () => {
    const { laptop, phone } = await pair(true);
    const laptopPrincipal = await principalOf(laptop);
    expect(laptopPrincipal).toMatch(/^prn_/);
    expect(await principalOf(phone)).toBe(laptopPrincipal);
    // The phone minted nothing of its own: it opened the vault and adopted.
    expect((await connect(phone)).principalId).toBe(laptopPrincipal);
    expect(listNotices()).toEqual([]);
  });

  it("keep their session bearers per device: the principal is shared, the bearer is not", async () => {
    const { laptop, phone } = await pair(true);
    const onLaptop = await connect(laptop);
    const onPhone = await connect(phone);
    expect(onLaptop.principalId).toBe(onPhone.principalId);
    expect(onLaptop.token).not.toBe(onPhone.token);
  });

  it("carries a key minted after the first sync on the next one", async () => {
    const { drive, laptop, phone } = await pair(false);
    expect(await principalOf(phone)).toBeUndefined();
    tick();
    const minted = await connect(laptop);
    await sync(laptop, drive);
    await sync(phone, drive);
    expect(await principalOf(phone)).toBe(minted.principalId);
  });
});

describe("two devices that each minted a key before they met", () => {
  /** Laptop minted first (older), phone second (newer), neither has synced since. */
  async function bothMinted() {
    const { drive, laptop, phone } = await pair(false);
    tick();
    const onLaptop = await connect(laptop);
    tick();
    const onPhone = await connect(phone);
    expect(onLaptop.principalId).not.toBe(onPhone.principalId);
    return { drive, laptop, phone, onLaptop, onPhone };
  }

  it("converge on the older key, whichever device syncs first", async () => {
    for (const phoneFirst of [false, true]) {
      clearNotices();
      const { drive, laptop, phone, onLaptop } = await bothMinted();
      const order = phoneFirst
        ? [phone, laptop, phone]
        : [laptop, phone, laptop];
      for (const on of order) await sync(on, drive);
      expect(await principalOf(laptop)).toBe(onLaptop.principalId);
      expect(await principalOf(phone)).toBe(onLaptop.principalId);
      clock += 3_600_000;
    }
  });

  it("ends the newer key's sessions, tells its device, and leaves the other alone", async () => {
    const { drive, laptop, phone, onLaptop, onPhone } = await bothMinted();
    await sync(laptop, drive);
    await sync(phone, drive);
    expect((await whoAmI(phone, onPhone.token)).status).toBe(401);
    expect((await whoAmI(laptop, onLaptop.token)).status).toBe(200);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]?.title).toBe("Device identity changed");
    // A new session on the phone is the laptop's principal.
    expect((await connect(phone)).principalId).toBe(onLaptop.principalId);
  });

  it("leaves the body each device holds carrying the winner", async () => {
    const { drive, laptop, phone, onLaptop } = await bothMinted();
    await sync(laptop, drive);
    await sync(phone, drive);
    await sync(laptop, drive);
    const keyId = onLaptop.principalId.slice("prn_".length);
    for (const on of [laptop, phone]) {
      const field = bodyPortOf(on.store).body().deviceIdentityKey;
      expect(readDeviceIdentityKeyRecord(field ?? {})?.keyId).toBe(keyId);
    }
  });
});

describe("a body that carries something that is not a key", () => {
  /** Looks like a key, claims the oldest possible time, and is not genuine. */
  async function forgery(): Promise<JsonObject> {
    return { ...(await genuineField(1)), keyId: "F".repeat(43) };
  }

  const poisons: (readonly [string, () => Promise<BoundaryValue>])[] = [
    ["a forged record with the oldest possible time", forgery],
    ["null", async () => null],
    ["a string", async () => "a key"],
  ];

  it.each(poisons)(
    "never wins a merge and does not outlive it: %s",
    async (_name, make) => {
      const { drive, laptop, phone } = await pair(true);
      const genuine = await principalOf(laptop);
      const poison = await make();
      await acting(laptop, () =>
        bodyPortOf(laptop.store).mutate((body) => {
          // The body is JSON from anywhere: put in it whatever the test names.
          Object.assign(body, { deviceIdentityKey: poison });
        }),
      );
      await sync(laptop, drive);
      await sync(phone, drive);
      await sync(laptop, drive);
      // Neither device lost its principal, and neither was left unreadable.
      expect(await principalOf(laptop)).toBe(genuine);
      expect(await principalOf(phone)).toBe(genuine);
      for (const on of [laptop, phone]) {
        const field = bodyPortOf(on.store).body().deviceIdentityKey;
        expect(readDeviceIdentityKeyRecord(field ?? {})?.keyId).toBe(
          genuine?.slice("prn_".length),
        );
      }
      expect(listNotices()).toEqual([]);
    },
  );

  it("does not leave a device with no tomb key unreadable for ever", async () => {
    const { drive, laptop } = await pair(false);
    const late = device("late-phone");
    await acting(laptop, () =>
      bodyPortOf(laptop.store).mutate((body) => {
        body.deviceIdentityKey = {
          version: 1,
          keyId: "F".repeat(43),
          createdAt: 1,
        };
      }),
    );
    await sync(laptop, drive);
    const snapshot = drive.snapshot;
    if (!snapshot) throw new Error("the drive is empty");
    await as(late, async () => {
      await adoptSnapshot(snapshot);
      late.store.rehydrate();
      await late.store.unlock(PASSWORD);
    });
    // Nothing carried is a key, so the phone mints its own instead of failing.
    expect(await connect(late)).toMatchObject({
      principalId: expect.stringMatching(/^prn_[A-Za-z0-9_-]{43}$/),
    });
  });
});
