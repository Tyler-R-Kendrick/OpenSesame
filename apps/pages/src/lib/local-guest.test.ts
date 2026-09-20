/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "./kv.js";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_KEY,
  GUEST_PERSON_NAME,
  GUEST_ORDINAL_KEY as ORDINAL_KEY,
  clearGuestSessionPerson,
  guestSessionPerson,
  guestVaultLabel,
  isGuestPersonEntry,
  mintGuestSessionPerson,
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
    sessionStorage.setItem(
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
