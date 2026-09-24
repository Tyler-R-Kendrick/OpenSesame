/**
 * Which invites this device has already looked up (ADR 0136).
 *
 * Presenting spends an offer's one presentation; a second present burns it
 * and revokes whatever was minted from it. The tab's stash (`stash.ts`)
 * keeps the looked-up offer so this tab never asks twice — but a second tab,
 * a reopened email link, or a lookup whose answer never arrived would. This
 * marker closes those: shared by every tab on the origin, it holds a digest
 * of the bearer (never the bearer) and when the offer ends, and a marked
 * invite is not presented again from this device.
 *
 * It is written *before* the request goes out: an answer lost to a closed
 * screen or a dropped connection may still have spent the offer, and asking
 * again then is the one thing that cancels it for everybody.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "@opensesame/os-domain";
import { maybeLocalStore } from "../../ports.js";

const KEY = "join.presented.v1";
const MAX_ENTRIES = 64;
/** The Host's ceiling on an offer's life. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function digest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`opensesame:join-presented:v1:${token}`),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function read(now: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = maybeLocalStore()?.getItem(KEY);
    if (!raw) return out;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return out;
    for (const [key, until] of Object.entries(parsed)) {
      if (/^[0-9a-f]{64}$/.test(key) && isNumber(until) && until > now)
        out.set(key, until);
    }
  } catch {
    // Unreadable: treat as empty rather than refuse every invite.
  }
  return out;
}

function write(entries: Map<string, number>): void {
  const kept = [...entries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES);
  try {
    maybeLocalStore()?.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage refused: the tab's stash still guards this tab.
  }
}

/** Has this device already sent this invite to be looked up? */
export async function wasPresented(
  token: string,
  now = Date.now(),
): Promise<boolean> {
  return read(now).has(await digest(token));
}

/** Mark it, until `until` (the offer's end) or the Host's ceiling. */
export async function markPresented(
  token: string,
  until: number | null,
  now = Date.now(),
): Promise<void> {
  const entries = read(now);
  const ceiling = now + MAX_AGE_MS;
  entries.set(await digest(token), Math.min(until ?? ceiling, ceiling));
  write(entries);
}

/** Forget it: the lookup provably never reached the offer, or it is dead. */
export async function forgetPresented(
  token: string,
  now = Date.now(),
): Promise<void> {
  const entries = read(now);
  entries.delete(await digest(token));
  write(entries);
}
