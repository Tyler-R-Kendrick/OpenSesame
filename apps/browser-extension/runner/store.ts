/**
 * Everything the runner keeps rests sealed (ADR 0149).
 *
 * `SealedKv` is the one place the runner touches `chrome.storage.local`. A
 * value is sealed under the device's non-extractable key and bound to its
 * storage name before it is written; with no key to seal under nothing is
 * written ("with no durable key nothing reaches disk; do not add a plaintext
 * fallback"). A value found in the clear is never read: it is not trusted and
 * it is removed, because a stored credential is only ever what this device
 * sealed.
 */
import { assertNotDecoySession } from "@opensesame/app-core/browser/security/guard.js";
import {
  isSealedForRest,
  openFromRest,
  sealForRest,
} from "@opensesame/browser-at-rest";
import {
  type BoundaryObject,
  type BoundaryValue,
  isString,
} from "@opensesame/os-domain";

import type { OriginalOwner } from "./original-owner";
import { ownedIO } from "./worker-authority";

export const STORE = "chrome.storage.local";
const PREFIX = "runner.";

/** The extension's string storage, as a port. */
export interface RawStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Seal {
  seal(store: string, name: string, text: string): Promise<string | null>;
  open(store: string, name: string, value: string): Promise<string | null>;
}

/** The device's at-rest key, through `@opensesame/browser-at-rest`. */
export const deviceSeal: Seal = {
  seal: sealForRest,
  open: openFromRest,
};

/** No key can be kept here, so nothing is written. */
export class AtRestUnavailable extends Error {
  constructor() {
    super("at_rest_unavailable");
    this.name = "AtRestUnavailable";
  }
}

export class SealedKv {
  constructor(
    private readonly raw: RawStore,
    private readonly sealer: Seal = deviceSeal,
    private readonly authorize: () => Promise<void> = async () => undefined,
  ) {}

  withAuthority(owner: OriginalOwner): SealedKv {
    const raw: RawStore = {
      get: (key) => ownedIO(owner, () => this.raw.get(key)),
      set: (key, value) => ownedIO(owner, () => this.raw.set(key, value)),
      remove: (key) => ownedIO(owner, () => this.raw.remove(key)),
      keys: () => ownedIO(owner, () => this.raw.keys()),
    };
    return new SealedKv(raw, this.sealer, async () => {
      await this.authorize();
      owner.check();
      await owner.authorize();
      owner.check();
    });
  }
  /** The plaintext under `name`, or null when absent, in the clear, or unopenable. */
  async get(name: string): Promise<string | null> {
    assertNotDecoySession();
    await this.authorize();
    const key = PREFIX + name;
    const value = await this.raw.get(key);
    if (value === undefined) return null;
    if (!isSealedForRest(value)) {
      await this.raw.remove(key);
      return null;
    }
    const opened = await this.sealer.open(STORE, key, value);
    assertNotDecoySession();
    await this.authorize();
    return opened;
  }

  async set(name: string, text: string): Promise<void> {
    assertNotDecoySession();
    await this.authorize();
    const key = PREFIX + name;
    const sealed = await this.sealer.seal(STORE, key, text);
    if (sealed === null) throw new AtRestUnavailable();
    assertNotDecoySession();
    await this.authorize();
    await this.raw.set(key, sealed);
  }

  async remove(name: string): Promise<void> {
    assertNotDecoySession();
    await this.authorize();
    await this.raw.remove(PREFIX + name);
  }

  /** Names (never values) under `prefix`. */
  async names(prefix: string): Promise<string[]> {
    assertNotDecoySession();
    await this.authorize();
    const want = PREFIX + prefix;
    return (await this.raw.keys())
      .filter((key) => key.startsWith(want))
      .map((key) => key.slice(PREFIX.length));
  }

  /** The JSON under `name`, to be decoded by the caller; null when there is none. */
  async getJson(name: string): Promise<BoundaryValue> {
    const text = await this.get(name);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async setJson<T>(name: string, value: T): Promise<void> {
    await this.set(name, JSON.stringify(value));
  }
}

/** `chrome.storage.local`, narrowed to the strings the runner writes. */
export function browserStore(): RawStore {
  const area = browser.storage.local;
  return {
    async get(key) {
      const found = await area.get<BoundaryObject>(key);
      const value = found[key];
      return isString(value) ? value : undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
    async keys() {
      return Object.keys(await area.get(null));
    },
  };
}
