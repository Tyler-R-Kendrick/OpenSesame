/**
 * Devices that have opened this vault — a machine inventory, not authenticators.
 *
 * Tailscale lists nodes; Entra lists registered devices. This is the same
 * kind of record: a browser (or PWA) that unlocked the tomb, named, last
 * seen, removable except for the one you are on. Passkeys stay on People.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvRefresh, kvSet } from "./kv.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VaultCorruptError } from "./vault/crypto.js";
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
  lastSeenAt: string;
};

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

export function describePlatform(ua = navigator.userAgent): string {
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X/i.test(ua)) return "macOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

export function defaultDeviceName(ua = navigator.userAgent): string {
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

export async function readLocalDevices(tomb: string): Promise<LocalDevice[]> {
  return (await readFileOrEmpty(tomb)).devices;
}

export async function ensureThisDevice(tomb: string): Promise<LocalDevice[]> {
  const current = await readFileOrEmpty(tomb);
  const id = thisDeviceId();
  if (current.devices.some((device) => device.id === id))
    return current.devices;
  const now = new Date().toISOString();
  return writeFileRecord(tomb, {
    version: 1,
    revision: current.revision + 1,
    devices: [
      ...current.devices,
      {
        id,
        name: defaultDeviceName(),
        platform: describePlatform(),
        createdAt: now,
        lastSeenAt: now,
      },
    ],
  });
}

export async function touchThisDevice(tomb: string): Promise<LocalDevice[]> {
  const current = await readFileOrEmpty(tomb);
  const id = thisDeviceId();
  const now = new Date().toISOString();
  if (current.devices.some((device) => device.id === id)) {
    return writeFileRecord(tomb, {
      version: 1,
      revision: current.revision + 1,
      devices: current.devices.map((device) =>
        device.id === id ? { ...device, lastSeenAt: now } : device,
      ),
    });
  }
  return writeFileRecord(tomb, {
    version: 1,
    revision: current.revision + 1,
    devices: [
      ...current.devices,
      {
        id,
        name: defaultDeviceName(),
        platform: describePlatform(),
        createdAt: now,
        lastSeenAt: now,
      },
    ],
  });
}

export async function renameLocalDevice(
  tomb: string,
  id: string,
  name: string,
): Promise<LocalDevice[]> {
  const trimmed = name.trim();
  if (!validName(trimmed))
    throw new LocalDeviceError("Use a name of 1–128 characters.");
  const current = await readFileOrEmpty(tomb);
  if (!current.devices.some((device) => device.id === id))
    throw new LocalDeviceError("That device is not in this vault.");
  return writeFileRecord(tomb, {
    version: 1,
    revision: current.revision + 1,
    devices: current.devices.map((device) =>
      device.id === id ? { ...device, name: trimmed } : device,
    ),
  });
}

export async function removeLocalDevice(
  tomb: string,
  id: string,
): Promise<LocalDevice[]> {
  if (id === thisDeviceId())
    throw new LocalDeviceError("You cannot remove the device you are on.");
  const current = await readFileOrEmpty(tomb);
  return writeFileRecord(tomb, {
    version: 1,
    revision: current.revision + 1,
    devices: current.devices.filter((device) => device.id !== id),
  });
}
