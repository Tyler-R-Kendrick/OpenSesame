/**
 * Devices that have opened this vault — a machine inventory, not authenticators.
 *
 * Tailscale lists nodes; Entra lists registered devices. This is the same
 * kind of record: a browser (or PWA) that unlocked the tomb, named, last
 * seen, removable except for the one you are on. Passkeys stay on People.
 *
 * A device can also be registered before it has opened the vault — named
 * and given its platform here, the way an admin pre-registers a machine.
 * Such a record has never been seen (`lastSeenAt` is empty) until the
 * device itself opens the vault and claims it (`claimLocalDevice`), which
 * binds the record to that browser's id. A record is inventory: it grants
 * nothing, and removing one does not revoke the vault key a device holds.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { VaultCorruptError } from "@opensesame/vault-core";
import { lockManager, userAgent } from "../ports.js";
import { kvGet, kvRefresh, kvSet } from "./kv.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, vfsSeams, writeFile } from "./vfs.js";

export const LOCAL_DEVICES_PATH = "config/identity-devices";
const THIS_DEVICE_KEY = "opensesame.this-device-id";
const MAX_DEVICES = 64;
const MAX_BYTES = 64_000;

export class LocalDeviceError extends Error {
  readonly name = "LocalDeviceError";
}

export type LocalDevice = {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  /** Empty while a registered device has not yet opened the vault. */
  lastSeenAt: string;
};

/** The platforms `describePlatform` reports, in the order a form offers them. */
export const DEVICE_PLATFORMS = [
  "iOS",
  "Android",
  "macOS",
  "Windows",
  "Linux",
  "Unknown",
] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export function isDevicePlatform(value: string): value is DevicePlatform {
  return DEVICE_PLATFORMS.some((platform) => platform === value);
}

/**
 * The list holds as many devices as it can: a browser that opens the vault
 * unlisted now stays unlisted until one is removed.
 */
export function isDeviceListFull(devices: readonly LocalDevice[]): boolean {
  return devices.length >= MAX_DEVICES;
}

/** A device registered here that has not yet opened the vault itself. */
export function isPendingDevice(device: LocalDevice): boolean {
  return device.lastSeenAt === "";
}

type DeviceFile = {
  version: 1;
  revision: number;
  devices: LocalDevice[];
};

export function thisDeviceId(): string {
  const existing = kvGet(THIS_DEVICE_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const id = crypto.randomUUID();
  kvSet(THIS_DEVICE_KEY, id);
  return id;
}

export function describePlatform(ua = userAgent()): string {
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X/i.test(ua)) return "macOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

export function defaultDeviceName(ua = userAgent()): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${describePlatform(ua)}`;
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((ch) => ch.charCodeAt(0) < 32)
  );
}

function isDevice(value: BoundaryValue): value is LocalDevice {
  return (
    isJsonObject(value) &&
    isString(value.id) &&
    value.id.length <= 64 &&
    isString(value.name) &&
    validName(value.name) &&
    isString(value.platform) &&
    value.platform.length <= 32 &&
    isString(value.createdAt) &&
    isString(value.lastSeenAt)
  );
}

function parseFile(value: BoundaryValue): DeviceFile {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !isNumber(value.revision) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.devices) ||
    value.devices.length > MAX_DEVICES ||
    !value.devices.every(isDevice)
  ) {
    throw new LocalDeviceError(
      "The device list is not valid. Restore a backup.",
    );
  }
  return {
    version: 1,
    revision: value.revision,
    devices: value.devices,
  };
}

async function readFileOrEmpty(tomb: string): Promise<DeviceFile> {
  await kvRefresh(tombFileKey(tomb, LOCAL_DEVICES_PATH), 1_048_576);
  try {
    const bytes = await readFile(tomb, LOCAL_DEVICES_PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDeviceError("The device list is too large.");
    return parseFile(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") {
      return { version: 1, revision: 0, devices: [] };
    }
    if (
      error instanceof VaultCorruptError ||
      (error instanceof VfsError && error.code === "corrupt")
    ) {
      await vfsSeams.deleteRaw(tombFileKey(tomb, LOCAL_DEVICES_PATH));
      return { version: 1, revision: 0, devices: [] };
    }
    throw error;
  }
}

async function writeFileRecord(
  tomb: string,
  next: DeviceFile,
): Promise<LocalDevice[]> {
  const bytes = new TextEncoder().encode(JSON.stringify(next));
  if (bytes.length > MAX_BYTES)
    throw new LocalDeviceError("The device list is too large.");
  try {
    await writeFile(tomb, LOCAL_DEVICES_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
  return next.devices;
}

/**
 * Read, change and write the list inside one cross-tab lock, so a touch on
 * boot in one tab cannot overwrite a claim or a registration made in another.
 * `change` returns the next list, or `null` to leave the file as it is. A
 * browser without Web Locks still works — the list is inventory, and the
 * boot path must not fail over it — it simply runs unfenced.
 */
async function mutateDevices(
  tomb: string,
  change: (devices: LocalDevice[]) => LocalDevice[] | null,
): Promise<LocalDevice[]> {
  const run = async () => {
    const current = await readFileOrEmpty(tomb);
    const next = change(current.devices);
    if (next === null) return current.devices;
    return writeFileRecord(tomb, {
      version: 1,
      revision: current.revision + 1,
      devices: next,
    });
  };
  const locks = lockManager();
  return locks ? locks.request(`opensesame-devices-${tomb}`, run) : run();
}

export async function readLocalDevices(tomb: string): Promise<LocalDevice[]> {
  return (await readFileOrEmpty(tomb)).devices;
}

function thisDeviceRecord(id: string, now: string): LocalDevice {
  return {
    id,
    name: defaultDeviceName(),
    platform: describePlatform(),
    createdAt: now,
    lastSeenAt: now,
  };
}

/**
 * List this browser if it is not listed yet. A full list is left full: this
 * browser goes unlisted rather than writing a 65th entry the parser refuses.
 */
function withThisDevice(
  devices: LocalDevice[],
  id: string,
  now: string,
): LocalDevice[] | null {
  if (devices.length >= MAX_DEVICES) return null;
  return [...devices, thisDeviceRecord(id, now)];
}

export async function ensureThisDevice(tomb: string): Promise<LocalDevice[]> {
  const id = thisDeviceId();
  return mutateDevices(tomb, (devices) =>
    devices.some((device) => device.id === id)
      ? null
      : withThisDevice(devices, id, new Date().toISOString()),
  );
}

export async function touchThisDevice(tomb: string): Promise<LocalDevice[]> {
  const id = thisDeviceId();
  const now = new Date().toISOString();
  return mutateDevices(tomb, (devices) =>
    devices.some((device) => device.id === id)
      ? devices.map((device) =>
          device.id === id ? { ...device, lastSeenAt: now } : device,
        )
      : withThisDevice(devices, id, now),
  );
}

function checkedName(name: string): string {
  const trimmed = name.trim();
  if (!validName(trimmed))
    throw new LocalDeviceError("Use a name of 1–128 characters.");
  return trimmed;
}

function checkedPlatform(platform: string): DevicePlatform {
  if (!isDevicePlatform(platform))
    throw new LocalDeviceError("Choose the device's platform.");
  return platform;
}

function findDevice(devices: LocalDevice[], id: string): LocalDevice {
  const target = devices.find((device) => device.id === id);
  if (!target) throw new LocalDeviceError("That device is not in this vault.");
  return target;
}

/**
 * Register a device that has not opened this vault yet. It is listed as
 * awaiting its first unlock until that device claims it.
 */
export async function registerLocalDevice(
  tomb: string,
  input: { name: string; platform: string },
): Promise<LocalDevice[]> {
  const name = checkedName(input.name);
  const platform = checkedPlatform(input.platform);
  return mutateDevices(tomb, (devices) => {
    // One slot stays free for a browser that opens the vault unlisted.
    if (devices.length >= MAX_DEVICES - 1)
      throw new LocalDeviceError(
        `This vault already lists ${devices.length} devices. Remove one first.`,
      );
    return [
      ...devices,
      {
        id: crypto.randomUUID(),
        name,
        platform,
        createdAt: new Date().toISOString(),
        lastSeenAt: "",
      },
    ];
  });
}

/**
 * Change a device's name, and — while it has not opened the vault yet — the
 * platform it was registered with. A seen device's platform is what that
 * browser reported and is not edited.
 */
export async function updateLocalDevice(
  tomb: string,
  id: string,
  input: { name: string; platform?: string },
): Promise<LocalDevice[]> {
  const name = checkedName(input.name);
  return mutateDevices(tomb, (devices) => {
    const target = findDevice(devices, id);
    const platform =
      input.platform !== undefined && isPendingDevice(target)
        ? checkedPlatform(input.platform)
        : target.platform;
    return devices.map((device) =>
      device.id === id ? { ...device, name, platform } : device,
    );
  });
}

/**
 * This browser is the device registered as `id`: the registration takes this
 * browser's id and platform and is marked seen, and the record this browser
 * made for itself on unlock is folded into it.
 */
export async function claimLocalDevice(
  tomb: string,
  id: string,
): Promise<LocalDevice[]> {
  const mine = thisDeviceId();
  return mutateDevices(tomb, (devices) => {
    if (!isPendingDevice(findDevice(devices, id)))
      throw new LocalDeviceError("That device has already opened this vault.");
    const now = new Date().toISOString();
    return devices
      .filter((device) => device.id !== mine)
      .map((device) =>
        device.id === id
          ? {
              ...device,
              id: mine,
              platform: describePlatform(),
              lastSeenAt: now,
            }
          : device,
      );
  });
}

export async function removeLocalDevice(
  tomb: string,
  id: string,
): Promise<LocalDevice[]> {
  if (id === thisDeviceId())
    throw new LocalDeviceError("You cannot remove the device you are on.");
  return mutateDevices(tomb, (devices) =>
    devices.filter((device) => device.id !== id),
  );
}
