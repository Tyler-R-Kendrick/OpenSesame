/**
 * The relay contract the deadman switch speaks (ADR 0209).
 *
 * A relay is an external, user-chosen service. The browser sends it a signed
 * arm record, signed heartbeats after each successful unlock, and a signed
 * disarm. The relay owns the wall clock and, when the heartbeat goes stale,
 * delivers a release event to the webhook named on the arm record. No item,
 * item name or release key is ever sent to the relay.
 *
 * The record's ECDSA P-256 public key travels with the arm request, so the
 * relay and the webhook can verify the arm record and every heartbeat without
 * sharing a secret.
 */

import { isLoopbackUrl } from "../urls.js";
import type { DeadmanState } from "./state.js";

const MAX_BODY_BYTES = 64_000;
const TIMEOUT_MS = 10_000;

export type RelayTarget = Readonly<{
  relayUrl: string;
  relayToken?: string;
}>;

export class DeadmanRelayError extends Error {
  readonly name = "DeadmanRelayError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type DeadmanHeartbeat = Readonly<{
  v: 1;
  type: "opensesame.deadman.heartbeat";
  id: string;
  at: number;
  sequence: number;
  signature: string;
}>;

function normalizeUrl(raw: string, allowQuery: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a complete relay URL.");
  }
  if (url.username || url.password || url.hash)
    throw new Error("A relay URL cannot carry credentials or a fragment.");
  if (!allowQuery && url.search)
    throw new Error("Put a relay token in its own field, not in the URL.");
  if (url.protocol !== "https:" && !isLoopbackUrl(url.href))
    throw new Error("Use an HTTPS relay URL, or a loopback development URL.");
  return url.href;
}

export function normalizeRelayUrl(raw: string): string {
  return normalizeUrl(raw, false);
}

export function normalizeWebhookUrl(raw: string): string {
  return normalizeUrl(raw, true);
}

async function post(target: RelayTarget, payload: unknown): Promise<void> {
  const relayUrl = normalizeRelayUrl(target.relayUrl);
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    throw new Error("The relay payload is too large.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(relayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(target.relayToken
          ? { authorization: `Bearer ${target.relayToken}` }
          : undefined),
      },
      body,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new DeadmanRelayError("The relay did not answer in time.");
    throw new DeadmanRelayError("The relay could not be reached.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new DeadmanRelayError(
      `The relay refused the request (${response.status}).`,
      response.status,
    );
  }
}

export async function sendArm(
  target: RelayTarget,
  state: DeadmanState,
  webhookUrl: string,
): Promise<void> {
  await post(target, {
    v: 1,
    type: "opensesame.deadman.arm",
    state,
    webhookUrl: normalizeWebhookUrl(webhookUrl),
  });
}

export async function sendHeartbeat(
  target: RelayTarget,
  heartbeat: DeadmanHeartbeat,
): Promise<void> {
  await post(target, heartbeat);
}

export type DeadmanDisarm = Readonly<{
  v: 1;
  type: "opensesame.deadman.disarm";
  id: string;
  at: number;
  signature: string;
}>;

export async function sendDisarm(
  target: RelayTarget,
  disarm: DeadmanDisarm,
): Promise<void> {
  await post(target, disarm);
}
