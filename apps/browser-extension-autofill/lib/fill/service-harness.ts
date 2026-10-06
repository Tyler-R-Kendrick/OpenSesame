/**
 * A fake set of fill ports for the background tests: an active tab, a guard
 * that answers arms, a daemon, and the switched-on site list. Test-only.
 */
import type { DaemonClient } from "./daemon";
import type { FillPorts, RuntimeSender } from "./ports";
import { FILL_MESSAGE } from "./protocol";
import {
  type ArmMessage,
  type FillRequest,
  type GuardReply,
  fillRequest,
} from "./wire";

export const OWN = "abcdefghijklmnopabcdefghijklmnop";
export const BASE = `chrome-extension://${OWN}/`;
export const VALUE = "hunter2-but-longer";
export const TAB = { id: 7, url: "https://example.com/login" };

export interface Harness {
  ports: FillPorts;
  sent: ArmMessage[];
  stored: Map<string, string>;
  daemonCalls: string[];
  enabled: Set<string>;
  injected: number[];
  /** What the fake guard does with an arm; throwing means nobody listens. */
  guard: (message: ArmMessage) => GuardReply | Promise<GuardReply>;
}

export function harness(over: Partial<DaemonClient> = {}): Harness {
  const sent: ArmMessage[] = [];
  const stored = new Map<string, string>();
  const daemonCalls: string[] = [];
  const enabled = new Set<string>(["https://example.com"]);
  const injected: number[] = [];
  let n = 0;
  const h: Harness = {
    sent,
    stored,
    daemonCalls,
    enabled,
    injected,
    guard: () => ({ outcome: "filled" }),
    ports: {
      ownId: OWN,
      ownBase: BASE,
      activeTab: async () => TAB,
      inject: async (tabId) => {
        injected.push(tabId);
      },
      send: async (_tab, message) => {
        sent.push(message);
        return h.guard(message);
      },
      sites: {
        isEnabled: async (origin) => enabled.has(origin),
        enable: async (origin) => {
          enabled.add(origin);
          return "enabled";
        },
        disable: async (origin) => {
          enabled.delete(origin);
        },
      },
      daemon: {
        pair: async () => ({ state: "paired" }),
        match: async () => {
          daemonCalls.push("match");
          return ["Web/example.com"];
        },
        value: async (reference, origin, field) => {
          daemonCalls.push(`value ${reference} ${origin} ${field}`);
          return { value: VALUE, pepper: false };
        },
        ...over,
      },
      choices: {
        get: async (key) => stored.get(key),
        set: async (key, value) => {
          stored.set(key, value);
        },
      },
      now: () => 1_000_000,
      nonce: () => `n-${++n}`,
    },
  };
  return h;
}

export const guardSender = (
  over: Partial<RuntimeSender> = {},
): RuntimeSender => ({
  id: OWN,
  tab: { id: 7 },
  frameId: 0,
  origin: "https://example.com",
  url: "https://example.com/login",
  ...over,
});

export const popup: RuntimeSender = { id: OWN, url: `${BASE}popup.html` };

/** The fields a test request may carry beside its op. */
interface RequestBody {
  readonly op: string;
  readonly reference?: string;
  readonly origin?: string;
  readonly nonce?: string;
  readonly field?: string;
}

/** Decode a request exactly as the background's listener does. */
export function ask(body: RequestBody): FillRequest {
  return fillRequest.parse({ type: FILL_MESSAGE, ...body });
}
