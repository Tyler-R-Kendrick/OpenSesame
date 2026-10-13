/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { sessionStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { kvDelete, kvGet } from "./kv.js";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_KEY,
  GUEST_PERSON_NAME,
  GUEST_ORDINAL_KEY as ORDINAL_KEY,
  clearGuestSessionPerson,
  guestSessionPerson,
  guestSessionPersonLocked,
  guestVaultLabel,
  isGuestPersonEntry,
  mintGuestSessionPerson,
  mintGuestSessionPersonLocked,
  readGuestSessionPerson,
} from "./local-guest.js";

describe("local-guest principals", () => {
  beforeEach(() => {
    kvDelete(ORDINAL_KEY);
    kvDelete(GUEST_PERSON_KEY);
    clearGuestSessionPerson();
    try {
      sessionStorage.clear();
    } catch {
      /* node without localStorage-file */
    }
  });
  afterEach(() => {
    clearGuestSessionPerson();
    kvDelete(ORDINAL_KEY);
    kvDelete(GUEST_PERSON_KEY);
  });

  it("mints distinct guest-N slugs — never the legacy singleton", () => {
    const first = mintGuestSessionPerson();
    expect(first.name).toBe("guest-1");
    expect(first.id.startsWith("local_")).toBe(true);
    expect(first.id).toMatch(/^local_[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(GUEST_PERSON_ID);
    expect(first.name).not.toBe(GUEST_PERSON_NAME);
    expect(kvGet(GUEST_PERSON_KEY)).toContain("guest-1");

    const second = mintGuestSessionPerson();
    expect(second.name).toBe("guest-2");
    expect(second.id).not.toBe(first.id);
    expect(readGuestSessionPerson()).toEqual(second);
    expect(guestSessionPerson()).toEqual(second);
  });

  it("normalizes legacy Guest N labels to the guest-N slug", () => {
    sessionStore().setItem(
      "opensesame.guest.session-person",
      JSON.stringify({
        id: "local_00000000-0000-4000-8000-000000000099",
        name: "Guest 4",
      }),
    );
    expect(readGuestSessionPerson()?.name).toBe("guest-4");
    expect(guestVaultLabel()).toBe("guest-4");
  });

  it("reads the durable principal when sessionStorage is empty", () => {
    const minted = mintGuestSessionPerson();
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    expect(readGuestSessionPerson()).toEqual(minted);
  });

  it("classifies legacy and guest-N entries as guests", () => {
    expect(
      isGuestPersonEntry({
        id: GUEST_PERSON_ID,
        kind: "person",
        name: GUEST_PERSON_NAME,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isGuestPersonEntry({
        id: "local_guest_abc",
        kind: "person",
        name: "guest-3",
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isGuestPersonEntry({
        id: "local_owner",
        kind: "person",
        name: "Ada",
        enabled: true,
      }),
    ).toBe(false);
  });
});

type Granted<T> = (lock: Lock | null) => Promise<T>;

describe("cross-tab guest ordinal minting", () => {
  const durableFiles = new Map<string, string>();
  const fakeDirectory = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!durableFiles.has(name) && !options?.create) {
        throw new DOMException("No such file", "NotFoundError");
      }
      return {
        getFile: async () => {
          const text = durableFiles.get(name);
          if (text === undefined) {
            throw new DOMException("No such file", "NotFoundError");
          }
          return { size: text.length, text: async () => text };
        },
        createWritable: async () => ({
          write: async (value: string) => {
            durableFiles.set(name, value);
          },
          close: async () => {},
        }),
      };
    },
  };
  let lockChain: Promise<unknown> = Promise.resolve();
  function request<T>(name: string, action: Granted<T>): Promise<T>;
  function request<T>(
    name: string,
    options: LockOptions,
    action: Granted<T>,
  ): Promise<T>;
  function request<T>(
    _name: string,
    ...rest: [Granted<T>] | [LockOptions, Granted<T>]
  ): Promise<T> {
    const action = rest.length === 1 ? rest[0] : rest[1];
    const run = lockChain.then(() => action(null));
    lockChain = run.catch(() => undefined);
    return run;
  }
  const locks = { request };

  beforeEach(() => {
    durableFiles.clear();
    lockChain = Promise.resolve();
    configureHost(
      createTestHost({
        locks,
        originFiles: async () => overlapCast(fakeDirectory),
      }),
    );
    kvDelete(ORDINAL_KEY);
    kvDelete(GUEST_PERSON_KEY);
    clearGuestSessionPerson();
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => {
    configureHost(createTestHost());
    clearGuestSessionPerson();
    kvDelete(ORDINAL_KEY);
    kvDelete(GUEST_PERSON_KEY);
  });

  it("a tab with a stale in-memory ordinal mints the next durable one", async () => {
    const tabA = await mintGuestSessionPersonLocked();
    expect(tabA.name).toBe("guest-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    kvDelete(ORDINAL_KEY);
    expect(kvGet(ORDINAL_KEY)).toBeNull();

    const tabB = await mintGuestSessionPersonLocked();
    expect(tabB.name).toBe("guest-2");
    expect(tabB.id).not.toBe(tabA.id);
  });

  it("falls back to the sync mint where Web Locks are unavailable", async () => {
    configureHost(createTestHost());
    const person = await mintGuestSessionPersonLocked();
    expect(person.name).toBe("guest-1");
  });

  it("resume-or-mint under the lock never duplicates a slug across tabs", async () => {
    const tabA = await guestSessionPersonLocked();
    expect(tabA.name).toBe("guest-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    kvDelete(ORDINAL_KEY);
    kvDelete(GUEST_PERSON_KEY);
    clearGuestSessionPerson();
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }

    const tabB = await guestSessionPersonLocked();
    expect(tabB.name).toBe("guest-2");
    expect(tabB.id).not.toBe(tabA.id);
  });

  it("resume-or-mint resumes the same principal within a tab", async () => {
    const [first, second] = await Promise.all([
      guestSessionPersonLocked(),
      guestSessionPersonLocked(),
    ]);
    expect(second).toEqual(first);
    expect(kvGet(ORDINAL_KEY)).toBe("1");
  });

  it("resume-or-mint falls back to the sync mint without Web Locks", async () => {
    configureHost(createTestHost());
    const person = await guestSessionPersonLocked();
    expect(person.name).toBe("guest-1");
    expect(await guestSessionPersonLocked()).toEqual(person);
  });
});
