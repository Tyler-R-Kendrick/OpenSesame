import { accountSeams } from "@opensesame/app-core/lib/account.js";
import { mintGuestSessionPerson } from "@opensesame/app-core/lib/local-guest.js";
import { GUEST_TOMB, PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnlockUserMenu, unlockAccountLabel } from "./UnlockUserMenu.js";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

const originalAccount = { ...accountSeams };

afterEach(() => {
  cleanup();
  Object.assign(accountSeams, originalAccount);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("unlockAccountLabel", () => {
  it("names the guest session when the guest vault is unlocking", () => {
    const guest = mintGuestSessionPerson();
    expect(
      unlockAccountLabel(
        GUEST_TOMB,
        {
          name: "First Claimer",
          detail: "via shoo.dev",
          providerId: "google",
          guest: false,
        },
        "guest",
      ),
    ).toBe(guest.name);
  });

  it("names the federated claimer on the personal vault", () => {
    expect(
      unlockAccountLabel(
        PERSONAL_TOMB,
        {
          name: "First Claimer",
          detail: "via shoo.dev",
          providerId: "google",
          guest: false,
        },
        "personal",
      ),
    ).toBe("First Claimer");
  });

  it("does not show a provisional guest principal on the personal vault", () => {
    mintGuestSessionPerson();
    expect(
      unlockAccountLabel(
        PERSONAL_TOMB,
        {
          name: "guest-1",
          detail: "provisional",
          providerId: null,
          guest: true,
        },
        "personal",
      ),
    ).toBe("personal");
  });
});

describe("UnlockUserMenu", () => {
  it("selects guest after a guest lock even when a claimer session remains", () => {
    const guest = mintGuestSessionPerson();
    accountSeams.describeAccount = () => ({
      name: "First Claimer",
      detail: "via shoo.dev",
      providerId: "google",
      guest: false,
    });
    render(
      <UnlockUserMenu
        currentVaultId={GUEST_TOMB}
        signingIn={false}
        onSignIn={() => {}}
        onUnlock={() => {}}
        onPickVault={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Signed in as ${guest.name}` }),
    ).toBeTruthy();
  });
});
