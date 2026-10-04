/**
 * The device identity key through a tailnet drive (ADR 0160 §5, ADR 0144):
 * two devices syncing one vault are one principal; two that each minted a key
 * before they met converge on the older, the loser's sessions end, and the
 * person is told.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import {
  createItem,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { deviceIdentityFetch } from "../device-identity-host.js";
import { readDeviceIdentityKey } from "../device-identity-key.js";
import { deviceVaultSeams } from "../device-identity-vault.js";
import { clearNotices, listNotices } from "../notices.js";
import { installDeviceKeyCarrier } from "../vault/store-device-key.js";
import { adoptSnapshot } from "./adopt.js";
import { type Device, as, device } from "./devices.fixture.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";

const PASSWORD = "correct horse battery staple";
const TOMB = "personal";
const carrier = { ...deviceKeyCarrier };
const view = deviceVaultSeams.view;
let clock = Date.parse("2026-09-01T00:00:00.000Z");

function tick(): void {
  clock += 60_000;
  vi.setSystemTime(clock);
}

/** Act as `on`, with the device host reading that device's vault and body. */
function acting<T>(on: Device, act: () => Promise<T>): Promise<T> {
  return as(on, async () => {
    installDeviceKeyCarrier(() => on.store.bodyPort());
    deviceVaultSeams.view = () => ({
      kind: "unlocked",
      tomb: TOMB,
      guest: false,
    });
    return act();
  });
}

const principalOf = (on: Device) =>
  acting(on, async () => (await readDeviceIdentityKey(TOMB))?.principalId);

async function connect(
  on: Device,
): Promise<{ principalId: string; token: string }> {
  return acting(on, async () => {
    const res = await deviceIdentityFetch("/v1/principals/provisional", {
      method: "POST",
      body: "{}",
    });
    const body = overlapCast(await res.json());
    return {
      principalId: String(body.principalId),
      token: String(body.accessToken),
    };
  });
}

function whoAmI(on: Device, token: string): Promise<Response> {
  return acting(on, () =>
    deviceIdentityFetch("/v1/principals/me", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
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
      const field = on.store.bodyPort().body().deviceIdentityKey;
      expect(readDeviceIdentityKeyRecord(field ?? {})?.keyId).toBe(keyId);
    }
  });
});
