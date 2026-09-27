/** @vitest-environment jsdom */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvSet } from "./kv.js";
import {
  LocalDeviceError,
  claimLocalDevice,
  isPendingDevice,
  readLocalDevices,
  registerLocalDevice,
  removeLocalDevice,
  thisDeviceId,
  touchThisDevice,
  updateLocalDevice,
} from "./local-devices.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

/** Open the vault as a different browser: a fresh this-device id. */
function becomeAnotherBrowser(): string {
  const id = crypto.randomUUID();
  kvSet("opensesame.this-device-id", id);
  return id;
}

let tomb: string;

beforeEach(async () => {
  tomb = `local-devices-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const result = queue.then(run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => {
      memory.clear();
    },
  });
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registering a device", () => {
  it("lists a registered device as not yet seen, beside this browser", async () => {
    await touchThisDevice(tomb);
    const devices = await registerLocalDevice(tomb, {
      name: "  Work laptop ",
      platform: "Windows",
    });
    const laptop = devices.find((row) => row.name === "Work laptop");
    expect(laptop).toMatchObject({ platform: "Windows", lastSeenAt: "" });
    expect(laptop && isPendingDevice(laptop)).toBe(true);
    expect(laptop?.id).not.toBe(thisDeviceId());
    expect(await readLocalDevices(tomb)).toHaveLength(2);
  });

  it("refuses an empty name, a control character or an unknown platform", async () => {
    await expect(
      registerLocalDevice(tomb, { name: "  ", platform: "Linux" }),
    ).rejects.toBeInstanceOf(LocalDeviceError);
    await expect(
      registerLocalDevice(tomb, { name: "Bad\u0007", platform: "Linux" }),
    ).rejects.toBeInstanceOf(LocalDeviceError);
    await expect(
      registerLocalDevice(tomb, { name: "Toaster", platform: "BeOS" }),
    ).rejects.toThrow("Choose the device's platform.");
    expect(await readLocalDevices(tomb)).toEqual([]);
  });

  it("keeps one slot free so an unlisted browser can still add itself", async () => {
    for (let index = 0; index < 63; index += 1)
      await registerLocalDevice(tomb, {
        name: `Device ${index}`,
        platform: "Linux",
      });
    await expect(
      registerLocalDevice(tomb, { name: "One more", platform: "Linux" }),
    ).rejects.toThrow("Remove one first.");
    const devices = await touchThisDevice(tomb);
    expect(devices).toHaveLength(64);
    expect(await readLocalDevices(tomb)).toHaveLength(64);
  });

  it("leaves a full list full, and readable, when yet another browser opens the vault", async () => {
    for (let index = 0; index < 63; index += 1)
      await registerLocalDevice(tomb, {
        name: `Device ${index}`,
        platform: "Linux",
      });
    await touchThisDevice(tomb);
    const late = becomeAnotherBrowser();
    const devices = await touchThisDevice(tomb);
    expect(devices).toHaveLength(64);
    expect(devices.some((device) => device.id === late)).toBe(false);
    // Before the cap, this read threw "The device list is not valid".
    expect(await readLocalDevices(tomb)).toHaveLength(64);
  });
});

describe("editing a device", () => {
  it("changes a pending device's platform but never a seen device's", async () => {
    await touchThisDevice(tomb);
    const registered = await registerLocalDevice(tomb, {
      name: "Phone",
      platform: "Android",
    });
    const phone = registered.find((row) => row.name === "Phone");
    if (!phone) throw new Error("expected the registered phone");
    const edited = await updateLocalDevice(tomb, phone.id, {
      name: "Pocket phone",
      platform: "iOS",
    });
    expect(edited.find((row) => row.id === phone.id)).toMatchObject({
      name: "Pocket phone",
      platform: "iOS",
    });
    const mine = await updateLocalDevice(tomb, thisDeviceId(), {
      name: "Desk",
      platform: "Windows",
    });
    expect(mine.find((row) => row.id === thisDeviceId())).toMatchObject({
      name: "Desk",
      platform: "Linux",
    });
  });
});

describe("claiming a registration", () => {
  it("binds the registration to this browser and folds in its own record", async () => {
    await touchThisDevice(tomb);
    const registered = await registerLocalDevice(tomb, {
      name: "Work laptop",
      platform: "Windows",
    });
    const laptop = registered.find((row) => row.name === "Work laptop");
    if (!laptop) throw new Error("expected the registered laptop");
    const devices = await claimLocalDevice(tomb, laptop.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: thisDeviceId(),
      name: "Work laptop",
      platform: "Linux",
      createdAt: laptop.createdAt,
    });
    expect(devices[0] && isPendingDevice(devices[0])).toBe(false);
  });

  it("refuses a device that has already opened the vault", async () => {
    await touchThisDevice(tomb);
    await expect(claimLocalDevice(tomb, thisDeviceId())).rejects.toThrow(
      "already opened this vault",
    );
    await expect(claimLocalDevice(tomb, "missing")).rejects.toThrow(
      "not in this vault",
    );
  });
});

describe("removing a device", () => {
  it("removes a registration but never the device you are on", async () => {
    await touchThisDevice(tomb);
    const registered = await registerLocalDevice(tomb, {
      name: "Old tablet",
      platform: "Android",
    });
    const tablet = registered.find((row) => row.name === "Old tablet");
    if (!tablet) throw new Error("expected the registered tablet");
    expect(await removeLocalDevice(tomb, tablet.id)).toHaveLength(1);
    await expect(removeLocalDevice(tomb, thisDeviceId())).rejects.toThrow(
      "cannot remove the device you are on",
    );
  });
});

describe("concurrent changes", () => {
  it("keeps every change when a touch, a registration and a claim race", async () => {
    await touchThisDevice(tomb);
    const registered = await registerLocalDevice(tomb, {
      name: "Work laptop",
      platform: "Windows",
    });
    const laptop = registered.find((row) => row.name === "Work laptop");
    if (!laptop) throw new Error("expected the registered laptop");
    await Promise.all([
      claimLocalDevice(tomb, laptop.id),
      touchThisDevice(tomb),
      registerLocalDevice(tomb, { name: "Phone", platform: "Android" }),
    ]);
    const devices = await readLocalDevices(tomb);
    expect(devices.map((row) => row.name).sort()).toEqual([
      "Phone",
      "Work laptop",
    ]);
    expect(devices.find((row) => row.id === thisDeviceId())?.name).toBe(
      "Work laptop",
    );
  });
});
