/**
 * What the device panel says about a tailnet device, and the checks a form
 * runs before anything is sent (ADR 0165). The checks mirror the daemon's
 * (`crates/tailnet-admin/src/validate.rs`), which runs them again: these
 * only spare a round trip and say what is wrong where it was typed.
 */

import type { TailnetDevice, TailnetKey } from "./wire.js";

/** `0.0.0.0/0` and `::/0`: a device advertising both offers to be an exit node. */
export const EXIT_ROUTES: readonly string[] = ["0.0.0.0/0", "::/0"];
/** A key that expires within this is called out before it does. */
export const EXPIRING_MS = 14 * 24 * 3600 * 1000;

export type MarkTone = "ok" | "warn" | "err" | "idle";
export type DeviceMark = Readonly<{ tone: MarkTone; label: string }>;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 hours ago", "in 5 days": the nearest whole unit. */
export function relativeTo(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  const steps: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return rtf.format(value, unit);
    value = Math.round(value / size);
  }
  return null;
}

export function offersExitNode(device: TailnetDevice): boolean {
  return EXIT_ROUTES.every((r) => device.advertisedRoutes.includes(r));
}

export function isExitNode(device: TailnetDevice): boolean {
  return EXIT_ROUTES.every((r) => device.enabledRoutes.includes(r));
}

/** Advertised subnet routes, exit routes aside. */
export function subnetRoutes(device: TailnetDevice): readonly string[] {
  return device.advertisedRoutes.filter((r) => !EXIT_ROUTES.includes(r));
}

/** Advertised routes an admin has not approved yet, exit routes counted once. */
export function waitingRoutes(device: TailnetDevice): number {
  const subnets = subnetRoutes(device).filter(
    (r) => !device.enabledRoutes.includes(r),
  ).length;
  return subnets + (offersExitNode(device) && !isExitNode(device) ? 1 : 0);
}

export function keyExpired(device: TailnetDevice, now: number): boolean {
  if (device.keyExpiryDisabled || !device.expires) return false;
  const at = Date.parse(device.expires);
  return !Number.isNaN(at) && at <= now;
}

export function keyExpiring(device: TailnetDevice, now: number): boolean {
  if (device.keyExpiryDisabled || !device.expires) return false;
  const at = Date.parse(device.expires);
  return !Number.isNaN(at) && at > now && at - now <= EXPIRING_MS;
}

function presence(device: TailnetDevice, now: number): DeviceMark {
  if (device.connected) return { tone: "ok", label: "Online" };
  const seen = relativeTo(device.lastSeen, now);
  return {
    tone: "idle",
    label: seen ? `Offline, last seen ${seen}` : "Never seen",
  };
}

/** Every fact about a device worth a mark, worst first. */
export function deviceMarks(
  device: TailnetDevice,
  now: number,
): readonly DeviceMark[] {
  const marks: DeviceMark[] = [];
  if (device.multipleConnections)
    marks.push({
      tone: "err",
      label: "Several machines share this device's key",
    });
  if (device.tailnetLockError)
    marks.push({
      tone: "err",
      label: `Tailnet lock: ${device.tailnetLockError}`,
    });
  if (keyExpired(device, now))
    marks.push({ tone: "err", label: "Key expired" });
  if (!device.authorized)
    marks.push({ tone: "warn", label: "Waiting for approval" });
  if (keyExpiring(device, now))
    marks.push({
      tone: "warn",
      label: `Key expires ${relativeTo(device.expires, now)}`,
    });
  const waiting = waitingRoutes(device);
  if (waiting > 0)
    marks.push({
      tone: "warn",
      label:
        waiting === 1
          ? "1 route waiting for approval"
          : `${waiting} routes waiting for approval`,
    });
  if (device.updateAvailable)
    marks.push({ tone: "warn", label: "Update available" });
  marks.push(presence(device, now));
  return marks;
}

/** Whether a device needs someone: approval, a key, routes, a conflict. */
export function needsAttention(device: TailnetDevice, now: number): boolean {
  return deviceMarks(device, now).some(
    (m) => m.tone === "err" || m.tone === "warn",
  );
}

export type DeviceFilter = "all" | "attention" | "online" | "offline";

export const DEVICE_FILTERS: ReadonlyArray<{
  id: DeviceFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "online", label: "Online" },
  { id: "offline", label: "Offline" },
];

/** The short name a row leads with: the first label of the MagicDNS name. */
export function shortName(device: TailnetDevice): string {
  return device.name.split(".")[0] || device.hostname || device.id;
}

function matches(device: TailnetDevice, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    shortName(device),
    device.hostname,
    device.user,
    device.os,
    ...device.tags,
    ...device.addresses,
  ].some((field) => field.toLowerCase().includes(q));
}

/** The devices a filter and a search keep: waiting for approval first, then by name. */
export function visibleDevices(
  devices: readonly TailnetDevice[],
  filter: DeviceFilter,
  query: string,
  now: number,
): readonly TailnetDevice[] {
  const kept = devices.filter((device) => {
    if (!matches(device, query)) return false;
    if (filter === "attention") return needsAttention(device, now);
    if (filter === "online") return device.connected;
    if (filter === "offline") return !device.connected;
    return true;
  });
  return [...kept].sort(
    (a, b) =>
      Number(a.authorized) - Number(b.authorized) ||
      shortName(a).localeCompare(shortName(b)),
  );
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A machine name: one lowercase label, or empty to reset it to the hostname. */
export function validName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "" || LABEL.test(trimmed);
}

/** Tags typed as words (`web ci` or `tag:web, tag:ci`), or null when one is not a tag. */
export function parseTags(text: string): readonly string[] | null {
  const words = text.split(/[\s,]+/).filter(Boolean);
  const tags: string[] = [];
  for (const word of words) {
    const tag = word.startsWith("tag:") ? word : `tag:${word}`;
    const rest = tag.slice(4);
    if (!LABEL.test(rest) || !/^[a-z]/.test(rest)) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length > 50 ? null : tags.sort();
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** An IPv4 prefix with no host bits set; IPv6 is left to the daemon to judge. */
export function validRoute(route: string): boolean {
  const trimmed = route.trim();
  if (trimmed.includes(":")) return /^[0-9a-f:]+\/\d{1,3}$/i.test(trimmed);
  const parts = V4.exec(trimmed);
  if (!parts) return false;
  const octets = parts.slice(1, 5).map(Number);
  const length = Number(parts[5]);
  if (octets.some((o) => o > 255) || length > 32) return false;
  const value = octets.reduce((acc, o) => acc * 256 + o, 0);
  const host = 2 ** (32 - length);
  return value % host === 0;
}

/** A key description Tailscale accepts. */
export function validDescription(text: string): boolean {
  return /^[A-Za-z0-9 -]{0,50}$/.test(text.trim());
}

/** How long a new key lasts, as offered. */
export const KEY_LIFETIMES: ReadonlyArray<{ seconds: number; label: string }> =
  [
    { seconds: 3600, label: "1 hour" },
    { seconds: 86_400, label: "1 day" },
    { seconds: 7 * 86_400, label: "7 days" },
    { seconds: 30 * 86_400, label: "30 days" },
    { seconds: 90 * 86_400, label: "90 days" },
  ];

/** The command that joins a machine with a minted key. */
export function joinCommand(key: string): string {
  return `tailscale up --auth-key=${key}`;
}

/** What a key row says about the key, beside its description. */
export function keyFacts(key: TailnetKey): string {
  const facts = [
    key.reusable ? "reusable" : "one use",
    key.ephemeral ? "ephemeral" : null,
    key.preauthorized ? "pre-approved" : null,
    ...key.tags,
  ];
  return facts.filter(Boolean).join(" · ");
}
