/** @vitest-environment jsdom */
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { VaultWelcome } from "./VaultSection.js";
import { makeAccount } from "./vault/section-items.test-support.js";

registerLegacyItemKinds();

const items: ReturnType<typeof makeAccount>[] = [];
const vault = { current: { items } };
const original = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

afterEach(cleanup);
afterAll(() => {
  Object.assign(vaultHooksSeams, original);
});

function welcome(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <VaultWelcome />
    </MemoryRouter>,
  );
  return document.querySelector(".buffer__line")?.textContent;
}

/**
 * The buffer beside the list said "nothing sealed yet" inside Trash and
 * every empty filter — Certificates with a login beside it included.
 */
describe("the buffer states what the list beside it holds", () => {
  it("names the filter the list is showing", () => {
    vault.current = { items: [makeAccount()] };
    expect(welcome("/vault?f=certificate")).toBe("no certificates yet");
    cleanup();
    expect(welcome("/vault?f=login")).toBe("1 item · accounts");
  });

  it("says the trash is empty rather than that nothing is sealed", () => {
    vault.current = { items: [makeAccount()] };
    expect(welcome("/vault?f=trash")).toBe("trash is empty");
    expect(screen.queryByText("nothing sealed yet")).toBeNull();
    expect(document.querySelector(".buffer__keys")?.textContent).toBe(
      "r restore · X delete · ? keys",
    );
  });

  it("hands a populated trash restore and delete", () => {
    vault.current = {
      items: [makeAccount({ deletedAt: "2026-08-10T00:00:00Z" })],
    };
    expect(welcome("/vault?f=trash")).toBe("1 item · trash");
    expect(document.querySelector(".buffer__keys-keys")?.textContent).toBe(
      "enter open · r restore · X delete · / search · ? keys",
    );
    expect(document.querySelector(".buffer__keys-touch")?.textContent).toBe(
      "hold or swipe a row to restore or delete",
    );
  });
});
