import { webLocksDouble } from "./__tests__/web-locks-double.js";
/** @vitest-environment jsdom */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvSet } from "./kv.js";
import {
  LOCAL_DEVICES_PATH,
  LocalDeviceError,
  isPendingDevice,
  readLocalDevices,
  removeLocalDevice,
  thisDeviceId,
  touchThisDevice,
  updateLocalDevice,
} from "./local-devices.js";
import { lockAllTombs, unlockTomb, writeFile } from "./vfs.js";

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
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
    locks: webLocksDouble(),
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

/** A record an earlier build let a person type in by hand: never seen. */
async function writeHandTyped(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const devices = [
    ...(await readLocalDevices(tomb)),
    {
      id,
      name,
      platform: "Linux",
      createdAt: "2026-09-27T00:00:00Z",
      lastSeenAt: "",
    },
  ];
  const file = { version: 1, revision: 1, devices };
  await writeFile(
    tomb,
    LOCAL_DEVICES_PATH,
    new TextEncoder().encode(JSON.stringify(file)),
  );
  return id;
}

describe("the browsers that opened the vault", () => {
  it("lists this browser when it opens the vault", async () => {
    const devices = await touchThisDevice(tomb);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(thisDeviceId());
    expect(devices[0]?.platform).toBe("Linux");
    expect(
      isPendingDevice(
        devices[0] ?? {
          id: "",
          name: "",
          platform: "",
          createdAt: "",
          lastSeenAt: "",
        },
      ),
    ).toBe(false);
  });

  it("leaves a full list full, and readable, when yet another browser opens the vault", async () => {
    for (let index = 0; index < 64; index += 1) {
      becomeAnotherBrowser();
      await touchThisDevice(tomb);
    }
    const late = becomeAnotherBrowser();
    const devices = await touchThisDevice(tomb);
    expect(devices).toHaveLength(64);
    expect(devices.some((device) => device.id === late)).toBe(false);
    expect(await readLocalDevices(tomb)).toHaveLength(64);
  });
});

describe("renaming a browser", () => {
  it("renames it and refuses a name that is empty or carries a control character", async () => {
    await touchThisDevice(tomb);
    const renamed = await updateLocalDevice(tomb, thisDeviceId(), {
      name: "  Desk  ",
    });
    expect(renamed[0]?.name).toBe("Desk");
    await expect(
      updateLocalDevice(tomb, thisDeviceId(), { name: " " }),
    ).rejects.toBeInstanceOf(LocalDeviceError);
    await expect(
      updateLocalDevice(tomb, thisDeviceId(), { name: "Bad\u0007" }),
    ).rejects.toBeInstanceOf(LocalDeviceError);
    await expect(
      updateLocalDevice(tomb, "nobody", { name: "x" }),
    ).rejects.toThrow("not in this vault");
  });
});

describe("removing a browser", () => {
  it("removes a hand-typed record an earlier build made, but never the browser you are on", async () => {
    await touchThisDevice(tomb);
    const typed = await writeHandTyped("Old tablet");
    const listed = await readLocalDevices(tomb);
    expect(listed.find((row) => row.id === typed)).toMatchObject({
      lastSeenAt: "",
    });
    const typedRow = listed.find((row) => row.id === typed);
    if (!typedRow) throw new Error("expected the hand-typed record");
    expect(isPendingDevice(typedRow)).toBe(true);
    expect(await removeLocalDevice(tomb, typed)).toHaveLength(1);
    await expect(removeLocalDevice(tomb, thisDeviceId())).rejects.toThrow(
      "cannot remove the device you are on",
    );
  });
});

describe("concurrent changes", () => {
  it("keeps every change when a touch, a rename and a removal race", async () => {
    await touchThisDevice(tomb);
    const typed = await writeHandTyped("Old tablet");
    await Promise.all([
      updateLocalDevice(tomb, thisDeviceId(), { name: "Work laptop" }),
      touchThisDevice(tomb),
      removeLocalDevice(tomb, typed),
    ]);
    const devices = await readLocalDevices(tomb);
    expect(devices.map((row) => row.name)).toEqual(["Work laptop"]);
  });
});
