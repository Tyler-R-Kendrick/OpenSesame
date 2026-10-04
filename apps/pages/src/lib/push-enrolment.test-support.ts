import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { vi } from "vitest";
import { pushSeams } from "./push-enrolment.js";

/** The fakes the enrolment and withdrawal suites share. */

export const fetchFn = vi.fn();

const defaults = { ...pushSeams };

export const ENROL = { baseUrl: "https://id.example", accessToken: "t" };
export const KEY_BYTES = [112, 117, 98, 108, 105, 99, 107, 101, 121]; // "publickey"

/** Call from `beforeEach`: a browser that can push, a world with no waiting. */
export function installSeams(): void {
  fetchFn.mockReset();
  Object.assign(pushSeams, {
    fetchFn,
    pushApiAvailable: () => true,
    requestPermission: async () => "granted",
    readyWaitMs: 20,
    pushWorkerWaitMs: 50,
    pause: async () => undefined,
  });
}

/** Call from `afterEach`. */
export function restoreSeams(): void {
  Object.assign(pushSeams, defaults);
}

export function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type FakeSubscription = {
  endpoint: string;
  options?: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => BoundaryValue;
  unsubscribe: ReturnType<typeof vi.fn>;
};

export function subscription(key: readonly number[] | null = KEY_BYTES) {
  const made: FakeSubscription = {
    endpoint: "https://push.example/endpoint/abc",
    options: {
      applicationServerKey: key ? new Uint8Array(key).buffer : null,
    },
    toJSON: () => ({
      endpoint: "https://push.example/endpoint/abc",
      keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  return made;
}

export function worker(held: FakeSubscription | null, subscribe = vi.fn()) {
  const getSubscription = vi.fn(async () => held);
  const registration = { pushManager: { getSubscription, subscribe } };
  Object.assign(pushSeams, {
    serviceWorkerContainer: () =>
      overlapCast({ ready: Promise.resolve(registration) }),
  });
  return { getSubscription, subscribe, registration };
}

export const keyReply = () => json({ publicKey: "cHVibGlja2V5" });
export const recorded = () =>
  json({ id: "push_1", createdAt: "2026-01-01T00:00:00.000Z" });
